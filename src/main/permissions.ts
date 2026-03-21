import { systemPreferences, dialog, desktopCapturer, shell } from 'electron'

export interface PermissionStatus {
  microphone: boolean
  accessibility: boolean
  screen: boolean
}

function isMac(): boolean {
  return process.platform === 'darwin'
}

function hasMediaPermission(kind: 'microphone' | 'screen'): boolean {
  if (!isMac() && kind === 'screen') {
    // Windows screen capture does not require a per-app permission gate in the same way.
    return true
  }

  return systemPreferences.getMediaAccessStatus(kind) === 'granted'
}

export function checkPermissions(): PermissionStatus {
  const microphone = hasMediaPermission('microphone')
  const accessibility = isMac() ? systemPreferences.isTrustedAccessibilityClient(false) : true
  const screen = hasMediaPermission('screen')
  return { microphone, accessibility, screen }
}

export async function requestMicrophonePermission(): Promise<boolean> {
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true

  if (status === 'not-determined') {
    return await systemPreferences.askForMediaAccess('microphone')
  }

  if (!isMac()) {
    return false
  }

  void dialog.showMessageBox({
    type: 'warning',
    title: '需要麦克风权限',
    message: '乐多汪汪需要麦克风权限来录制语音，请在系统设置中允许应用访问麦克风。',
    buttons: ['打开系统设置', '取消']
  }).then((result) => {
    if (result.response === 0) {
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
    }
  })

  return false
}

export async function requestAccessibilityPermission(): Promise<boolean> {
  if (!isMac()) {
    // Windows does not require macOS Accessibility permission.
    return true
  }

  const alreadyTrusted = systemPreferences.isTrustedAccessibilityClient(false)
  if (alreadyTrusted) return true

  await dialog.showMessageBox({
    type: 'warning',
    title: '需要辅助功能权限',
    message:
      '乐多汪汪需要辅助功能权限来使用全局快捷键和模拟键盘输入。点击“确定”后将打开系统设置，请在列表中勾选乐多汪汪。',
    buttons: ['确定']
  })

  return systemPreferences.isTrustedAccessibilityClient(true)
}

export async function requestScreenPermission(): Promise<boolean> {
  if (!isMac()) {
    return true
  }

  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'granted') return true

  const result = await dialog.showMessageBox({
    type: 'info',
    title: '需要屏幕录制权限',
    message: '乐多汪汪需要屏幕录制权限来截取屏幕内容，用于截图上下文能力。',
    detail: '点击“打开系统设置”后，请在左侧列表中允许乐多汪汪。',
    buttons: ['打开系统设置', '取消']
  })

  if (result.response !== 0) return false

  void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')

  try {
    await desktopCapturer.getSources({ types: ['screen'] })
  } catch {
    // Expected when permission is not granted yet; this call helps app appear in the list.
  }

  return false
}
