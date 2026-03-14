import OpenAI from 'openai'
import { POLISH_DEFAULT_BASE_URL } from '../shared/types'

interface LLMRequestOptions {
  enableThinking?: boolean
  enableSearch?: boolean
  enableCodeInterpreter?: boolean
}

interface AssistantToolUsage {
  codeInterpreterCount?: number
  webSearchCount?: number
  webExtractorCount?: number
}

interface AssistantResponseUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  reasoningContent?: string
  tools?: AssistantToolUsage
}

export interface AssistantResponseResult {
  text: string
  usage?: AssistantResponseUsage
}

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

  private buildRequestOptions(options?: LLMRequestOptions): { enable_thinking: boolean; enable_search: boolean } {
    return {
      enable_thinking: Boolean(options?.enableThinking || options?.enableCodeInterpreter),
      enable_search: options?.enableSearch ?? false
    }
  }

  private buildResponsesBaseUrl(): string {
    if (this.baseUrl.includes('/api/v2/apps/protocols/compatible-mode/v1')) {
      return this.baseUrl
    }
    if (this.baseUrl === POLISH_DEFAULT_BASE_URL) {
      return 'https://dashscope.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1'
    }
    return this.baseUrl
  }

  async polish(
    text: string,
    systemPrompt: string,
    screenshotBase64?: string,
    options?: LLMRequestOptions
  ): Promise<string> {
    const startTime = Date.now()
    try {
      // Use raw POST to guarantee extra body params are sent
      // The OpenAI SDK may silently drop unknown body params
      const response = await this.client.post('/chat/completions', {
        body: {
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: this.buildUserContent(text, screenshotBase64) }
          ],
          temperature: 0.3,
          ...this.buildRequestOptions(options)
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
    onToken: (partialText: string) => void,
    options?: LLMRequestOptions
  ): Promise<string> {
    const result = await this.polishStreamWithMetadata(
      text,
      systemPrompt,
      screenshotBase64,
      onToken,
      options
    )
    return result.text
  }

  async polishStreamWithMetadata(
    text: string,
    systemPrompt: string,
    screenshotBase64: string | undefined,
    onToken: (partialText: string) => void,
    options?: LLMRequestOptions
  ): Promise<AssistantResponseResult> {
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
          stream_options: {
            include_usage: true
          },
          ...this.buildRequestOptions(options)
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
      let reasoningContent = ''
      let usage: AssistantResponseUsage | undefined
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
            if (!parsed.choices?.length) {
              if (parsed.usage) {
                usage = {
                  inputTokens: parsed.usage.input_tokens,
                  outputTokens: parsed.usage.output_tokens,
                  totalTokens: parsed.usage.total_tokens,
                  reasoningTokens: parsed.usage.output_tokens_details?.reasoning_tokens,
                  reasoningContent: reasoningContent || undefined
                }
              }
              continue
            }

            const reasoningDelta = parsed.choices?.[0]?.delta?.reasoning_content || ''
            if (reasoningDelta) {
              reasoningContent += reasoningDelta
            }

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
      return {
        text: result.trim() || text,
        usage: usage ?? (reasoningContent
          ? {
              reasoningContent
            }
          : undefined)
      }
    } catch (err) {
      console.error(`[LLMPolisher] Stream error after ${Date.now() - startTime}ms:`, err)
      throw err
    }
  }

  async respondWithTools(
    text: string,
    systemPrompt: string,
    screenshotBase64: string | undefined,
    options?: LLMRequestOptions
  ): Promise<AssistantResponseResult> {
    const startTime = Date.now()
    const responseClient = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.buildResponsesBaseUrl()
    })

    const tools: Array<{ type: 'code_interpreter' | 'web_search' | 'web_extractor' }> = []
    if (options?.enableCodeInterpreter) {
      tools.push({ type: 'code_interpreter' })
    }
    if (options?.enableSearch) {
      tools.push({ type: 'web_search' }, { type: 'web_extractor' })
    }

    const userContent: Array<{ type: 'input_text' | 'input_image'; text?: string; image_url?: string }> = [
      { type: 'input_text', text }
    ]

    if (screenshotBase64) {
      userContent.push({
        type: 'input_image',
        image_url: `data:image/jpeg;base64,${screenshotBase64}`
      })
    }

    try {
      const response = await responseClient.responses.create({
        model: this.model,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ] as any,
        tools,
        enable_thinking: Boolean(options?.enableThinking || options?.enableCodeInterpreter)
      } as any)

      const usage = (response as any).usage
      const xTools = usage?.x_tools
      console.log(`[LLMPolisher] Responses completed in ${Date.now() - startTime}ms`)

      return {
        text: ((response as any).output_text as string | undefined)?.trim() || text,
        usage: usage ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.total_tokens,
          reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
          tools: {
            codeInterpreterCount: xTools?.code_interpreter?.count,
            webSearchCount: xTools?.web_search?.count,
            webExtractorCount: xTools?.web_extractor?.count
          }
        } : undefined
      }
    } catch (err) {
      console.error(`[LLMPolisher] Responses error after ${Date.now() - startTime}ms:`, err)
      throw err
    }
  }
}
