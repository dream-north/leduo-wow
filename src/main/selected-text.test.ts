// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { shouldSkipSelectionCaptureForForegroundApp } from './selected-text'

describe('shouldSkipSelectionCaptureForForegroundApp', () => {
  it('does not skip on non-Windows platforms', async () => {
    const queryForegroundProcess = vi.fn(async () => ({
      pid: 123,
      name: 'mintty.exe',
      title: 'Git Bash'
    }))

    await expect(
      shouldSkipSelectionCaptureForForegroundApp('darwin', queryForegroundProcess, 999)
    ).resolves.toBe(false)

    expect(queryForegroundProcess).not.toHaveBeenCalled()
  })

  it('skips when the foreground window belongs to this app', async () => {
    const queryForegroundProcess = vi.fn(async () => ({
      pid: 777,
      name: 'electron.exe',
      title: '乐多汪汪'
    }))

    await expect(
      shouldSkipSelectionCaptureForForegroundApp('win32', queryForegroundProcess, 777)
    ).resolves.toBe(true)
  })

  it('skips when a terminal window is frontmost on Windows', async () => {
    const queryForegroundProcess = vi.fn(async () => ({
      pid: 123,
      name: 'mintty.exe',
      title: 'MINGW64:/d/Studio/leduo-wow'
    }))

    await expect(
      shouldSkipSelectionCaptureForForegroundApp('win32', queryForegroundProcess, 999)
    ).resolves.toBe(true)
  })

  it('allows selection capture for normal apps on Windows', async () => {
    const queryForegroundProcess = vi.fn(async () => ({
      pid: 123,
      name: 'notepad.exe',
      title: 'notes.txt'
    }))

    await expect(
      shouldSkipSelectionCaptureForForegroundApp('win32', queryForegroundProcess, 999)
    ).resolves.toBe(false)
  })
})
