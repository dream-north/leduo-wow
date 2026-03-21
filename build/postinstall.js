const { execSync } = require('child_process')
const { existsSync, rmSync } = require('fs')
const { join } = require('path')

function run(command) {
  execSync(command, {
    stdio: 'inherit'
  })
}

function canLoadRobotJs() {
  try {
    require('@jitsi/robotjs')
    return true
  } catch (error) {
    console.warn('[postinstall] @jitsi/robotjs is not ready:', error instanceof Error ? error.message : error)
    return false
  }
}

function pruneUnusedKeyListenerBinaries() {
  if (process.platform !== 'win32') {
    return
  }

  const packageDir = join(process.cwd(), 'node_modules', 'node-global-key-listener')
  if (!existsSync(packageDir)) {
    return
  }

  rmSync(packageDir, { force: true, recursive: true })
  console.log(`[postinstall] Removed unused package: ${packageDir}`)
}

pruneUnusedKeyListenerBinaries()

if (process.platform === 'win32' && canLoadRobotJs()) {
  console.log('[postinstall] Skipping electron-builder install-app-deps on Windows because @jitsi/robotjs already loads')
} else {
  run('electron-builder install-app-deps')
}

run('npm run build:native')
