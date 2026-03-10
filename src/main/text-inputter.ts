import { clipboard } from 'electron'
import { InputMethod } from '../shared/types'

// robotjs runs CGEventPost in-process, so it uses the Electron app's
// Accessibility permission — no need for osascript which requires
// separate per-binary permission on macOS Sonoma+
let robot: { keyTap: (key: string, modifier: string | string[]) => void } | null = null
try {
  robot = require('@jitsi/robotjs')
  console.log('[TextInputter] robotjs loaded successfully')
} catch (err) {
  console.warn('[TextInputter] robotjs not available, will fall back to osascript:', err)
}

export class TextInputter {
  async input(text: string, method: InputMethod): Promise<void> {
    console.log(`[TextInputter] Inputting text via ${method}: "${text.substring(0, 50)}..."`)

    if (method === 'clipboard') {
      await this.inputViaClipboard(text)
    } else {
      await this.inputViaKeystroke(text)
    }
  }

  private async inputViaClipboard(text: string): Promise<void> {
    // Save current clipboard content
    const previousText = clipboard.readText()

    // Write new text to clipboard
    clipboard.writeText(text)

    // Verify clipboard was set correctly
    const verify = clipboard.readText()
    if (verify !== text) {
      console.error('[TextInputter] Clipboard write failed')
      throw new Error('Failed to write to clipboard')
    }
    console.log('[TextInputter] Clipboard set, sending Cmd+V...')

    // Simulate Cmd+V
    await this.simulatePaste()

    // Wait for paste to complete, then restore clipboard
    await this.delay(300)
    clipboard.writeText(previousText)
  }

  private async inputViaKeystroke(text: string): Promise<void> {
    // For CJK text or long text, use clipboard approach
    if (/[^\x00-\x7F]/.test(text) || text.length > 50) {
      console.log('[TextInputter] CJK or long text detected, falling back to clipboard paste')
      return this.inputViaClipboard(text)
    }

    if (robot) {
      for (const char of text) {
        robot.keyTap(char, [])
      }
    } else {
      // Fallback for ASCII text via osascript
      const escaped = text
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
      const { exec } = require('child_process')
      const { promisify } = require('util')
      const execAsync = promisify(exec)
      await execAsync(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`)
    }
  }

  private async simulatePaste(): Promise<void> {
    if (robot) {
      // In-process CGEvent — uses Electron's own Accessibility permission
      robot.keyTap('v', 'command')
      console.log('[TextInputter] Cmd+V sent via robotjs')
    } else {
      // Fallback: osascript (needs separate Accessibility permission for /usr/bin/osascript)
      console.warn('[TextInputter] Falling back to osascript for Cmd+V (may fail without permission)')
      const { exec } = require('child_process')
      const { promisify } = require('util')
      const execAsync = promisify(exec)
      try {
        await execAsync(`osascript -e 'tell application "System Events" to keystroke "v" using {command down}'`)
        console.log('[TextInputter] Cmd+V sent via osascript')
      } catch (err) {
        console.error('[TextInputter] osascript failed:', err)
        throw new Error(
          '模拟粘贴失败。请安装 @jitsi/robotjs 或在系统设置中为 osascript 授予辅助功能权限'
        )
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
