import { systemPreferences, dialog, desktopCapturer } from 'electron'

export interface PermissionStatus {
  microphone: boolean
  accessibility: boolean
  screen: boolean
}

export function checkPermissions(): PermissionStatus {
  const microphone =
    systemPreferences.getMediaAccessStatus('microphone') === 'granted'
  const accessibility =
    systemPreferences.isTrustedAccessibilityClient(false)
  const screenStatus =
    systemPreferences.getMediaAccessStatus('screen') === 'granted'

  return { microphone, accessibility, screen: screenStatus }
}

export async function requestMicrophonePermission(): Promise<boolean> {
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true

  if (status === 'not-determined') {
    const granted = await systemPreferences.askForMediaAccess('microphone')
    return granted
  }

  // Status is 'denied' or 'restricted' - need to open System Preferences
  dialog.showMessageBox({
    type: 'warning',
    title: '需要麦克风权限',
    message: '乐多汪汪需要麦克风权限来录制语音。请在系统设置中允许乐多汪汪访问麦克风。',
    buttons: ['打开系统设置', '取消']
  }).then((result) => {
    if (result.response === 0) {
      const { shell } = require('electron')
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      )
    }
  })

  return false
}

export async function requestAccessibilityPermission(): Promise<boolean> {
  // 先检查是否已有权限
  const alreadyTrusted = systemPreferences.isTrustedAccessibilityClient(false)
  if (alreadyTrusted) return true

  // 没有权限，先显示提示对话框，等待用户确认
  await dialog.showMessageBox({
    type: 'warning',
    title: '需要辅助功能权限',
    message:
      '乐多汪汪需要辅助功能权限来模拟键盘输入。点击"确定"后将打开系统设置，请在左侧列表中找到并勾选"乐多汪汪"。',
    buttons: ['确定']
  })

  // 用户确认后，再触发系统权限设置页面
  const trusted = systemPreferences.isTrustedAccessibilityClient(true)
  return trusted
}

export async function requestScreenPermission(): Promise<boolean> {
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'granted') return true

  // 显示提示对话框
  const result = await dialog.showMessageBox({
    type: 'info',
    title: '需要屏幕录制权限',
    message: '乐多汪汪需要屏幕录制权限来截取屏幕内容，辅助语音识别文本的润色。',
    detail: '点击"打开系统设置"后，请在左侧列表中找到并勾选"乐多汪汪"，或点击"+"号手动添加。',
    buttons: ['打开系统设置', '取消']
  })

  if (result.response !== 0) return false

  // 打开系统设置并触发权限请求
  const { shell } = require('electron')
  shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  )

  // 触发系统权限请求，让应用在系统设置中显示
  try {
    await desktopCapturer.getSources({ types: ['screen'] })
  } catch {
    // 预期会失败，这只是为了让应用出现在权限列表中
  }

  return false
}
