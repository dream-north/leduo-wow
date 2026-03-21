const { execSync } = require('child_process')

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

if (process.platform === 'win32' && canLoadRobotJs()) {
  console.log('[postinstall] Skipping electron-builder install-app-deps on Windows because @jitsi/robotjs already loads')
} else {
  run('electron-builder install-app-deps')
}

run('npm run build:native')
