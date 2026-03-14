import OpenAI from 'openai'
import { POLISH_DEFAULT_BASE_URL } from '../shared/types'
import type { OverlayResultSource } from '../shared/types'

interface LLMRequestOptions {
  enableThinking?: boolean
  enableSearch?: boolean
  enableCodeInterpreter?: boolean
  thinkingBudget?: number
  signal?: AbortSignal
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
  sources?: OverlayResultSource[]
  codeMarkdown?: string
}

export interface AssistantStreamProgress {
  answerText: string
  reasoningText: string
  isAnswering: boolean
  codeMarkdown?: string
  codeCollapsed?: boolean
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

  private supportsThinkingBudget(): boolean {
    return /^(qwen(?:3(?:-[\w.]+)?|3\.5-(?:plus|flash)|plus|max))(?:-|$)/.test(this.model)
  }

  private buildRequestOptions(options?: LLMRequestOptions): { enable_thinking: boolean; enable_search: boolean; thinking_budget?: number } {
    const requestOptions: { enable_thinking: boolean; enable_search: boolean; thinking_budget?: number } = {
      enable_thinking: Boolean(options?.enableThinking || options?.enableCodeInterpreter),
      enable_search: options?.enableSearch ?? false
    }
    if (requestOptions.enable_thinking && this.supportsThinkingBudget() && (options?.thinkingBudget ?? 0) > 0) {
      requestOptions.thinking_budget = options?.thinkingBudget
    }
    return requestOptions
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

  private usesDashScopeApiHost(): boolean {
    return this.baseUrl.includes('dashscope.aliyuncs.com')
  }

  private isDashScopeMultimodalModel(): boolean {
    return /^qwen3\.5-(plus|flash)(-|$)/.test(this.model)
  }

  private buildDashScopeGenerationUrl(multimodal = false): string {
    const suffix = multimodal ? 'multimodal-generation/generation' : 'text-generation/generation'
    if (this.baseUrl.includes('/api/v1/services/aigc/')) {
      return this.baseUrl.replace(
        /\/api\/v1\/services\/aigc\/(?:text-generation|multimodal-generation)\/generation\/?$/,
        `/api/v1/services/aigc/${suffix}`
      )
    }

    const normalized = this.baseUrl.replace(/\/$/, '')
    if (this.usesDashScopeApiHost()) {
      const host = normalized.replace(/\/(?:api\/v2\/apps\/protocols\/)?compatible-mode\/v1$/, '')
      return `${host}/api/v1/services/aigc/${suffix}`
    }

    return normalized.replace(/\/compatible-mode\/v1\/?$/, `/api/v1/services/aigc/${suffix}`)
  }

  private extractMessageText(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part
          if (typeof (part as any)?.text === 'string') return (part as any).text
          return ''
        })
        .join('')
    }
    return ''
  }

  private extractResponsesOutputText(response: any): string {
    const directOutputText = typeof response?.output_text === 'string'
      ? response.output_text.trim()
      : ''
    if (directOutputText) {
      return directOutputText
    }

    const outputItems = Array.isArray(response?.output) ? response.output : []
    for (const item of outputItems) {
      if (typeof item?.text === 'string' && item.text.trim()) {
        return item.text.trim()
      }

      if (item?.type === 'message' || item?.role === 'assistant') {
        const text = this.extractMessageText(item.content).trim()
        if (text) {
          return text
        }
      }
    }

    return ''
  }

  private normalizeSearchSources(searchResults: unknown): OverlayResultSource[] | undefined {
    if (!Array.isArray(searchResults)) return undefined
    const normalized = searchResults
      .filter((item) => (item as any)?.index && (item as any)?.title && (item as any)?.url)
      .map((item) => ({
        index: Number((item as any).index),
        title: String((item as any).title),
        url: String((item as any).url)
      }))

    return normalized.length > 0 ? normalized : undefined
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
        signal: options?.signal,
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
      ({ answerText }) => onToken(answerText),
      options
    )
    return result.text
  }

  async polishStreamWithMetadata(
    text: string,
    systemPrompt: string,
    screenshotBase64: string | undefined,
    onProgress: (progress: AssistantStreamProgress) => void,
    options?: LLMRequestOptions
  ): Promise<AssistantResponseResult> {
    const startTime = Date.now()
    try {
      const hasImage = !!screenshotBase64
      console.log(`[LLMPolisher] Stream start: model=${this.model}, textLen=${text.length}, image=${hasImage}`)

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: options?.signal,
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
                  inputTokens: parsed.usage.input_tokens ?? parsed.usage.prompt_tokens,
                  outputTokens: parsed.usage.output_tokens ?? parsed.usage.completion_tokens,
                  totalTokens: parsed.usage.total_tokens,
                  reasoningTokens: parsed.usage.output_tokens_details?.reasoning_tokens
                    ?? parsed.usage.completion_tokens_details?.reasoning_tokens,
                  reasoningContent: reasoningContent || undefined
                }
              }
              continue
            }

            const reasoningDelta = parsed.choices?.[0]?.delta?.reasoning_content || ''
            if (reasoningDelta) {
              reasoningContent += reasoningDelta
              onProgress({
                answerText: result,
                reasoningText: reasoningContent,
                isAnswering: result.length > 0
              })
            }

            const delta = parsed.choices?.[0]?.delta?.content || ''
            if (delta) {
              tokenCount++
              if (tokenCount === 1) {
                firstTokenTime = Date.now() - startTime
                console.log(`[LLMPolisher] First token in ${firstTokenTime}ms`)
              }
              result += delta
              onProgress({
                answerText: result,
                reasoningText: reasoningContent,
                isAnswering: true
              })
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
        enable_thinking: Boolean(options?.enableThinking || options?.enableCodeInterpreter),
        ...(this.supportsThinkingBudget() && (options?.thinkingBudget ?? 0) > 0
          ? { thinking_budget: options?.thinkingBudget }
          : {})
      } as any, {
        signal: options?.signal
      })

      const usage = (response as any).usage
      const xTools = usage?.x_tools
      console.log(`[LLMPolisher] Responses completed in ${Date.now() - startTime}ms`)

      return {
        text: this.extractResponsesOutputText(response) || text,
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

  async respondWithToolsStream(
    text: string,
    systemPrompt: string,
    screenshotBase64: string | undefined,
    onProgress: (progress: AssistantStreamProgress) => void,
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

    const buildCodeMarkdown = (code: string, logs: string): string | undefined => {
      const sections: string[] = []
      if (code.trim()) {
        sections.push(['```python', code.trim(), '```'].join('\n'))
      }
      if (logs.trim()) {
        sections.push(['```text', logs.trim(), '```'].join('\n'))
      }
      return sections.length > 0 ? sections.join('\n\n') : undefined
    }

    let answerText = ''
    let reasoningText = ''
    let codeText = ''
    let codeLogs = ''
    let finalOutputText = ''
    let usage: AssistantResponseUsage | undefined
    let sources: OverlayResultSource[] | undefined

    const stream = await responseClient.responses.create({
      model: this.model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ] as any,
      tools,
      enable_thinking: Boolean(options?.enableThinking || options?.enableCodeInterpreter),
      ...(this.supportsThinkingBudget() && (options?.thinkingBudget ?? 0) > 0
        ? { thinking_budget: options?.thinkingBudget }
        : {}),
      stream: true
    } as any, {
      signal: options?.signal
    })

    for await (const event of stream as any) {
      switch (event.type) {
      case 'response.reasoning_summary_text.delta':
        reasoningText += event.delta ?? ''
        onProgress({
          answerText,
          reasoningText,
          isAnswering: answerText.length > 0,
          codeMarkdown: buildCodeMarkdown(codeText, codeLogs),
          codeCollapsed: answerText.length > 0
        })
        break
      case 'response.code_interpreter_call.code.delta':
        codeText += event.delta ?? ''
        onProgress({
          answerText,
          reasoningText,
          isAnswering: answerText.length > 0,
          codeMarkdown: buildCodeMarkdown(codeText, codeLogs),
          codeCollapsed: answerText.length > 0
        })
        break
      case 'response.output_item.done': {
        const item = event.item
        if (item?.type === 'code_interpreter_call') {
          if (typeof item.code === 'string' && item.code) {
            codeText = item.code
          }
          if (Array.isArray(item.results)) {
            codeLogs = item.results
              .filter((result: any) => result?.type === 'logs' && typeof result.logs === 'string')
              .map((result: any) => result.logs)
              .join('\n\n')
          }
          onProgress({
            answerText,
            reasoningText,
            isAnswering: answerText.length > 0,
            codeMarkdown: buildCodeMarkdown(codeText, codeLogs),
            codeCollapsed: answerText.length > 0
          })
        }
        break
      }
      case 'response.output_text.delta':
        answerText += event.delta ?? ''
        onProgress({
          answerText,
          reasoningText,
          isAnswering: true,
          codeMarkdown: buildCodeMarkdown(codeText, codeLogs),
          codeCollapsed: true
        })
        break
      case 'response.completed': {
        const finalResponse = event.response
        finalOutputText = this.extractResponsesOutputText(finalResponse)
        const finalUsage = finalResponse?.usage
        const xTools = finalUsage?.x_tools
        usage = finalUsage ? {
          inputTokens: finalUsage.input_tokens,
          outputTokens: finalUsage.output_tokens,
          totalTokens: finalUsage.total_tokens,
          reasoningTokens: finalUsage.output_tokens_details?.reasoning_tokens,
          reasoningContent: reasoningText || undefined,
          tools: {
            codeInterpreterCount: xTools?.code_interpreter?.count,
            webSearchCount: xTools?.web_search?.count,
            webExtractorCount: xTools?.web_extractor?.count
          }
        } : undefined

        const outputItems = Array.isArray(finalResponse?.output) ? finalResponse.output : []
        const webSearchItem = outputItems.find((item: any) => item?.type === 'web_search_call' || item?.type === 'function_web_search')
        sources = this.normalizeSearchSources(webSearchItem?.action?.search_results ?? webSearchItem?.search_results) ?? sources
        break
      }
      default:
        break
      }
    }

    console.log(`[LLMPolisher] Responses stream completed in ${Date.now() - startTime}ms`)
    return {
      text: finalOutputText || answerText.trim() || text,
      usage: usage ?? (reasoningText ? { reasoningContent: reasoningText } : undefined),
      sources,
      codeMarkdown: buildCodeMarkdown(codeText, codeLogs)
    }
  }

  async respondWithSearch(
    text: string,
    systemPrompt: string,
    options?: LLMRequestOptions
  ): Promise<AssistantResponseResult> {
    const startTime = Date.now()
    const useMultimodalEndpoint = this.usesDashScopeApiHost() && this.isDashScopeMultimodalModel()
    const searchUrl = this.buildDashScopeGenerationUrl(useMultimodalEndpoint)
    const searchMessages = useMultimodalEndpoint
      ? [
          ...(systemPrompt
            ? [{ role: 'system', content: [{ text: systemPrompt }] }]
            : []),
          { role: 'user', content: [{ text }] }
        ]
      : [
          ...(systemPrompt
            ? [{ role: 'system', content: systemPrompt }]
            : []),
          { role: 'user', content: text }
        ]
    console.log(`[LLMPolisher] Search request -> ${searchUrl}`)
    const response = await fetch(searchUrl, {
      method: 'POST',
      signal: options?.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: {
          messages: searchMessages
        },
        parameters: {
          enable_thinking: Boolean(options?.enableThinking),
          ...(this.supportsThinkingBudget() && (options?.thinkingBudget ?? 0) > 0
            ? { thinking_budget: options?.thinkingBudget }
            : {}),
          enable_search: true,
          result_format: 'message',
          search_options: {
            search_strategy: 'turbo',
            enable_source: true,
            enable_citation: true,
            citation_format: '[ref_<number>]'
          }
        }
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`DashScope search error ${response.status} (${searchUrl}): ${errorText.substring(0, 300)}`)
    }

    const parsed = await response.json() as any
    const message = parsed.output?.choices?.[0]?.message
    const usage = parsed.usage
    const content = this.extractMessageText(message?.content)
    console.log(`[LLMPolisher] Search completed in ${Date.now() - startTime}ms`)

    return {
      text: String(content || text).trim() || text,
      usage: usage ? {
        inputTokens: usage.input_tokens ?? usage.prompt_tokens,
        outputTokens: usage.output_tokens ?? usage.completion_tokens,
        totalTokens: usage.total_tokens,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens
          ?? usage.completion_tokens_details?.reasoning_tokens
      } : undefined,
      sources: this.normalizeSearchSources(parsed.output?.search_info?.search_results)
    }
  }

  async respondWithSearchStream(
    text: string,
    systemPrompt: string,
    onProgress: (progress: AssistantStreamProgress) => void,
    options?: LLMRequestOptions
  ): Promise<AssistantResponseResult> {
    const startTime = Date.now()
    const useMultimodalEndpoint = this.usesDashScopeApiHost() && this.isDashScopeMultimodalModel()
    const searchUrl = this.buildDashScopeGenerationUrl(useMultimodalEndpoint)
    const searchMessages = useMultimodalEndpoint
      ? [
          ...(systemPrompt
            ? [{ role: 'system', content: [{ text: systemPrompt }] }]
            : []),
          { role: 'user', content: [{ text }] }
        ]
      : [
          ...(systemPrompt
            ? [{ role: 'system', content: systemPrompt }]
            : []),
          { role: 'user', content: text }
        ]

    console.log(`[LLMPolisher] Search stream request -> ${searchUrl}`)
    const response = await fetch(searchUrl, {
      method: 'POST',
      signal: options?.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'X-DashScope-SSE': 'enable'
      },
      body: JSON.stringify({
        model: this.model,
        input: {
          messages: searchMessages
        },
        parameters: {
          enable_thinking: Boolean(options?.enableThinking),
          ...(this.supportsThinkingBudget() && (options?.thinkingBudget ?? 0) > 0
            ? { thinking_budget: options?.thinkingBudget }
            : {}),
          enable_search: true,
          incremental_output: true,
          result_format: 'message',
          search_options: {
            search_strategy: 'turbo',
            enable_source: true,
            enable_citation: true,
            citation_format: '[ref_<number>]'
          }
        }
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`DashScope search stream error ${response.status} (${searchUrl}): ${errorText.substring(0, 300)}`)
    }

    if (!response.body) {
      throw new Error('No response body for search streaming')
    }

    let answerText = ''
    let reasoningText = ''
    let buffer = ''
    let usage: AssistantResponseUsage | undefined
    let sources: OverlayResultSource[] | undefined
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (!data || data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          sources = this.normalizeSearchSources(parsed.output?.search_info?.search_results) ?? sources

          if (parsed.usage) {
            usage = {
              inputTokens: parsed.usage.input_tokens ?? parsed.usage.prompt_tokens,
              outputTokens: parsed.usage.output_tokens ?? parsed.usage.completion_tokens,
              totalTokens: parsed.usage.total_tokens,
              reasoningTokens: parsed.usage.output_tokens_details?.reasoning_tokens
                ?? parsed.usage.completion_tokens_details?.reasoning_tokens,
              reasoningContent: reasoningText || undefined
            }
          }

          const message = parsed.output?.choices?.[0]?.message
          const reasoningDelta = this.extractMessageText(message?.reasoning_content)
          if (reasoningDelta) {
            reasoningText += reasoningDelta
          }

          const answerDelta = this.extractMessageText(message?.content)
          if (answerDelta) {
            answerText += answerDelta
          }

          if (reasoningDelta || answerDelta) {
            onProgress({
              answerText,
              reasoningText,
              isAnswering: answerText.length > 0
            })
          }
        } catch {
          // Skip malformed SSE payloads.
        }
      }
    }

    console.log(`[LLMPolisher] Search stream completed in ${Date.now() - startTime}ms`)
    return {
      text: answerText.trim() || text,
      usage: usage ?? (reasoningText ? { reasoningContent: reasoningText } : undefined),
      sources
    }
  }
}
