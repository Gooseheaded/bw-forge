import { describe, expect, test } from 'vitest'
import { parseReplayExportLaunchArgs, shouldFocusWindowForLaunchArgs } from './replay-export-launch'

describe('replay export launch arguments', () => {
  test('parses unattended export options', () => {
    expect(
      parseReplayExportLaunchArgs([
        '--replay-export',
        'example.rep',
        '--replay-export-speed=256',
        '--replay-export-disable-render',
        'false',
        '--replay-export-disable-audio',
        'true',
      ]),
    ).toEqual({
      enabled: true,
      targetMultiplier: 256,
      disableRender: false,
      disableAudio: true,
    })
  })

  test('does not focus a window for a forwarded replay-export invocation', () => {
    expect(shouldFocusWindowForLaunchArgs(['--replay-export', 'example.rep'])).toBe(false)
    expect(shouldFocusWindowForLaunchArgs(['example.rep'])).toBe(true)
  })
})
