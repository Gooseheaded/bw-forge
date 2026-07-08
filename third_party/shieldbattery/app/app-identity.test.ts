import { describe, expect, test } from 'vitest'
import {
  BW_FORGE_REPLAY_ENGINE_APP_ID,
  BW_FORGE_REPLAY_ENGINE_PRODUCT_NAME,
  resolveAppIdentity,
  usesExecutableNamedUserData,
} from './app-identity'

describe('resolveAppIdentity', () => {
  test('isolates the BW Forge replay engine from upstream ShieldBattery', () => {
    expect(resolveAppIdentity(BW_FORGE_REPLAY_ENGINE_PRODUCT_NAME)).toEqual({
      appId: BW_FORGE_REPLAY_ENGINE_APP_ID,
      autoUpdate: false,
      updateUrl: 'https://example.org/',
    })
  })

  test('preserves upstream production and development identities', () => {
    expect(resolveAppIdentity('ShieldBattery').appId).toBe('net.shieldbattery.client')
    expect(resolveAppIdentity('ShieldBattery-Local').appId).toBe(
      'net.shieldbattery.client.local',
    )
  })

  test('derives isolated user-data directories from packaged executable names', () => {
    expect(usesExecutableNamedUserData(BW_FORGE_REPLAY_ENGINE_PRODUCT_NAME)).toBe(true)
    expect(usesExecutableNamedUserData('ShieldBattery-Staging')).toBe(true)
    expect(usesExecutableNamedUserData('unrelated-app')).toBe(false)
  })
})
