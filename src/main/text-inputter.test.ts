import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clipboardState = { text: '' }
const keyTap = vi.fn()

vi.mock('electron', () => ({
  clipboard: {
    readText: vi.fn(() => clipboardState.text),
    writeText: vi.fn((value: string) => {
      clipboardState.text = value
    })
  }
}))

vi.mock('@jitsi/robotjs', () => ({
  keyTap: vi.fn()
}))

import { TextInputter } from './text-inputter'

describe('TextInputter', () => {
  const fakeClipboard = {
    readText: vi.fn(() => clipboardState.text),
    writeText: vi.fn((value: string) => {
      clipboardState.text = value
    })
  }

  beforeEach(() => {
    clipboardState.text = 'previous clipboard'
    keyTap.mockClear()
    fakeClipboard.readText.mockClear()
    fakeClipboard.writeText.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses Ctrl+V for clipboard paste on Windows', async () => {
    const inputter = new TextInputter('win32', fakeClipboard, { keyTap })

    const inputPromise = inputter.input('hello', 'clipboard')
    await vi.runAllTimersAsync()
    await inputPromise

    expect(keyTap).toHaveBeenCalledWith('v', 'control')
    expect(fakeClipboard.writeText.mock.calls.at(-1)?.[0]).toBe('previous clipboard')
  })

  it('uses Cmd+V for clipboard paste on macOS', async () => {
    const inputter = new TextInputter('darwin', fakeClipboard, { keyTap })

    const inputPromise = inputter.input('hello', 'clipboard')
    await vi.runAllTimersAsync()
    await inputPromise

    expect(keyTap).toHaveBeenCalledWith('v', 'command')
    expect(fakeClipboard.writeText.mock.calls.at(-1)?.[0]).toBe('previous clipboard')
  })

  it('falls back from applescript to clipboard paste on Windows', async () => {
    const inputter = new TextInputter('win32', fakeClipboard, { keyTap })

    const inputPromise = inputter.input('hello', 'applescript')
    await vi.runAllTimersAsync()
    await inputPromise

    expect(keyTap).toHaveBeenCalledWith('v', 'control')
    expect(fakeClipboard.writeText.mock.calls.at(-1)?.[0]).toBe('previous clipboard')
  })
})
