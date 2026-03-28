import { LlmCompleteParams, LlmProvider, LlmResponse } from "./types"

export class MockProvider implements LlmProvider {
  async complete(params: LlmCompleteParams): Promise<LlmResponse> {
    const lastMsg = params.messages[params.messages.length - 1]
    if (lastMsg?.role === "tool") {
      const out = `mock:tool_result:${lastMsg.name}:${lastMsg.content}`
      if (params.stream && params.onStreamEvent) {
        for (const ch of out) params.onStreamEvent({ type: "token", text: ch })
      }
      return { content: out, toolCalls: [] }
    }

    const lastUser = [...params.messages].reverse().find((m) => m.role === "user")
    const text = lastUser?.content ?? ""

    if (text.startsWith("tool:")) {
      const raw = text.slice("tool:".length).trim()
      const firstSpace = raw.search(/\s/)
      const name = firstSpace === -1 ? raw : raw.slice(0, firstSpace)
      const json = firstSpace === -1 ? "" : raw.slice(firstSpace).trim()
      if (!name) throw new Error("Missing tool name")
      let input: unknown = {}
      if (json) {
        try {
          input = JSON.parse(json)
        } catch {
          input = { raw: json }
        }
      }
      return { content: "", toolCalls: [{ id: "mock-1", name, input }] }
    }

    const out = `mock:${text}`
    if (params.stream && params.onStreamEvent) {
      for (const ch of out) params.onStreamEvent({ type: "token", text: ch })
    }
    return { content: out, toolCalls: [] }
  }
}
