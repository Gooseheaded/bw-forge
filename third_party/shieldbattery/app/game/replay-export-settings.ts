import { ReplayExportConfig } from '../../common/games/game-launch-config'
import { ScrSettings } from '../../common/settings/local-settings'

const MUTED_REPLAY_EXPORT_SETTINGS: Readonly<Partial<ScrSettings>> = {
  musicOn: false,
  musicVolume: 0,
  soundOn: false,
  soundVolume: 0,
  unitSpeechOn: false,
  unitAcknowledgementsOn: false,
  backgroundSoundsOn: false,
  buildingSoundsOn: false,
  apmAlertSoundOn: false,
}

export function replayExportDisablesAudio(config?: ReplayExportConfig): boolean {
  return config?.enabled === true && config.disableAudio !== false
}

export function applyReplayExportAudioSettings(
  settings: Partial<ScrSettings>,
  config?: ReplayExportConfig,
): Partial<ScrSettings> {
  return replayExportDisablesAudio(config)
    ? { ...settings, ...MUTED_REPLAY_EXPORT_SETTINGS }
    : { ...settings }
}

export function replayExportAudioOverrides(
  config?: ReplayExportConfig,
): Readonly<Partial<ScrSettings>> {
  return replayExportDisablesAudio(config) ? MUTED_REPLAY_EXPORT_SETTINGS : {}
}
