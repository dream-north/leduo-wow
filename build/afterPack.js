const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

exports.default = async function (context) {
  // 只处理 macOS 打包
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  const projectDir = context.packager.info.projectDir
  const entitlementsPath = path.join(projectDir, 'build', 'entitlements.mac.plist')

  // 从环境变量 LEDUO_WOW_IDENTITY 读取签名证书
  // 打包前设置：export LEDUO_WOW_IDENTITY="你的证书SHA-1指纹"
  const identity = process.env.LEDUO_WOW_IDENTITY || '-'

  console.log('\n📦 Re-signing app with entitlements before DMG creation...')
  console.log(`   App: ${appPath}`)
  console.log(`   Identity: ${identity === '-' ? 'ad-hoc' : identity}`)

  // 先给 SwiftKeyboardListener 添加执行权限并单独签名
  const swiftListenerPath = path.join(appPath, 'Contents', 'Resources', 'SwiftKeyboardListener')
  if (fs.existsSync(swiftListenerPath)) {
    console.log('\n   Signing SwiftKeyboardListener...')
    try {
      // 确保有执行权限
      fs.chmodSync(swiftListenerPath, 0o755)
      // 单独签名
      execSync(
        `codesign --force --sign "${identity}" --entitlements "${entitlementsPath}" "${swiftListenerPath}"`,
        { stdio: 'inherit' }
      )
      console.log('   ✓ SwiftKeyboardListener signed\n')
    } catch (error) {
      console.error('   ✗ SwiftKeyboardListener signing failed:', error.message)
      throw error
    }
  }

  try {
    execSync(
      `codesign --force --deep --sign "${identity}" --entitlements "${entitlementsPath}" "${appPath}"`,
      { stdio: 'inherit' }
    )
    console.log('✓ App signed successfully with entitlements\n')
  } catch (error) {
    console.error('✗ Signing failed:', error.message)
    throw error
  }
}
