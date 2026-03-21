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
let isQuitting = false
const latestPayloadByWindow = new WeakMap<BrowserWindow, AssistantResultPayload>()

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
}

app.on('before-quit', () => {
  isQuitting = true
})

export function createAssistantResultWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const { x, y, width, height } = display.workArea

  const win = new BrowserWindow({
    width: defaultWindowWidth,
    height: defaultWindowHeight,
    x: Math.round(x + (width - defaultWindowWidth) / 2),
    y: Math.round(y + (height - defaultWindowHeight) / 2),
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
  latestPayloadByWindow.set(win, {
    text: ''
  })
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  applyFloatingWindowBehavior(win, 'screen-saver')

  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    hideAssistantResultWindow(win)
  })

  win.on('closed', () => {
    latestPayloadByWindow.delete(win)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/assistant-result.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/assistant-result.html'))
  }

  return win
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

  const showWindow = (): void => {
    const wasVisible = win.isVisible()
    win.webContents.send(IPC.ASSISTANT_RESULT_UPDATE, payload)
    if (!wasVisible) {
      positionAssistantResultWindow(win, payload.position, payload.size)
      applyFloatingWindowBehavior(win, 'screen-saver')
      win.showInactive()
      win.moveTop()
    }
  }

  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', showWindow)
    return
  }

  showWindow()
}

export function hideAssistantResultWindow(win: BrowserWindow): void {
  win.webContents.send(IPC.ASSISTANT_RESULT_HIDE)
  win.hide()
}

export function getLatestAssistantResultPayload(win: BrowserWindow): AssistantResultPayload | null {
  return latestPayloadByWindow.get(win) ?? null
}
