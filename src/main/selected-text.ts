import { clipboard } from 'electron'

// robotjs for simulating keypress
let robot: { keyTap: (key: string, modifier: string | string[]) => void } | null = null
try {
  robot = require('@jitsi/robotjs')
} catch (err) {
  console.warn('[SelectedText] robotjs not available:', err)
}

interface ForegroundProcessInfo {
  pid: number
  name: string
  title: string
}

const WINDOWS_UNSAFE_SELECTION_PROCESS_NAMES = new Set([
  'windowsterminal',
  'cmd',
  'conhost',
  'powershell',
  'pwsh',
  'mintty',
  'bash',
  'sh'
])

export async function shouldSkipSelectionCaptureForForegroundApp(
  platform: NodeJS.Platform = process.platform,
  queryForegroundProcess: () => Promise<ForegroundProcessInfo | null> = getForegroundProcessInfo,
  currentPid: number = process.pid
): Promise<boolean> {
  if (platform !== 'win32') {
    return false
  }

  try {
    const info = await queryForegroundProcess()
    if (!info) {
      return false
    }

    const normalizedName = info.name.trim().toLowerCase().replace(/\.exe$/, '')
    if (info.pid === currentPid) {
      console.log('[SelectedText] Skipping Ctrl+C because the foreground window belongs to this app')
      return true
    }

    if (WINDOWS_UNSAFE_SELECTION_PROCESS_NAMES.has(normalizedName)) {
      console.log(`[SelectedText] Skipping Ctrl+C because foreground app "${info.name}" is a terminal`)
      return true
    }
  } catch (err) {
    console.warn('[SelectedText] Failed to inspect foreground app, continuing with selection capture:', err)
  }

  return false
}

/**
 * Get currently selected text by simulating Cmd+C and reading clipboard
 * This temporarily replaces clipboard content, then restores it
 */
export async function getSelectedText(): Promise<string | null> {
  console.log('[SelectedText] Getting selected text...')

  if (await shouldSkipSelectionCaptureForForegroundApp()) {
    return null
  }

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

async function getForegroundProcessInfo(): Promise<ForegroundProcessInfo | null> {
  if (process.platform !== 'win32') {
    return null
  }

  const { execFile } = require('child_process') as typeof import('child_process')

  const script = `
Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll")]
public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
"@
$hwnd = [Win32.NativeMethods]::GetForegroundWindow()
$pid = 0
[Win32.NativeMethods]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
if ($pid -eq 0) { return }
$proc = Get-Process -Id $pid -ErrorAction Stop
@{
  pid = [int]$pid
  name = $proc.ProcessName
  title = $proc.MainWindowTitle
} | ConvertTo-Json -Compress
`.trim()

  return await new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 1500 },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }

        const output = stdout.trim()
        if (!output) {
          resolve(null)
          return
        }

        try {
          const parsed = JSON.parse(output) as ForegroundProcessInfo
          resolve(parsed)
        } catch {
          resolve(null)
        }
      }
    )
  })
}
