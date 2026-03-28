import { sseLinesFromResponse } from "./sse"
import { LlmCompleteParams, LlmProvider, LlmResponse, LlmToolCall } from "./types"

type OpenAICompatibleOptions = {
  baseUrl: string
  apiKey?: string
}

type ToolCallAccumulator = {
  id: string
  name: string
  argsJson: string
}

export class OpenAICompatibleProvider implements LlmProvider {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined

  constructor(opts: OpenAICompatibleOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
    this.apiKey = opts.apiKey
  }

  async complete(params: LlmCompleteParams): Promise<LlmResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`
    const body = {
      model: params.model,
      messages: params.messages.map((m) => {
        if (m.role === "tool") {
          return { role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content }
        }
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant",
            content: m.content ?? "",
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) }
            }))
          }
        }
        return { role: m.role, content: m.content }
      }),
      temperature: params.temperature ?? 0,
      stream: Boolean(params.stream),
      tools: params.tools?.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema ?? { type: "object", additionalProperties: true }
        }
      }))
    }

    const headers: Record<string, string> = {
      "content-type": "application/json"
    }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
    if (!res.ok) {
      const errText = await res.text().catch(() => "")
      throw new Error(`LLM request failed: ${res.status} ${res.statusText} ${errText}`.trim())
    }

    if (!params.stream) {
      const json = (await res.json()) as any
      const msg = json?.choices?.[0]?.message
      const content = msg?.content ?? ""
      const toolCalls: LlmToolCall[] =
        msg?.tool_calls?.map((tc: any) => ({
          id: String(tc.id),
          name: String(tc.function?.name ?? ""),
          input: safeJsonParse(tc.function?.arguments ?? "{}")
        })) ?? []
      return { content, toolCalls }
    }

    const toolAcc = new Map<number, ToolCallAccumulator>()
    let content = ""

    for await (const line of sseLinesFromResponse(res)) {
      if (!line.startsWith("data:")) continue
      const data = line.slice("data:".length).trim()
      if (!data || data === "[DONE]") continue
      const chunk = safeJsonParse(data) as any
      const delta = chunk?.choices?.[0]?.delta
      if (!delta) continue

      const piece = delta?.content
      if (typeof piece === "string" && piece.length) {
        content += piece
        params.onStreamEvent?.({ type: "token", text: piece })
      }

      const dToolCalls = delta?.tool_calls
      if (Array.isArray(dToolCalls)) {
        for (const tc of dToolCalls) {
          const idx = Number(tc.index ?? 0)
          const prev = toolAcc.get(idx) ?? { id: "", name: "", argsJson: "" }
          if (typeof tc.id === "string") prev.id = tc.id
          const fn = tc.function
          if (fn) {
            if (typeof fn.name === "string") prev.name = fn.name
            if (typeof fn.arguments === "string") prev.argsJson += fn.arguments
          }
          toolAcc.set(idx, prev)
        }
      }
    }

    const toolCalls: LlmToolCall[] = [...toolAcc.values()]
      .filter((t) => t.name)
      .map((t) => ({ id: t.id || `tool-${t.name}`, name: t.name, input: safeJsonParse(t.argsJson || "{}") }))

    for (const tc of toolCalls) params.onStreamEvent?.({ type: "toolCall", toolCall: tc })

    return { content, toolCalls }
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return { _raw: s }
  }
}

