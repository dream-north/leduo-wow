import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc-channels'
import type { OverlayResultStat, OverlayWindowPosition, OverlayWindowSize } from '../shared/types'
import { applyFloatingWindowBehavior } from './floating-window'

const defaultWindowWidth = 700
const defaultWindowHeight = 560
const minWindowWidth = 560
const minWindowHeight = 420
const hiddenWindowBounds = {
  x: -10000,
  y: -10000,
  width: 1,
  height: 1
}
let isQuitting = false
const latestPayloadByWindow = new WeakMap<BrowserWindow, AssistantResultPayload>()
const rendererReadyByWindow = new WeakMap<BrowserWindow, boolean>()
const pendingShowByWindow = new WeakMap<BrowserWindow, boolean>()
const throttledPayloadByWindow = new WeakMap<BrowserWindow, AssistantResultPayload | null>()
const throttleTimerByWindow = new WeakMap<BrowserWindow, ReturnType<typeof setTimeout> | null>()

export interface AssistantResultPayload {
  text: string
  position?: OverlayWindowPosition
  size?: OverlayWindowSize
  detailsMarkdown?: string
  stats?: OverlayResultStat[]
  sources?: Array<{ index: number; title: string; url: string }>
  reasoningMarkdown?: string
  reasoningCollapsed?: boolean
  codeMarkdown?: string
  codeCollapsed?: boolean
  turnIndex?: number
  userMessage?: string
  isConversation?: boolean
}

app.on('before-quit', () => {
  isQuitting = true
})

export function createAssistantResultWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: hiddenWindowBounds.width,
    height: hiddenWindowBounds.height,
    x: hiddenWindowBounds.x,
    y: hiddenWindowBounds.y,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/assistantResult.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setMinimumSize(minWindowWidth, minWindowHeight)
  win.setIgnoreMouseEvents(true)
  rendererReadyByWindow.set(win, false)
  pendingShowByWindow.set(win, false)
  latestPayloadByWindow.set(win, {
    text: ''
  })
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    hideAssistantResultWindow(win)
  })

  win.on('closed', () => {
    const timer = throttleTimerByWindow.get(win)
    if (timer) clearTimeout(timer)
    latestPayloadByWindow.delete(win)
    rendererReadyByWindow.delete(win)
    pendingShowByWindow.delete(win)
    throttledPayloadByWindow.delete(win)
    throttleTimerByWindow.delete(win)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/assistant-result.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/assistant-result.html'))
  }

  return win
}

function dispatchAssistantResultPayload(
  win: BrowserWindow,
  payload: AssistantResultPayload
): void {
  const wasVisible = win.isVisible()
  win.setIgnoreMouseEvents(false)
  win.webContents.send(IPC.ASSISTANT_RESULT_UPDATE, payload)

  if (!wasVisible) {
    positionAssistantResultWindow(win, payload.position, payload.size)
    applyFloatingWindowBehavior(win, 'screen-saver')
    win.showInactive()
    win.moveTop()
  }
}

export function positionAssistantResultWindowAtCursor(win: BrowserWindow): void {
  const cursorPoint = screen.getCursorScreenPoint()
  const currentDisplay = screen.getDisplayNearestPoint(cursorPoint)
  const { x, y, width, height } = currentDisplay.workArea
  const [currentWidth, currentHeight] = win.getSize()
  const targetX = Math.round(x + (width - currentWidth) / 2)
  const targetY = Math.round(y + (height - currentHeight) / 2)
  win.setPosition(targetX, targetY)
}

function isFrameVisible(position: OverlayWindowPosition, size: OverlayWindowSize): boolean {
  const targetBounds = {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height
  }

  return screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea
    return !(
      targetBounds.x + targetBounds.width <= x ||
      targetBounds.x >= x + width ||
      targetBounds.y + targetBounds.height <= y ||
      targetBounds.y >= y + height
    )
  })
}

function normalizeAssistantResultWindowSize(size?: OverlayWindowSize): OverlayWindowSize {
  return {
    width: Math.max(minWindowWidth, Math.round(size?.width ?? defaultWindowWidth)),
    height: Math.max(minWindowHeight, Math.round(size?.height ?? defaultWindowHeight))
  }
}

function positionAssistantResultWindow(
  win: BrowserWindow,
  position?: OverlayWindowPosition,
  size?: OverlayWindowSize
): void {
  const normalizedSize = normalizeAssistantResultWindowSize(size)
  win.setSize(normalizedSize.width, normalizedSize.height)

  if (position && isFrameVisible(position, normalizedSize)) {
    win.setPosition(Math.round(position.x), Math.round(position.y))
    return
  }

  positionAssistantResultWindowAtCursor(win)
}

export function showAssistantResultWindow(
  win: BrowserWindow,
  payload: AssistantResultPayload
): void {
  latestPayloadByWindow.set(win, payload)
  if (!rendererReadyByWindow.get(win)) {
    pendingShowByWindow.set(win, true)
    return
  }

  // First call (window not visible yet): dispatch immediately to show the window.
  // Subsequent calls while visible: coalesce via throttle to avoid flooding IPC.
  if (!win.isVisible()) {
    dispatchAssistantResultPayload(win, payload)
    return
  }

  throttledPayloadByWindow.set(win, payload)
  if (!throttleTimerByWindow.get(win)) {
    throttleTimerByWindow.set(
      win,
      setTimeout(() => {
        throttleTimerByWindow.set(win, null)
        const pending = throttledPayloadByWindow.get(win)
        throttledPayloadByWindow.set(win, null)
        if (pending && !win.isDestroyed()) {
          dispatchAssistantResultPayload(win, pending)
        }
      }, 50)
    )
  }
}

export function hideAssistantResultWindow(win: BrowserWindow): void {
  pendingShowByWindow.set(win, false)
  const timer = throttleTimerByWindow.get(win)
  if (timer) {
    clearTimeout(timer)
    throttleTimerByWindow.set(win, null)
  }
  throttledPayloadByWindow.set(win, null)
  if (rendererReadyByWindow.get(win)) {
    win.webContents.send(IPC.ASSISTANT_RESULT_HIDE)
  }
  win.setIgnoreMouseEvents(true)
  win.hide()
  win.setBounds(hiddenWindowBounds)
}

export function getLatestAssistantResultPayload(win: BrowserWindow): AssistantResultPayload | null {
  return latestPayloadByWindow.get(win) ?? null
}

export function markAssistantResultWindowReady(win: BrowserWindow): void {
  rendererReadyByWindow.set(win, true)

  if (!pendingShowByWindow.get(win)) {
    return
  }

  pendingShowByWindow.set(win, false)
  const latestPayload = latestPayloadByWindow.get(win)
  if (!latestPayload) {
    return
  }

  dispatchAssistantResultPayload(win, latestPayload)
}
