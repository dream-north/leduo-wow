import { EventEmitter } from 'events'
import { ChildProcess, execSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { release } from 'os'
import path from 'path'

export interface NativeScreenRecorderStartResult {
  filePath: string
  targetDescription?: string
}

export interface NativeScreenRecordingArtifact {
  filePath: string
  mimeType: string
  durationMs: number
  targetDescription?: string
}

export interface NativeScreenRecorderExtractedFrame {
  timestampMs: number
  dataUrl: string
}

export interface NativeScreenRecorderTimelineFramesResult {
  frames: NativeScreenRecorderExtractedFrame[]
  intervalMs: number
}

export interface NativeScreenRecorderLike {
  startRecording(): Promise<NativeScreenRecorderStartResult>
  stopRecording(): Promise<NativeScreenRecordingArtifact>
  cancelRecording(): Promise<void>
  extractScreenshots(filePath: string, timestampsMs: number[]): Promise<NativeScreenRecorderExtractedFrame[]>
  extractTimelineFrames(
    filePath: string,
    intervalMs: number,
    maxFrames: number
  ): Promise<NativeScreenRecorderTimelineFramesResult>
  destroy(): void
  on(event: 'recording-error', listener: (payload: { error: string }) => void): this
}

interface NativeScreenRecorderResponseEnvelope {
  id?: string
  ok?: boolean
  result?: unknown
  error?: string
  type?: string
  event?: string
}

interface PendingCommand {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

function getDarwinMajorVersion(): number {
  return Number.parseInt(release().split('.')[0] || '0', 10)
}

function isMacOS14OrNewer(): boolean {
  return process.platform === 'darwin' && getDarwinMajorVersion() >= 23
}

export class NativeScreenRecorderClient extends EventEmitter implements NativeScreenRecorderLike {
  private process: ChildProcess | null = null
  private buffer = ''
  private readonly pending = new Map<string, PendingCommand>()

  startRecording(): Promise<NativeScreenRecorderStartResult> {
    if (!isMacOS14OrNewer()) {
      throw new Error('录屏整理原生版需要 macOS 14 或更高版本')
    }
    return this.sendCommand('startRecording') as Promise<NativeScreenRecorderStartResult>
  }

  stopRecording(): Promise<NativeScreenRecordingArtifact> {
    return this.sendCommand('stopRecording') as Promise<NativeScreenRecordingArtifact>
  }

  async cancelRecording(): Promise<void> {
    try {
      await this.sendCommand('cancelRecording')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('当前没有进行中的录屏')) {
        return
      }
      throw error
    }
  }

  extractScreenshots(
    filePath: string,
    timestampsMs: number[]
  ): Promise<NativeScreenRecorderExtractedFrame[]> {
    return this.sendCommand('extractScreenshots', {
      filePath,
      timestampsMs
    }) as Promise<NativeScreenRecorderExtractedFrame[]>
  }

  extractTimelineFrames(
    filePath: string,
    intervalMs: number,
    maxFrames: number
  ): Promise<NativeScreenRecorderTimelineFramesResult> {
    return this.sendCommand('extractTimelineFrames', {
      filePath,
      intervalMs,
      maxFrames
    }) as Promise<NativeScreenRecorderTimelineFramesResult>
  }

  destroy(): void {
    this.rejectPending(new Error('原生录屏 helper 已停止'))
    if (!this.process) return
    this.process.stdout?.removeAllListeners()
    this.process.stderr?.removeAllListeners()
    this.process.removeAllListeners()
    this.process.kill()
    this.process = null
    this.buffer = ''
  }

  private cleanupStaleProcesses(): void {
    if (process.platform !== 'darwin') return

    try {
      const output = execSync('pgrep -x SwiftScreenRecorder', { encoding: 'utf8' })
      const pids = output
        .trim()
        .split('\n')
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))

      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Ignore ESRCH and other transient failures while cleaning stale helpers.
        }
      }
    } catch {
      // `pgrep` exits 1 when no process exists.
    }
  }

  private ensureProcess(): ChildProcess {
    if (this.process && !this.process.killed) {
      return this.process
    }

    this.cleanupStaleProcesses()
    const executablePath = this.resolveExecutablePath()
    if (!existsSync(executablePath)) {
      throw new Error(`未找到原生录屏 helper: ${executablePath}`)
    }

    const child = spawn(executablePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    })

    child.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(data)
    })

    child.stderr?.on('data', (data: Buffer) => {
      const message = data.toString().trim()
      if (message) {
        console.error('[SwiftScreenRecorder] stderr:', message)
      }
    })

    child.on('error', (error) => {
      console.error('[SwiftScreenRecorder] process error:', error)
      this.process = null
      this.rejectPending(error instanceof Error ? error : new Error(String(error)))
    })

    child.on('exit', (code, signal) => {
      const exitError = new Error(`原生录屏 helper 已退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      this.process = null
      this.buffer = ''
      this.rejectPending(exitError)
    })

    this.process = child
    return child
  }

  private resolveExecutablePath(): string {
    if (process.env.NODE_ENV === 'production' || __dirname.includes('app.asar')) {
      return path.join(process.resourcesPath, 'SwiftScreenRecorder')
    }

    if (__dirname.includes('out/main')) {
      return path.join(
        __dirname,
        '..',
        '..',
        'src',
        'native-keyboard-listener',
        'SwiftScreenRecorder',
        'build',
        'SwiftScreenRecorder'
      )
    }

    return path.join(
      __dirname,
      'native-keyboard-listener',
      'SwiftScreenRecorder',
      'build',
      'SwiftScreenRecorder'
    )
  }

  private sendCommand(command: string, payload?: Record<string, unknown>): Promise<unknown> {
    const child = this.ensureProcess()
    const stdin = child.stdin
    if (!stdin) {
      throw new Error('原生录屏 helper stdin 不可用')
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const envelope = JSON.stringify({ id, command, payload }) + '\n'

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      stdin.write(envelope, (error) => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private handleStdout(data: Buffer): void {
    this.buffer += data.toString()

    while (true) {
      const lineBreakIndex = this.buffer.indexOf('\n')
      if (lineBreakIndex === -1) {
        return
      }

      const line = this.buffer.slice(0, lineBreakIndex).trim()
      this.buffer = this.buffer.slice(lineBreakIndex + 1)
      if (!line) continue

      try {
        const message = JSON.parse(line) as NativeScreenRecorderResponseEnvelope
        this.handleMessage(message)
      } catch (error) {
        console.error('[SwiftScreenRecorder] Failed to parse stdout line:', line, error)
      }
    }
  }

  private handleMessage(message: NativeScreenRecorderResponseEnvelope): void {
    if (message.type === 'event' && message.event) {
      this.emit(message.event, message)
      return
    }

    if (!message.id) {
      return
    }

    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }
    this.pending.delete(message.id)

    if (message.ok) {
      pending.resolve(message.result)
      return
    }

    pending.reject(new Error(message.error || '原生录屏 helper 调用失败'))
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}
