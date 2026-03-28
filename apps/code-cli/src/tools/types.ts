import { Workspace } from "../core/workspace"

export type ToolConfirmFn = (req: { name: string; input: unknown }) => Promise<boolean>

export type ToolContext = {
  workspace: Workspace
  confirm?: ToolConfirmFn
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
