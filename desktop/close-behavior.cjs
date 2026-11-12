'use strict'

const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const configName = 'NewWorld-settings.json'
const modes = ['quit', 'background']

function configFile(appData) {
  return join(appData, configName)
}

function isMode(value) {
  return modes.includes(value)
}

function readBehavior(appData) {
  try {
    const parsed = JSON.parse(readFileSync(configFile(appData), 'utf8'))
    return isMode(parsed.closeBehavior) ? parsed.closeBehavior : 'quit'
  } catch {
    return 'quit'
  }
}

function writeBehavior(appData, mode) {
  if (!isMode(mode)) throw new Error('无效的关闭方式。')
  mkdirSync(appData, { recursive: true })
  writeFileSync(configFile(appData), `${JSON.stringify({ closeBehavior: mode })}\n`, 'utf8')
}

function closeAction(mode, { forceQuit = false } = {}) {
  if (forceQuit || mode !== 'background') return 'quit'
  return 'background'
}

module.exports = { configFile, modes, isMode, readBehavior, writeBehavior, closeAction }
