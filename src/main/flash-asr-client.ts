import { FLASH_ASR_DEFAULT_API_URL, VOCAB_PROMPT_DEFAULT_TEMPLATE } from '../shared/types'
import type { VocabularyEntry } from '../shared/types'

export class FlashASRClient {
  private apiKey: string
  private model: string
  private apiUrl: string

  constructor(apiKey: string, model: string, apiUrl: string = FLASH_ASR_DEFAULT_API_URL) {
    this.apiKey = apiKey
    this.model = model
    this.apiUrl = apiUrl
  }

  /**
   * Recognize audio using DashScope native multimodal-generation API.
   * Optionally includes a system prompt with vocabulary hints.
   */
  async recognize(wavBase64: string, systemPrompt?: string, signal?: AbortSignal): Promise<string> {
    const messages: Array<{ role: string; content: Array<Record<string, string>> }> = []

    if (systemPrompt) {
      messages.push({ role: 'system', content: [{ text: systemPrompt }] })
    }
    messages.push({ role: 'user', content: [{ audio: `data:audio/wav;base64,${wavBase64}` }] })

    const resp = await fetch(this.apiUrl, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        input: { messages },
        parameters: { result_format: 'message' }
      })
    })

    const json = (await resp.json()) as {
      code?: string
      message?: string
      output?: {
        choices?: Array<{
          message?: { content?: Array<{ text?: string }> }
        }>
      }
    }

    if (json.code) {
      throw new Error(`Flash ASR error: ${json.code} - ${json.message}`)
    }

    return json.output?.choices?.[0]?.message?.content?.[0]?.text || ''
  }

  /**
   * Build a system prompt from vocabulary entries.
   * Personal entries should come first in the array (higher priority).
   * Supports a customizable template with {vocabulary_list} placeholder.
   */
  static buildVocabularySystemPrompt(entries: VocabularyEntry[], template?: string): string {
    if (entries.length === 0) return ''

    const lines = entries.map((e) => {
      if (e.description) return `- ${e.term}：${e.description}`
      return `- ${e.term}`
    })
    const vocabList = lines.join('\n')

    const tpl = template?.trim() ? template : VOCAB_PROMPT_DEFAULT_TEMPLATE
    if (tpl.includes('{vocabulary_list}')) {
      return tpl.replace('{vocabulary_list}', vocabList)
    }
    return `${tpl}\n${vocabList}`
  }

  /**
   * Convert an array of raw PCM chunks into a WAV base64 string.
   * Fixed format: 16000Hz, 16-bit signed LE, mono.
   */
  static pcmChunksToWavBase64(chunks: Buffer[]): string {
    const pcmData = Buffer.concat(chunks)
    const sampleRate = 16000
    const bitsPerSample = 16
    const channels = 1
    const byteRate = (sampleRate * channels * bitsPerSample) / 8
    const blockAlign = (channels * bitsPerSample) / 8

    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcmData.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16) // fmt chunk size
    header.writeUInt16LE(1, 20) // PCM format
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcmData.length, 40)

    return Buffer.concat([header, pcmData]).toString('base64')
  }
}
