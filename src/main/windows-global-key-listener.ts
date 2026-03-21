import { execFile, type ChildProcess } from 'child_process'

export interface WindowsGlobalKeyboardEvent {
  [key: string]: unknown
  vKey: number
  scanCode: number
  name?: string
  state: 'DOWN' | 'UP'
  location: [number, number]
  _raw: string
}

export interface WindowsGlobalKeyboardListenerConfig {
  serverPath: string
  onInfo?: (message: string) => void
  onError?: (code: number | null) => void
  disposeDelay?: number
}

export type WindowsGlobalKeyboardListenerHandler = (
  event: WindowsGlobalKeyboardEvent,
  downState: Record<string, boolean>
) => boolean | { stopPropagation?: boolean; stopImmediatePropagation?: boolean }

const VK_NAMES: Record<number, string> = {
  0x01: 'MOUSE LEFT',
  0x02: 'MOUSE RIGHT',
  0x04: 'MOUSE MIDDLE',
  0x08: 'BACKSPACE',
  0x09: 'TAB',
  0x0D: 'ENTER',
  0x1B: 'ESC',
  0x20: 'SPACE',
  0x21: 'PAGE UP',
  0x22: 'PAGE DOWN',
  0x23: 'END',
  0x24: 'HOME',
  0x25: 'LEFT',
  0x26: 'UP',
  0x27: 'RIGHT',
  0x28: 'DOWN',
  0x2D: 'INSERT',
  0x2E: 'DELETE',
  0x5B: 'LEFT WIN',
  0x5C: 'RIGHT WIN',
  0xA0: 'LEFT SHIFT',
  0xA1: 'RIGHT SHIFT',
  0xA2: 'LEFT CONTROL',
  0xA3: 'RIGHT CONTROL',
  0xA4: 'LEFT ALT',
  0xA5: 'RIGHT ALT'
}

function lookupVirtualKeyName(vKey: number): string | undefined {
  if (vKey in VK_NAMES) {
    return VK_NAMES[vKey]
  }

  if (vKey >= 0x30 && vKey <= 0x39) {
    return String.fromCharCode(vKey)
  }

  if (vKey >= 0x41 && vKey <= 0x5A) {
    return String.fromCharCode(vKey)
  }

  if (vKey >= 0x70 && vKey <= 0x87) {
    return `F${vKey - 0x6F}`
  }

  return undefined
}

export class WindowsGlobalKeyboardListener {
  private readonly config: WindowsGlobalKeyboardListenerConfig
  private listeners: WindowsGlobalKeyboardListenerHandler[] = []
  private readonly isDown: Record<string, boolean> = {}
  private process: ChildProcess | null = null
  private buffer = ''
  private stopTimeout: ReturnType<typeof setTimeout> | null = null
  private running = false
  private stopping = false

  constructor(config: WindowsGlobalKeyboardListenerConfig) {
    this.config = config
  }

  async addListener(listener: WindowsGlobalKeyboardListenerHandler): Promise<void> {
    this.listeners.push(listener)
    if (this.listeners.length === 1) {
      this.clearStopTimeout()
      await this.start()
    }
  }

  removeListener(listener: WindowsGlobalKeyboardListenerHandler): void {
    const index = this.listeners.indexOf(listener)
    if (index === -1) {
      return
    }

    this.listeners.splice(index, 1)
    if (this.listeners.length !== 0) {
      return
    }

    if (this.config.disposeDelay === -1) {
      this.stop()
      return
    }

    this.stopTimeout = setTimeout(() => this.stop(), this.config.disposeDelay ?? 100)
  }

  kill(): void {
    this.listeners = []
    this.clearStopTimeout()
    this.stop()
  }

  private clearStopTimeout(): void {
    if (!this.stopTimeout) {
      return
    }

    clearTimeout(this.stopTimeout)
    this.stopTimeout = null
  }

  private async start(): Promise<void> {
    if (this.running) {
      return
    }

    this.stopping = false
    const process = execFile(this.config.serverPath, { maxBuffer: Infinity })
    this.process = process

    process.stderr?.on('data', (data: Buffer | string) => {
      this.config.onInfo?.(data.toString())
    })

    process.stdout?.on('data', (data: Buffer | string) => {
      this.handleStdout(data.toString())
    })

    process.on('close', (code) => {
      const shouldNotify = !this.stopping
      this.resetProcessState()
      if (shouldNotify) {
        this.config.onError?.(code)
      }
    })

    await new Promise<void>((resolve, reject) => {
      process.once('error', reject)
      process.once('spawn', () => resolve())
    })

    this.running = true
  }

  private stop(): void {
    if (!this.running || !this.process) {
      this.resetProcessState()
      return
    }

    this.stopping = true
    this.process.stdout?.pause()
    this.process.kill()
    this.resetProcessState()
  }

  private resetProcessState(): void {
    this.running = false
    this.process = null
    this.buffer = ''
    this.stopping = false
    for (const key of Object.keys(this.isDown)) {
      delete this.isDown[key]
    }
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const parsed = this.parseEventLine(line)
      if (!parsed) {
        continue
      }

      const stopPropagation = this.dispatchEvent(parsed.event)
      this.process?.stdin?.write(`${stopPropagation ? '1' : '0'},${parsed.eventId}\n`)
    }
  }

  private dispatchEvent(event: WindowsGlobalKeyboardEvent): boolean {
    if (event.name) {
      this.isDown[event.name] = event.state === 'DOWN'
    }

    let stopPropagation = false
    for (const listener of this.listeners) {
      try {
        const result = listener(event, this.isDown)
        if (typeof result === 'object' && result) {
          if (result.stopPropagation) {
            stopPropagation = true
          }
          if (result.stopImmediatePropagation) {
            break
          }
        } else if (result) {
          stopPropagation = true
        }
      } catch (error) {
        console.error('[WindowsGlobalKeyboardListener] Listener error:', error)
      }
    }

    return stopPropagation
  }

  private parseEventLine(line: string): { event: WindowsGlobalKeyboardEvent; eventId: string } | null {
    const trimmed = line.trim()
    if (!trimmed) {
      return null
    }

    const [device, state, vKeyText, scanCodeText, xText, yText, eventId] = trimmed.split(',')
    if (!device || !state || !vKeyText || !scanCodeText || !xText || !yText || !eventId) {
      return null
    }

    const vKey = Number.parseInt(vKeyText, 10)
    const scanCode = Number.parseInt(scanCodeText, 10)
    const x = Number.parseFloat(xText)
    const y = Number.parseFloat(yText)

    if (!Number.isFinite(vKey) || !Number.isFinite(scanCode) || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null
    }

    const normalizedState = state === 'DOWN' ? 'DOWN' : 'UP'
    const name = device === 'MOUSE' ? lookupVirtualKeyName(vKey) : lookupVirtualKeyName(vKey)

    return {
      event: {
        vKey,
        scanCode,
        name,
        state: normalizedState,
        location: [x, y],
        _raw: trimmed
      },
      eventId
    }
  }
}
