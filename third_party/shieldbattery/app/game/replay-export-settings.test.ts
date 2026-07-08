import { describe, expect, test } from 'vitest'
import {
  applyReplayExportAudioSettings,
  replayExportAudioOverrides,
  replayExportDisablesAudio,
} from './replay-export-settings'

describe('replay export audio settings', () => {
  test('mutes unattended export by default without mutating source settings', () => {
    const source = { soundOn: true, soundVolume: 50, musicOn: true }
    const result = applyReplayExportAudioSettings(source, { enabled: true })

    expect(result).toMatchObject({
      soundOn: false,
      soundVolume: 0,
      musicOn: false,
      musicVolume: 0,
      backgroundSoundsOn: false,
    })
    expect(source).toEqual({ soundOn: true, soundVolume: 50, musicOn: true })
    expect(replayExportDisablesAudio({ enabled: true })).toBe(true)
  })

  test('preserves configured audio when suppression is explicitly disabled', () => {
    const config = { enabled: true, disableAudio: false }
    const source = { soundOn: true, soundVolume: 25 }

    expect(applyReplayExportAudioSettings(source, config)).toEqual(source)
    expect(replayExportAudioOverrides(config)).toEqual({})
  })
})
