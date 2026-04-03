import { Workspace } from "../core/workspace"
import { LlmMessage } from "../llm/types"

export type ToolConfirmFn = (req: { name: string; input: unknown }) => Promise<boolean>

export type ToolContext = {
  workspace: Workspace
  confirm?: ToolConfirmFn
  messages?: LlmMessage[]
  currentUserInput?: string
  trace?: (event: unknown) => void
}

export type ToolDefinition<I = unknown, O = unknown> = {
  name: string
  description: string
  inputSchema?: unknown
  invoke: (input: I, ctx: ToolContext) => Promise<O>
}

export type ToolCall = {
  id: string
  name: string
  input: unknown
}
