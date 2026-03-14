import OpenAI from 'openai'
import { POLISH_DEFAULT_BASE_URL } from '../shared/types'

export class LLMPolisher {
  private client: OpenAI
  private model: string
  private apiKey: string
  private baseUrl: string

  constructor(apiKey: string, model: string = 'qwen3.5-flash', baseUrl?: string) {
    this.apiKey = apiKey
    this.baseUrl = baseUrl || POLISH_DEFAULT_BASE_URL
    this.client = new OpenAI({
      apiKey,
      baseURL: this.baseUrl
    })
    this.model = model
  }

  private buildUserContent(
    text: string,
    screenshotBase64?: string
  ): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
    if (screenshotBase64) {
      return [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } },
        { type: 'text', text }
      ]
    }
    return text
  }

  async polish(text: string, systemPrompt: string, screenshotBase64?: string): Promise<string> {
    const startTime = Date.now()
    try {
      // Use raw POST to guarantee enable_thinking: false is sent
      // The OpenAI SDK may silently drop unknown body params
      const response = await this.client.post('/chat/completions', {
        body: {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: this.buildUserContent(text, screenshotBase64) }
          ],
          temperature: 0.3,
          enable_thinking: false
        }
      }) as OpenAI.Chat.Completions.ChatCompletion

      const result = response.choices[0]?.message?.content
      console.log(`[LLMPolisher] Completed in ${Date.now() - startTime}ms`)
      return result?.trim() || text
    } catch (err) {
      console.error(`[LLMPolisher] Error after ${Date.now() - startTime}ms:`, err)
      throw err
    }
  }

  async polishStream(
    text: string,
    systemPrompt: string,
    screenshotBase64: string | undefined,
    onToken: (partialText: string) => void
  ): Promise<string> {
    const startTime = Date.now()
    try {
      const hasImage = !!screenshotBase64
      console.log(`[LLMPolisher] Stream start: model=${this.model}, textLen=${text.length}, image=${hasImage}`)

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: this.buildUserContent(text, screenshotBase64) }
          ],
          temperature: 0.3,
          stream: true,
          enable_thinking: false
        })
      })

      console.log(`[LLMPolisher] HTTP response: ${response.status} in ${Date.now() - startTime}ms`)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`API error ${response.status}: ${errorText.substring(0, 200)}`)
      }

      if (!response.body) {
        throw new Error('No response body for streaming')
      }

      let result = ''
      let buffer = ''
      let tokenCount = 0
      let firstTokenTime = 0
      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()!

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta?.content || ''
            if (delta) {
              tokenCount++
              if (tokenCount === 1) {
                firstTokenTime = Date.now() - startTime
                console.log(`[LLMPolisher] First token in ${firstTokenTime}ms`)
              }
              result += delta
              onToken(result)
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }

      console.log(`[LLMPolisher] Stream completed in ${Date.now() - startTime}ms, tokens=${tokenCount}, firstToken=${firstTokenTime}ms`)
      return result.trim() || text
    } catch (err) {
      console.error(`[LLMPolisher] Stream error after ${Date.now() - startTime}ms:`, err)
      throw err
    }
  }
}
