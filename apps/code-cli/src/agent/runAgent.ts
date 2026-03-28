import { Workspace } from "../core/workspace"
import { LlmMessage, LlmProvider, LlmTool, LlmToolCall } from "../llm/types"
import { ToolRegistry } from "../tools/registry"
import { ToolConfirmFn } from "../tools/types"
import { createHash } from "node:crypto"

export type RunAgentParams = {
  provider: LlmProvider
  model: string
  workspace: Workspace
  tools: ToolRegistry
  prompt: string
  stream?: boolean
  maxSteps?: number
}

export async function runAgent(params: RunAgentParams): Promise<string> {
  const messages = createInitialMessages(
    "You are a coding agent. Use tools when you need to read/write/list files. Prefer tools over guessing. Keep outputs concise."
  )
  const turnParams: RunAgentTurnParams = {
    provider: params.provider,
    model: params.model,
    workspace: params.workspace,
    tools: params.tools,
    messages,
    userInput: params.prompt,
    ...(typeof params.stream === "boolean" ? { stream: params.stream } : {}),
    ...(typeof params.maxSteps === "number" ? { maxSteps: params.maxSteps } : {})
  }
  const res = await runAgentTurn(turnParams)
  return res.content
}

export type RunAgentTurnParams = {
  provider: LlmProvider
  model: string
  workspace: Workspace
  tools: ToolRegistry
  messages: LlmMessage[]
  userInput: string
  systemPrompt?: string
  stream?: boolean
  maxSteps?: number
  confirm?: ToolConfirmFn
  sanitizeToolNames?: boolean
  maxToolResultChars?: number
  maxTotalToolResultChars?: number
  trace?: (event: unknown) => void
}

export type RunAgentTurnResult = {
  content: string
  messages: LlmMessage[]
}

export function createInitialMessages(systemPrompt: string): LlmMessage[] {
  return [{ role: "system", content: systemPrompt }]
}

export async function runAgentTurn(params: RunAgentTurnParams): Promise<RunAgentTurnResult> {
  const maxSteps = params.maxSteps ?? 8
  const toolNameMap = createToolNameMap(params.tools.all(), Boolean(params.sanitizeToolNames))
  const tools: LlmTool[] = toolNameMap.tools
  const maxToolResultChars = typeof params.maxToolResultChars === "number" ? params.maxToolResultChars : 20_000
  const maxTotalToolResultChars = typeof params.maxTotalToolResultChars === "number" ? params.maxTotalToolResultChars : 80_000
  let totalToolChars = 0

  if (params.systemPrompt) {
    if (params.messages.length && params.messages[0]?.role === "system") {
      params.messages[0] = { role: "system", content: params.systemPrompt }
    } else {
      params.messages.unshift({ role: "system", content: params.systemPrompt })
    }
  }

  params.messages.push({ role: "user", content: params.userInput })

  for (let step = 0; step < maxSteps; step++) {
    let streamedText = ""
    const llmStart = Date.now()
    const res = await params.provider.complete({
      model: params.model,
      messages: params.messages,
      tools,
      stream: params.stream ?? false,
      onStreamEvent: (ev) => {
        if (ev.type === "token") {
          streamedText += ev.text
          process.stdout.write(ev.text)
        }
      }
    })
    params.trace?.({
      type: "llm.complete",
      step,
      durationMs: Date.now() - llmStart,
      contentChars: res.content.length,
      toolCalls: res.toolCalls.map((tc) => ({ id: tc.id, name: tc.name }))
    })

    if (params.stream) {
      const needsNewline = streamedText.length > 0 && !streamedText.endsWith("\n")
      if (needsNewline) process.stdout.write("\n")
    }

    params.messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls })

    if (!res.toolCalls.length) return { content: res.content, messages: params.messages }

    for (const tc of res.toolCalls) {
      const toolMsg = await executeToolCall(
        tc,
        params.tools,
        params.workspace,
        params.confirm,
        toolNameMap.llmToInternal,
        {
          step,
          maxToolResultChars,
          maxTotalToolResultChars,
          totalToolChars,
          ...(params.trace ? { trace: params.trace } : {})
        }
      )
      totalToolChars += toolMsg.content.length
      params.messages.push(toolMsg)
      if (totalToolChars >= maxTotalToolResultChars) break
    }
  }

  return { content: "Agent stopped: max steps reached", messages: params.messages }
}

async function executeToolCall(
  tc: LlmToolCall,
  tools: ToolRegistry,
  workspace: Workspace,
  confirm?: ToolConfirmFn,
  llmToInternal?: Record<string, string>,
  limits?: {
    step: number
    maxToolResultChars: number
    maxTotalToolResultChars: number
    totalToolChars: number
    trace?: (event: unknown) => void
  }
): Promise<LlmMessage> {
  try {
    const internalName = llmToInternal?.[tc.name] ?? tc.name
    const ctx = { workspace, ...(confirm ? { confirm } : {}) }
    if (limits && limits.totalToolChars >= limits.maxTotalToolResultChars) {
      const content = stableJson({
        truncated: true,
        reason: "max total tool output reached"
      })
      limits.trace?.({ type: "tool.skip", step: limits.step, name: tc.name, internalName })
      return { role: "tool", toolCallId: tc.id, name: tc.name, content }
    }
    limits?.trace?.({
      type: "tool.call",
      step: limits.step,
      toolCallId: tc.id,
      name: tc.name,
      internalName,
      input: sanitizeForTrace(tc.input)
    })
    const toolStart = Date.now()
    const result = await tools.call(internalName, tc.input, ctx)
    const raw = stableJson(result)
    const limited =
      limits && raw.length > limits.maxToolResultChars
        ? stableJson({
            truncated: true,
            originalChars: raw.length,
            content: raw.slice(0, limits.maxToolResultChars)
          })
        : raw
    limits?.trace?.({
      type: "tool.result",
      step: limits.step,
      toolCallId: tc.id,
      durationMs: Date.now() - toolStart,
      name: tc.name,
      internalName,
      resultChars: limited.length,
      truncated: limited !== raw,
      rawChars: raw.length,
      rawHash: sha256(raw),
      rawPreview: truncateForTrace(raw),
      ...(limited !== raw ? { limitedHash: sha256(limited) } : {})
    })
    return { role: "tool", toolCallId: tc.id, name: tc.name, content: limited }
  } catch (err) {
    const content = stableJson({ error: err instanceof Error ? err.message : String(err) })
    limits?.trace?.({
      type: "tool.error",
      step: limits?.step,
      toolCallId: tc.id,
      name: tc.name,
      internalName: llmToInternal?.[tc.name] ?? tc.name,
      error: err instanceof Error ? err.message : String(err)
    })
    return {
      role: "tool",
      toolCallId: tc.id,
      name: tc.name,
      content
    }
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

function truncateForTrace(s: string, max = 200): string {
  const out = s.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim()
  if (out.length <= max) return out
  return `${out.slice(0, max)}…`
}

function sanitizeForTrace(v: unknown, depth = 0): unknown {
  if (depth >= 6) return "[Truncated]"
  if (v === null) return null
  if (typeof v === "string") return v.length > 2000 ? `${v.slice(0, 2000)}…` : v
  if (typeof v === "number" || typeof v === "boolean") return v
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitizeForTrace(x, depth + 1))
  if (typeof v === "object") {
    const out: Record<string, unknown> = {}
    const rec = v as Record<string, unknown>
    for (const [k, val] of Object.entries(rec)) {
      if (/key|token|secret|password/i.test(k)) out[k] = "[REDACTED]"
      else out[k] = sanitizeForTrace(val, depth + 1)
    }
    return out
  }
  return String(v)
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

function createToolNameMap(
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>,
  sanitize: boolean
): { tools: LlmTool[]; llmToInternal: Record<string, string> } {
  if (!sanitize) {
    const llmTools: LlmTool[] = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    const llmToInternal: Record<string, string> = Object.fromEntries(tools.map((t) => [t.name, t.name]))
    return { tools: llmTools, llmToInternal }
  }

  const llmToInternal: Record<string, string> = {}
  const used = new Set<string>()
  const llmTools: LlmTool[] = tools.map((t) => {
    const llmName = uniqueLlmToolName(sanitizeToolName(t.name), used)
    llmToInternal[llmName] = t.name
    return { name: llmName, description: t.description, inputSchema: t.inputSchema }
  })

  return { tools: llmTools, llmToInternal }
}

function sanitizeToolName(name: string): string {
  let out = name.replace(/[^a-zA-Z0-9_-]/g, "_")
  if (!/^[a-zA-Z]/.test(out)) out = `t_${out}`
  out = out.replace(/_+/g, "_")
  return out
}

function uniqueLlmToolName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  let i = 2
  while (used.has(`${name}_${i}`)) i++
  const out = `${name}_${i}`
  used.add(out)
  return out
}
