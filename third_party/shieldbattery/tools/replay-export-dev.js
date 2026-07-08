const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const process = require('node:process')
const waitOn = require('wait-on')

const DEV_SERVER_URL = 'http://localhost:5566/dist/bundle.js'

async function main() {
  const args = process.argv.slice(2)
  if (!args.some(arg => arg.toLowerCase().endsWith('.rep'))) {
    console.error(
      'Usage: pnpm run replay-export -- <replay.rep> [--replay-export-speed 128] ' +
        '[--replay-export-disable-render 0|1] [--replay-export-disable-audio 0|1]',
    )
    process.exit(1)
  }

  const devServerRunning = await isDevServerRunning()
  const devServer = devServerRunning ? null : startDevServer()
  if (devServerRunning) {
    console.log('[replay-export] dev server already running')
  } else {
    console.log('[replay-export] starting dev server')
  }

  try {
    console.log('[replay-export] waiting for dev bundle')
    await waitOn({
      resources: [DEV_SERVER_URL],
      timeout: 120000,
      validateStatus: status => status >= 200 && status < 500,
    })
  } catch (err) {
    if (devServer) {
      stopProcess(devServer)
    }
    throw err
  }

  console.log('[replay-export] launching electron')
  const electron = spawnPnpm(['exec', 'electron', 'app', '--replay-export', ...args], {
    SB_HOT: '1',
  })

  const forwardSignal = signal => {
    electron.kill(signal)
    if (devServer) {
      stopProcess(devServer)
    }
  }

  process.on('SIGINT', forwardSignal)
  process.on('SIGTERM', forwardSignal)

  electron.on('exit', code => {
    process.off('SIGINT', forwardSignal)
    process.off('SIGTERM', forwardSignal)
    if (devServer) {
      stopProcess(devServer)
    }
    process.exit(code ?? 0)
  })
}

function startDevServer() {
  return spawnPnpm(['run', 'dev'])
}

async function isDevServerRunning() {
  try {
    await waitOn({
      resources: [DEV_SERVER_URL],
      timeout: 1000,
      validateStatus: status => status >= 200 && status < 500,
    })
    return true
  } catch (err) {
    return false
  }
}

function stopProcess(child) {
  if (!child.killed) {
    child.kill('SIGTERM')
  }
}

function repoRoot() {
  return process.cwd()
}

function resolvePnpmInvocation(env) {
  const npmExecPath = env.npm_execpath
  if (npmExecPath) {
    return {
      command: process.execPath,
      argsPrefix: [npmExecPath],
      label: `${process.execPath} ${npmExecPath}`,
    }
  }

  const candidates =
    process.platform === 'win32'
      ? [
          { command: 'pnpm.cmd', argsPrefix: [], label: 'pnpm.cmd' },
          { command: 'pnpm', argsPrefix: [], label: 'pnpm' },
          { command: 'corepack.cmd', argsPrefix: ['pnpm'], label: 'corepack.cmd pnpm' },
          { command: 'corepack', argsPrefix: ['pnpm'], label: 'corepack pnpm' },
        ]
      : [
          { command: 'pnpm', argsPrefix: [], label: 'pnpm' },
          { command: 'corepack', argsPrefix: ['pnpm'], label: 'corepack pnpm' },
        ]

  for (const candidate of candidates) {
    const resolvedCommand = resolveCommandOnPath(candidate.command, env)
    if (resolvedCommand) {
      const wrappedNodeInvocation = resolveNodeWrappedPnpmInvocation(resolvedCommand)
      if (wrappedNodeInvocation) {
        return wrappedNodeInvocation
      }
      return {
        ...candidate,
        command: resolvedCommand,
      }
    }
  }

  throw new Error(
    'Could not resolve pnpm executable. Tried pnpm, pnpm.cmd, and corepack fallbacks.',
  )
}

function resolveCommandOnPath(command, env) {
  if (path.isAbsolute(command) && fs.existsSync(command)) {
    return command
  }

  const pathValue = env.PATH || env.Path || env.path || ''
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean)
  const extensions =
    process.platform === 'win32'
      ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']

  const hasKnownExtension =
    process.platform === 'win32' &&
    extensions.some(ext => command.toLowerCase().endsWith(ext.toLowerCase()))

  for (const entry of pathEntries) {
    if (process.platform === 'win32') {
      const commandCandidates = hasKnownExtension
        ? [path.join(entry, command)]
        : [
            path.join(entry, command),
            ...extensions.map(ext => path.join(entry, `${command}${ext}`)),
          ]
      for (const candidatePath of commandCandidates) {
        if (fs.existsSync(candidatePath)) {
          return candidatePath
        }
      }
      continue
    }

    const candidatePath = path.join(entry, command)
    if (fs.existsSync(candidatePath)) {
      return candidatePath
    }
  }

  return undefined
}

function resolveNodeWrappedPnpmInvocation(commandPath) {
  const commandName = path.basename(commandPath).toLowerCase()
  if (commandName !== 'pnpm' && commandName !== 'pnpm.cmd' && commandName !== 'pnpm.bat') {
    return undefined
  }

  const pnpmScript = path.join(
    path.dirname(commandPath),
    'node_modules',
    'corepack',
    'dist',
    'pnpm.js',
  )
  if (!fs.existsSync(pnpmScript)) {
    return undefined
  }

  return {
    command: process.execPath,
    argsPrefix: [pnpmScript],
    label: `${process.execPath} ${pnpmScript}`,
  }
}

function spawnPnpm(args, extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
  }

  const invocation = resolvePnpmInvocation(env)
  console.log(`[replay-export] using package runner: ${invocation.label} (${invocation.command})`)
  const fullArgs = [...invocation.argsPrefix, ...args]
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(invocation.command)) {
    return spawn(invocation.command, fullArgs, {
      cwd: repoRoot(),
      stdio: 'inherit',
      env,
      shell: true,
    })
  }

  return spawn(invocation.command, fullArgs, {
    cwd: repoRoot(),
    stdio: 'inherit',
    env,
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
