import { promises as fs } from "node:fs"
import path from "node:path"
import process from "node:process"
import { createInitialMessages, runAgentTurn } from "../agent/runAgent"
import { createProviderFromEnv } from "../llm/factory"
import { Workspace } from "../core/workspace"
import { createDefaultToolRegistry } from "../tools/defaultRegistry"

type LiveCase = {
  name: string
  prompt: string
  expectToolContains?: string
  expectOutputContains?: string
  expectOutputRegex?: string
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
  const tools = createDefaultToolRegistry()

  const systemPrompt =
    process.env.CODECLI_EVAL_SYSTEM_PROMPT ??
    "You are a coding agent. You MUST use tools when a tool can answer the question. Always call tools with correct JSON. Keep outputs concise."

  const sanitizeToolNames = shouldSanitizeToolNames(providerKind)

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

    const toolText = out.messages
      .filter((m) => m.role === "tool")
      .map((m) => `${m.name ?? ""}\n${m.content ?? ""}`)
      .join("\n")

    const okTool = typeof c.expectToolContains === "string" ? toolText.includes(c.expectToolContains) : true
    const okContains = typeof c.expectOutputContains === "string" ? out.content.includes(c.expectOutputContains) : true
    const okRegex =
      typeof c.expectOutputRegex === "string" ? new RegExp(c.expectOutputRegex).test(out.content.trim()) : true

    const ok = okTool && okContains && okRegex
    process.stdout.write(`${ok ? "PASS" : "FAIL"}\t${c.name}\n`)
    if (!ok) {
      failed++
      process.stdout.write(`output: ${out.content}\n`)
    }
  }

  if (failed) process.exit(1)
}

function shouldSanitizeToolNames(provider: string): boolean {
  const p = provider.toLowerCase()
  return p === "openai" || p === "openai-compatible" || p === "kimi" || p === "moonshot"
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
