export const BW_FORGE_REPLAY_ENGINE_PRODUCT_NAME = 'BW Forge Replay Engine'
export const BW_FORGE_REPLAY_ENGINE_APP_ID = 'com.bwforge.replayengine'

export interface AppIdentity {
  appId: string
  autoUpdate: boolean
  updateUrl: string
}

export function resolveAppIdentity(appName: string): AppIdentity {
  if (appName.toLowerCase() === BW_FORGE_REPLAY_ENGINE_PRODUCT_NAME.toLowerCase()) {
    return {
      appId: BW_FORGE_REPLAY_ENGINE_APP_ID,
      autoUpdate: false,
      updateUrl: 'https://example.org/',
    }
  }

  switch ((appName.split('-')[1] ?? '').toLowerCase()) {
    case 'local':
      return {
        appId: 'net.shieldbattery.client.local',
        autoUpdate: false,
        updateUrl: 'https://example.org/',
      }
    case 'staging':
      return {
        appId: 'net.shieldbattery.client.staging',
        autoUpdate: true,
        updateUrl: 'https://staging-cdn.shieldbattery.net/app/',
      }
    default:
      return {
        appId: 'net.shieldbattery.client',
        autoUpdate: true,
        updateUrl: 'https://cdn.shieldbattery.net/app/',
      }
  }
}

export function usesExecutableNamedUserData(executableName: string): boolean {
  const normalizedName = executableName.toLowerCase()
  return (
    normalizedName.startsWith('shieldbattery') ||
    normalizedName === BW_FORGE_REPLAY_ENGINE_PRODUCT_NAME.toLowerCase()
  )
}
