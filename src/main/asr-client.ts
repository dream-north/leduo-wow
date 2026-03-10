import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { ASR_DEFAULT_BASE_URL } from '../shared/types'

export class ASRClient extends EventEmitter {
  private apiKey: string
  private model: string
  private baseUrl: string
  private ws: WebSocket | null = null
  private isFinished: boolean = false
  private lastPartialText: string = ''
  private isReady: boolean = false
  private pendingChunks: Buffer[] = []
  private connectTimeout: ReturnType<typeof setTimeout> | null = null

  constructor(apiKey: string, model: string = 'qwen3-asr-flash-realtime', baseUrl?: string) {
    super()
    this.apiKey = apiKey
    this.model = model
    this.baseUrl = baseUrl || ASR_DEFAULT_BASE_URL
  }

  async start(): Promise<void> {
    const url = `${this.baseUrl}?model=${this.model}`

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      })

      this.connectTimeout = setTimeout(() => {
        this.connectTimeout = null
        reject(new Error('ASR connection timeout'))
        this.safeCloseWs()
      }, 10000)

      this.ws.on('open', () => {
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout)
          this.connectTimeout = null
        }
        // Send session.update to configure the session
        // Disable server_vad — in toggle mode the user controls start/stop explicitly,
        // so we don't want the server to auto-cut on pauses
        this.sendEvent({
          type: 'session.update',
          session: {
            modalities: ['text'],
            input_audio_format: 'pcm',
            input_audio_transcription: {
              language: 'zh'
            },
            turn_detection: null
          }
        })
      })

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString())
          this.handleMessage(msg, resolve)
        } catch (err) {
          console.error('ASR message parse error:', err)
        }
      })

      this.ws.on('error', (err) => {
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout)
          this.connectTimeout = null
        }
        this.emit('error', err)
        reject(err)
      })

      this.ws.on('close', () => {
        if (!this.isFinished) {
          this.emit('error', new Error('ASR connection closed unexpectedly'))
        }
      })
    })
  }

  private handleMessage(msg: Record<string, unknown>, resolveStart?: (value: void) => void): void {
    const type = msg.type as string
    console.log(`[ASR] Received message type: ${type}`)

    switch (type) {
      case 'session.updated':
        console.log('[ASR] Session configured successfully')
        this.isReady = true
        this.flushPendingChunks()
        resolveStart?.()
        break

      case 'conversation.item.input_audio_transcription.text': {
        // Partial/intermediate result — Qwen puts text in 'stash' field, not 'text'
        const partialText = (msg.transcript || msg.stash || msg.text || msg.delta || '') as string
        if (partialText) {
          this.lastPartialText = partialText
          console.log(`[ASR] Partial text: "${partialText}"`)
          this.emit('partial', partialText)
        }
        break
      }

      case 'conversation.item.input_audio_transcription.completed': {
        // Final result — try transcript field (OpenAI convention), then text, then fallback
        console.log(`[ASR] Completed raw:`, JSON.stringify(msg).substring(0, 500))
        const finalText = (msg.transcript || msg.text || '') as string
        const result = finalText || this.lastPartialText
        console.log(`[ASR] Completed text: "${result}" (field transcript="${msg.transcript}", text="${msg.text}", fallback="${this.lastPartialText}")`)
        this.isFinished = true
        this.emit('completed', result)
        this.safeCloseWs()
        break
      }

      case 'error':
        console.error('[ASR] Server error:', JSON.stringify(msg))
        this.emit('error', new Error((msg.error as Record<string, string>)?.message || 'ASR error'))
        break

      case 'session.finished':
        console.log('[ASR] Session finished by server')
        this.isFinished = true
        this.emit('session.finished')
        this.safeCloseWs()
        break

      default:
        console.log(`[ASR] Unhandled message:`, JSON.stringify(msg).substring(0, 200))
        // Other events like response.audio_transcript.delta etc.
        if (type?.includes('transcript')) {
          const deltaText = (msg.delta || msg.transcript || msg.text || '') as string
          if (deltaText) {
            this.lastPartialText = deltaText
            this.emit('partial', deltaText)
          }
        }
        break
    }
  }

  appendAudio(pcmChunk: Buffer): void {
    if (this.isReady && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendAudioChunk(pcmChunk)
    } else if (!this.isFinished) {
      // Buffer chunks until WebSocket session is ready
      this.pendingChunks.push(pcmChunk)
    }
  }

  private flushPendingChunks(): void {
    if (this.pendingChunks.length === 0) return
    console.log(`[ASR] Flushing ${this.pendingChunks.length} buffered audio chunks`)
    for (const chunk of this.pendingChunks) {
      this.sendAudioChunk(chunk)
    }
    this.pendingChunks = []
  }

  private sendAudioChunk(pcmChunk: Buffer): void {
    const base64Audio = pcmChunk.toString('base64')
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    })
  }

  async finish(): Promise<void> {
    // If WebSocket is still connecting, wait for it to be ready
    if (this.ws && !this.isReady && !this.isFinished) {
      console.log('[ASR] finish() called before ready, waiting for session...')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          console.log('[ASR] finish() wait for ready timed out')
          resolve()
        }, 3000)
        const check = (): void => {
          if (this.isReady || this.isFinished) {
            clearTimeout(timeout)
            resolve()
          } else {
            setTimeout(check, 50)
          }
        }
        check()
      })
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendEvent({ type: 'input_audio_buffer.commit' })
      this.sendEvent({ type: 'session.finish' })
    }

    // If already finished (e.g. completed event already fired), resolve immediately
    if (this.isFinished) return

    // Wait for completed or session.finished event with timeout
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[ASR] finish() timed out after 5s, resolving')
        resolve()
      }, 5000)

      const cleanup = () => {
        clearTimeout(timeout)
        resolve()
      }

      this.once('completed', cleanup)

      // session.finished means the server is done — no completed event coming
      this.once('session.finished', cleanup)

      // WebSocket closed means nothing more is coming
      this.once('error', (err) => {
        console.warn('[ASR] Error during finish:', err.message)
        cleanup()
      })
    })
  }

  abort(): void {
    console.log('[ASR] abort() called')
    this.isFinished = true
    this.isReady = false
    this.pendingChunks = []
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout)
      this.connectTimeout = null
    }
    this.removeAllListeners()
    if (this.ws) {
      this.ws.removeAllListeners()
      this.safeCloseWs()
      this.ws = null
    }
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event))
    }
  }

  private safeCloseWs(): void {
    if (!this.ws) return

    const ws = this.ws

    // Suppress error events during close/terminate
    ws.on('error', () => {
      // Ignore errors during close/terminate
    })

    try {
      // Use terminate() for CONNECTING state to avoid "closed before connection established" error
      // Use close() for OPEN state for graceful shutdown
      if (ws.readyState === WebSocket.CONNECTING) {
        // For CONNECTING state, we need to be extra careful
        // Set a flag to ignore the specific error
        const originalEmit = ws.emit.bind(ws)
        ws.emit = function(event: string | symbol, ...args: unknown[]) {
          if (event === 'error' && args[0] instanceof Error) {
            const err = args[0] as Error
            if (err.message.includes('closed before the connection was established')) {
              return true
            }
          }
          return originalEmit(event, ...args)
        } as typeof ws.emit

        ws.terminate()
      } else if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
      // CLOSING (2) or CLOSED (3) - do nothing
    } catch {
      // Ignore any synchronous errors during close/terminate
    }
  }
}
