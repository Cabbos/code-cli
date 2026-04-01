import { promises as fs } from "node:fs"
import path from "node:path"
import process from "node:process"
import { createInitialMessages, runAgentTurn } from "../agent/runAgent"
import { createProviderFromEnv } from "../llm/factory"
import { Workspace } from "../core/workspace"
import { createDefaultToolRegistry } from "../tools/defaultRegistry"
import { initFeatureFlags } from "../skills/featureFlags"

type JsonType = "string" | "number" | "boolean" | "null" | "array" | "object"

type ToolJsonExpectation = {
  tool: string
  path: string
  type?: JsonType
  equals?: string | number | boolean | null
  contains?: string
  regex?: string
}

type LiveCase = {
  name: string
  prompt: string
  expectToolContains?: string
  expectOutputContains?: string
  expectOutputRegex?: string
  requireTools?: string[]
  minToolCalls?: number
  maxToolCalls?: number
  allowToolError?: boolean
  expectToolJson?: ToolJsonExpectation[]
}

type CaseFile = {
  cases: LiveCase[]
}

async function main() {
  const root = process.cwd()
  const filePath = path.join(root, "evals", "live-cases.json")
  const raw = await fs.readFile(filePath, "utf8")
  const data = JSON.parse(raw) as CaseFile

  const providerKind = (process.env.CODECLI_PROVIDER ?? "mock").toLowerCase()
  if (providerKind === "mock") {
    process.stdout.write("SKIP\tlive eval requires a real provider (set CODECLI_PROVIDER and CODECLI_API_KEY)\n")
    return
  }
  if (!process.env.CODECLI_API_KEY) {
    throw new Error("Missing CODECLI_API_KEY for live eval")
  }

  const { provider, model } = createProviderFromEnv()
  const workspaceRoot = process.env.CODECLI_EVAL_WORKSPACE ?? root
  const workspace = new Workspace({ rootDir: workspaceRoot })
  initFeatureFlags()
  const tools = createDefaultToolRegistry()

  const systemPrompt =
    process.env.CODECLI_EVAL_SYSTEM_PROMPT ??
    "You are a coding agent. You MUST use tools when a tool can answer the question. Always call tools with correct JSON. Keep outputs concise."

  const sanitizeToolNames = shouldSanitizeToolNames(providerKind)
  const nameMap = createToolNameMap(tools.all(), sanitizeToolNames)

  let failed = 0
  for (const c of data.cases) {
    const messages = createInitialMessages(systemPrompt)
    const out = await runAgentTurn({
      provider,
      model,
      workspace,
      tools,
      messages,
      userInput: c.prompt,
      stream: false,
      maxSteps: 8,
      ...(sanitizeToolNames ? { sanitizeToolNames: true } : {})
    })

    const toolCalls = out.messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : []))
    const toolCallsInternal = toolCalls.map((tc) => nameMap.llmToInternal[tc.name] ?? tc.name)
    const toolCallCount = toolCallsInternal.length

    const toolMsgs = out.messages.filter((m) => m.role === "tool")
    const toolResults = toolMsgs.map((m) => {
      const internalName = nameMap.llmToInternal[m.name] ?? m.name
      const parsed = safeJsonParse(m.content)
      return {
        llmName: m.name,
        internalName,
        parsedOk: parsed.ok,
        parsedValue: parsed.ok ? parsed.value : undefined,
        parsedError: parsed.ok ? undefined : parsed.error
      }
    })

    const toolText = out.messages
      .filter((m) => m.role === "tool")
      .map((m) => `${m.name ?? ""}\n${m.content ?? ""}`)
      .join("\n")

    const requiredTools = Array.isArray(c.requireTools) ? c.requireTools : []
    const minToolCalls =
      typeof c.minToolCalls === "number" ? c.minToolCalls : requiredTools.length > 0 ? requiredTools.length : 0
    const maxToolCalls = typeof c.maxToolCalls === "number" ? c.maxToolCalls : undefined

    const okMinToolCalls = toolCallCount >= minToolCalls
    const okMaxToolCalls = typeof maxToolCalls === "number" ? toolCallCount <= maxToolCalls : true
    const okRequiredTools = requiredTools.every((t) => toolCallsInternal.includes(t))

    const toolErrors = toolResults.filter((r) => {
      if (!r.parsedOk) return true
      const v = r.parsedValue
      return isRecord(v) && typeof v.error === "string" && v.error.length > 0
    })
    const okToolNoError = c.allowToolError ? true : toolErrors.length === 0

    const jsonExpectations = Array.isArray(c.expectToolJson) ? c.expectToolJson : []
    const okToolJson = jsonExpectations.every((e) => {
      const results = toolResults.filter((r) => r.internalName === e.tool && r.parsedOk)
      if (!results.length) return false
      return results.some((r) => {
        const v = getPath(r.parsedValue, e.path)
        if (typeof e.type === "string" && !matchesType(v, e.type)) return false
        if (Object.prototype.hasOwnProperty.call(e, "equals") && v !== e.equals) return false
        if (typeof e.contains === "string") {
          if (typeof v !== "string") return false
          if (!v.includes(e.contains)) return false
        }
        if (typeof e.regex === "string") {
          if (typeof v !== "string") return false
          if (!new RegExp(e.regex).test(v)) return false
        }
        return true
      })
    })

    const okTool = typeof c.expectToolContains === "string" ? toolText.includes(c.expectToolContains) : true
    const okContains = typeof c.expectOutputContains === "string" ? out.content.includes(c.expectOutputContains) : true
    const okRegex =
      typeof c.expectOutputRegex === "string" ? new RegExp(c.expectOutputRegex).test(out.content.trim()) : true

    const ok =
      okTool &&
      okContains &&
      okRegex &&
      okMinToolCalls &&
      okMaxToolCalls &&
      okRequiredTools &&
      okToolNoError &&
      okToolJson
    process.stdout.write(`${ok ? "PASS" : "FAIL"}\t${c.name}\n`)
    if (!ok) {
      failed++
      process.stdout.write(`output: ${truncate(out.content, 2000)}\n`)
      process.stdout.write(`toolCalls: ${toolCallsInternal.join(", ")}\n`)
      if (toolErrors.length) {
        process.stdout.write(
          `toolErrors: ${truncate(
            JSON.stringify(
              toolErrors.map((t) => ({
                tool: t.internalName,
                llmName: t.llmName,
                parsedOk: t.parsedOk,
                parsedError: t.parsedError
              })),
              null,
              2
            ),
            2000
          )}\n`
        )
      }
    }
  }

  if (failed) process.exit(1)
}

function shouldSanitizeToolNames(provider: string): boolean {
  const p = provider.toLowerCase()
  return p === "openai" || p === "openai-compatible" || p === "kimi" || p === "moonshot"
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

function safeJsonParse(s: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function matchesType(v: unknown, t: JsonType): boolean {
  if (t === "null") return v === null
  if (t === "array") return Array.isArray(v)
  if (t === "object") return isRecord(v)
  return typeof v === t
}

function getPath(v: unknown, pathExpr: string): unknown {
  const tokens = tokenizePath(pathExpr)
  let cur: unknown = v
  for (const t of tokens) {
    if (typeof t === "string") {
      if (!isRecord(cur)) return undefined
      cur = cur[t]
      continue
    }
    if (!Array.isArray(cur)) return undefined
    cur = cur[t]
  }
  return cur
}

function tokenizePath(p: string): Array<string | number> {
  const out: Array<string | number> = []
  const re = /([^[.\]]+)|\[(\d+)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(p))) {
    if (m[1]) out.push(m[1])
    else if (m[2]) out.push(Number(m[2]))
  }
  return out
}

function createToolNameMap(
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>,
  sanitize: boolean
): { internalToLlm: Record<string, string>; llmToInternal: Record<string, string> } {
  if (!sanitize) {
    const internalToLlm: Record<string, string> = Object.fromEntries(tools.map((t) => [t.name, t.name]))
    const llmToInternal: Record<string, string> = Object.fromEntries(tools.map((t) => [t.name, t.name]))
    return { internalToLlm, llmToInternal }
  }

  const internalToLlm: Record<string, string> = {}
  const llmToInternal: Record<string, string> = {}
  const used = new Set<string>()
  for (const t of tools) {
    const llmName = uniqueLlmToolName(sanitizeToolName(t.name), used)
    internalToLlm[t.name] = llmName
    llmToInternal[llmName] = t.name
  }
  return { internalToLlm, llmToInternal }
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

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
