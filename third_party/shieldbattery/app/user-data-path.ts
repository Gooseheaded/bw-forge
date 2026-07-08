import { app } from 'electron'
import isDev from 'electron-is-dev'
import path from 'path'
import { usesExecutableNamedUserData } from './app-identity'

let userDataPath = app.getPath('userData')
let initialized = isDev

export function getUserDataPath(): string {
  if (initialized) {
    return userDataPath
  }

  const exeName = path.basename(app.getPath('exe'), '.exe')
  if (usesExecutableNamedUserData(exeName)) {
    userDataPath = path.resolve(app.getPath('userData'), `../${exeName}`)
    app.setPath('userData', userDataPath)
  }

  initialized = true
  return userDataPath
}
