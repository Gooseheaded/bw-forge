export interface ReplayExportLaunchArgs {
  enabled: boolean
  targetMultiplier?: number
  disableRender?: boolean
  disableAudio?: boolean
}

export function parseReplayExportLaunchArgs(args: string[]): ReplayExportLaunchArgs {
  const enabled = args.includes('--replay-export')
  const speedValue = getLaunchArgValue(args, '--replay-export-speed')
  const disableRenderValue = getLaunchArgValue(args, '--replay-export-disable-render')
  const disableAudioValue = getLaunchArgValue(args, '--replay-export-disable-audio')
  const targetMultiplier = speedValue ? Number.parseInt(speedValue, 10) : undefined

  return {
    enabled,
    targetMultiplier:
      targetMultiplier !== undefined && Number.isFinite(targetMultiplier)
        ? targetMultiplier
        : undefined,
    disableRender:
      disableRenderValue === undefined
        ? undefined
        : !['0', 'false', 'no', 'off'].includes(disableRenderValue.toLowerCase()),
    disableAudio:
      disableAudioValue === undefined
        ? undefined
        : !['0', 'false', 'no', 'off'].includes(disableAudioValue.toLowerCase()),
  }
}

export function shouldFocusWindowForLaunchArgs(args: string[]): boolean {
  return !parseReplayExportLaunchArgs(args).enabled
}

function getLaunchArgValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === name) {
      return args[i + 1]
    }
    if (arg.startsWith(name + '=')) {
      return arg.slice(name.length + 1)
    }
  }

  return undefined
}
