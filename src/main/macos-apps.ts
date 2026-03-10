import { execFile } from 'child_process'

interface AppInfo {
  name: string
  bundleId: string
}

function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.trim())
    })
  })
}

export async function getRunningApps(): Promise<AppInfo[]> {
  const script = `
tell application "System Events"
  set appList to every process whose background only is false
  set output to ""
  repeat with proc in appList
    try
      set procName to name of proc
      set procId to bundle identifier of proc
      if procId is not missing value then
        set output to output & procName & "|||" & procId & linefeed
      end if
    end try
  end repeat
  return output
end tell`

  try {
    const output = await runOsascript(script)
    if (!output) return []

    const apps: AppInfo[] = []
    for (const line of output.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parts = trimmed.split('|||')
      if (parts.length === 2 && parts[1]) {
        apps.push({ name: parts[0], bundleId: parts[1] })
      }
    }

    return apps
      .filter(a => !a.bundleId.includes('leduo-wow'))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    console.error('[macos-apps] Failed to get running apps:', err)
    return []
  }
}

export async function getFrontmostApp(): Promise<AppInfo | null> {
  const script = `
tell application "System Events"
  set frontProc to first process whose frontmost is true
  set procName to name of frontProc
  set procId to bundle identifier of frontProc
  return procName & "|||" & procId
end tell`

  try {
    const output = await runOsascript(script)
    if (!output) return null

    const parts = output.split('|||')
    if (parts.length === 2 && parts[1]) {
      return { name: parts[0], bundleId: parts[1] }
    }
    return null
  } catch (err) {
    console.error('[macos-apps] Failed to get frontmost app:', err)
    return null
  }
}
