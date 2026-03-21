import { clipboard } from 'electron'

// robotjs for simulating keypress
let robot: { keyTap: (key: string, modifier: string | string[]) => void } | null = null
try {
  robot = require('@jitsi/robotjs')
} catch (err) {
  console.warn('[SelectedText] robotjs not available:', err)
}

/**
 * Get currently selected text by simulating Cmd+C and reading clipboard
 * This temporarily replaces clipboard content, then restores it
 */
export async function getSelectedText(): Promise<string | null> {
  console.log('[SelectedText] Getting selected text...')

  // Save current clipboard
  const previousClipboard = clipboard.readText()

  try {
    // Simulate Cmd+C to copy selected text
    if (robot) {
      robot.keyTap('c', process.platform === 'win32' ? 'control' : 'command')
      console.log(`[SelectedText] ${process.platform === 'win32' ? 'Ctrl+C' : 'Cmd+C'} sent via robotjs`)
    } else {
      if (process.platform !== 'darwin') {
        throw new Error('robotjs is required for selected-text capture on this platform')
      }

      // Fallback to osascript
      const { exec } = require('child_process')
      const { promisify } = require('util')
      const execAsync = promisify(exec)
      await execAsync(`osascript -e 'tell application "System Events" to keystroke "c" using {command down}'`)
      console.log('[SelectedText] Cmd+C sent via osascript')
    }

    // Wait for copy to complete
    await delay(200)

    // Read the copied text
    const selectedText = clipboard.readText()

    // Restore previous clipboard
    clipboard.writeText(previousClipboard)

    // Return null if no text was selected (clipboard unchanged or empty)
    if (!selectedText || selectedText === previousClipboard) {
      console.log('[SelectedText] No text selected')
      return null
    }

    console.log(`[SelectedText] Selected text: "${selectedText.substring(0, 50)}..."`)
    return selectedText
  } catch (err) {
    console.error('[SelectedText] Failed to get selected text:', err)
    // Restore clipboard on error
    clipboard.writeText(previousClipboard)
    return null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
