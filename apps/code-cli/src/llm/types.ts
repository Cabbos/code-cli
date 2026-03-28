export type LlmRole = "system" | "user" | "assistant" | "tool"

export type LlmToolCall = {
  id: string
  name: string
  input: unknown
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string }

export type LlmTool = {
  name: string
  description: string
  inputSchema?: unknown
}

export type LlmResponse = {
  content: string
  toolCalls: LlmToolCall[]
}

export type LlmStreamEvent =
  | { type: "token"; text: string }
  | { type: "toolCall"; toolCall: LlmToolCall }

export type LlmCompleteParams = {
  model: string
  messages: LlmMessage[]
  tools?: LlmTool[]
  temperature?: number
  stream?: boolean
  onStreamEvent?: (event: LlmStreamEvent) => void
}

export interface LlmProvider {
  complete(params: LlmCompleteParams): Promise<LlmResponse>
}

