const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const rootDir = __dirname

function buildMacHelper() {
  const swiftDir = path.join(rootDir, 'SwiftKeyboardListener')
  execFileSync('bash', ['build.sh'], {
    cwd: swiftDir,
    stdio: 'inherit'
  })
}

function buildWindowsHelper() {
  const sourcePath = path.join(rootDir, 'WinKeyServer', 'main.cpp')
  const outputDir = path.join(rootDir, 'WinKeyServer', 'build')
  const stableOutputPath = path.join(outputDir, 'WinKeyServer.exe')
  const versionedOutputPath = path.join(outputDir, `WinKeyServer-${Date.now()}.exe`)

  fs.mkdirSync(outputDir, { recursive: true })

  execFileSync('g++', [
    sourcePath,
    '-o',
    versionedOutputPath,
    '-static-libgcc',
    '-static-libstdc++'
  ], {
    stdio: 'inherit'
  })

  try {
    fs.copyFileSync(versionedOutputPath, stableOutputPath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code)
      if (['EACCES', 'EBUSY', 'EPERM'].includes(code)) {
        console.warn(`[native-keyboard-listener] ${path.basename(stableOutputPath)} is in use; keeping ${path.basename(versionedOutputPath)} as the newest build`)
        return
      }
    }

    throw error
  }
}

switch (process.platform) {
  case 'darwin':
    buildMacHelper()
    break
  case 'win32':
    buildWindowsHelper()
    break
  default:
    console.log(`[native-keyboard-listener] No native helper build for ${process.platform}`)
    break
}
