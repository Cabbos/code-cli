#!/usr/bin/env node
import { Command } from "commander"
import chalk from "chalk"
import pkg from "../package.json"
import { createProvider } from "./llm/factory"
import { createDefaultToolRegistry } from "./tools/defaultRegistry"
import { Workspace } from "./core/workspace"
import { createInitialMessages, runAgentTurn } from "./agent/runAgent"
import { createJsonlTraceWriter } from "./agent/trace"
import readline from "node:readline/promises"
import process from "node:process"
import path from "node:path"
import { loadConfig } from "./config/loadConfig"
import { CodeCliConfig, CodeCliConfigOverrides } from "./config/types"
import { SessionStore } from "./session/store"
import { ToolPolicy } from "./tools/policy"

type PackageJson = {
  name?: string
  version?: string
  description?: string
}

type GlobalOpts = {
  workspace: string
  config?: string
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  sessionDir?: string
  readonly?: boolean
  confirmWrites?: boolean
  systemPrompt?: string
}

const program = new Command()
const meta = pkg as PackageJson

function resolvedProgramName(): string {
  const invoked = path.basename(process.argv[1] ?? "")
  if (invoked === "index.js") return "code-cli"
  if (invoked === "ccode.js") return "ccode"
  return invoked || meta.name || "code-cli"
}

program
  .name(resolvedProgramName())
  .description(meta.description ?? "A CLI starter project")
  .version(meta.version ?? "0.0.0")
  .option("-w, --workspace <dir>", "Workspace root directory", process.cwd())
  .option("-c, --config <path>", "Path to config.json")
  .option("--provider <name>", "LLM provider (mock|openai|openai-compatible)")
  .option("--model <name>", "LLM model name")
  .option("--base-url <url>", "OpenAI-compatible base URL")
  .option("--api-key <key>", "API key (prefer env)")
  .option("--session-dir <dir>", "Sessions directory")
  .option("--readonly", "Disable write tools")
  .option("--confirm-writes", "Ask before fs.writeFile")
  .option("--system-prompt <text>", "Override system prompt")

program
  .command("hello")
  .description("Print a greeting")
  .option("-n, --name <name>", "Name to greet", "world")
  .action((opts: { name: string }) => {
    process.stdout.write(chalk.green(`hello ${opts.name}\n`))
  })

program
  .command("tools")
  .description("List available tools")
  .action(async () => {
    const config = await resolveConfig()
    const tools = createDefaultToolRegistry({ policy: toToolPolicy(config) }).list()
    for (const t of tools) process.stdout.write(`${t.name}\t${t.description}\n`)
  })

program
  .command("run")
  .description("Run a single prompt through the agent")
  .argument("<prompt...>", "Prompt text")
  .option("--no-stream", "Disable streaming output")
  .option("--max-steps <n>", "Max tool-call iterations", (v) => Number(v), 8)
  .option("--max-tool-output <n>", "Max chars per tool result", (v) => Number(v))
  .option("--max-total-tool-output <n>", "Max chars across tool results in one turn", (v) => Number(v))
  .option("--trace", "Write JSONL trace to a file")
  .option("--trace-file <path>", "Trace output file path")
  .action(
    async (
      promptParts: string[],
      opts: {
        stream: boolean
        maxSteps: number
        maxToolOutput?: number
        maxTotalToolOutput?: number
        trace?: boolean
        traceFile?: string
      }
    ) => {
    const config = await resolveConfig()
    const { provider, model } = createProvider(config.llm)
    const root = (program.opts() as GlobalOpts).workspace
    const workspace = new Workspace({ rootDir: root })
    const tools = createDefaultToolRegistry({ policy: toToolPolicy(config) })
    const prompt = promptParts.join(" ")
    const messages = createInitialMessages(config.agent.systemPrompt ?? "You are a coding agent.")
    const confirm = await createConfirmFn({ enabled: Boolean(config.tools.confirmWrites) })
    const traceWriter =
      opts.trace || typeof opts.traceFile === "string"
        ? await createJsonlTraceWriter(opts.traceFile ?? defaultTraceFile(root, `run-${Date.now()}.jsonl`))
        : undefined
    const trace = traceWriter ? traceWriter.write : undefined
    trace?.({
      type: "run.start",
      mode: "run",
      ts: Date.now(),
      provider: config.llm.provider,
      model,
      workspace: root,
      maxSteps: opts.maxSteps,
      ...(typeof opts.maxToolOutput === "number" ? { maxToolResultChars: opts.maxToolOutput } : {}),
      ...(typeof opts.maxTotalToolOutput === "number" ? { maxTotalToolResultChars: opts.maxTotalToolOutput } : {}),
      promptPreview: truncateForTrace(prompt)
    })
    try {
      const out = await runAgentTurn({
        provider,
        model,
        workspace,
        tools,
        messages,
        userInput: prompt,
        ...(typeof config.agent.systemPrompt === "string" ? { systemPrompt: config.agent.systemPrompt } : {}),
        ...(typeof opts.stream === "boolean" ? { stream: opts.stream } : {}),
        ...(typeof opts.maxSteps === "number" ? { maxSteps: opts.maxSteps } : {}),
        ...(typeof opts.maxToolOutput === "number" ? { maxToolResultChars: opts.maxToolOutput } : {}),
        ...(typeof opts.maxTotalToolOutput === "number" ? { maxTotalToolResultChars: opts.maxTotalToolOutput } : {}),
        ...(confirm ? { confirm } : {}),
        ...(trace ? { trace } : {}),
        ...(shouldSanitizeToolNames(config.llm.provider) ? { sanitizeToolNames: true } : {})
      })
      if (!opts.stream) process.stdout.write(`${out.content}\n`)
      trace?.({
        type: "run.end",
        mode: "run",
        ts: Date.now(),
        outputChars: out.content.length,
        outputPreview: truncateForTrace(out.content),
        messageCount: out.messages.length
      })
    } finally {
      if (traceWriter) await traceWriter.close()
    }
  })

program
  .command("chat")
  .description("Interactive chat loop")
  .option("--session <id>", "Resume an existing session id")
  .option("--no-stream", "Disable streaming output")
  .option("--max-steps <n>", "Max tool-call iterations per turn", (v) => Number(v), 8)
  .option("--max-tool-output <n>", "Max chars per tool result", (v) => Number(v))
  .option("--max-total-tool-output <n>", "Max chars across tool results in one turn", (v) => Number(v))
  .option("--trace", "Write JSONL trace to a file")
  .option("--trace-file <path>", "Trace output file path")
  .action(
    async (opts: {
      session?: string
      stream: boolean
      maxSteps: number
      maxToolOutput?: number
      maxTotalToolOutput?: number
      trace?: boolean
      traceFile?: string
    }) => {
    const config = await resolveConfig()
    const { provider, model } = createProvider(config.llm)
    const root = (program.opts() as GlobalOpts).workspace
    const workspace = new Workspace({ rootDir: root })
    const tools = createDefaultToolRegistry({ policy: toToolPolicy(config) })
    const store = new SessionStore({ dir: config.sessions.dir ?? ".code-cli/sessions" })
    const systemPrompt = config.agent.systemPrompt ?? "You are a coding agent."
    const session = opts.session
      ? await store.load(opts.session)
      : await store.create(createInitialMessages(systemPrompt))

    process.stdout.write(chalk.dim(`session: ${session.id}\n`))
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const confirm = await createConfirmFn({ enabled: Boolean(config.tools.confirmWrites) })
    const traceWriter =
      opts.trace || typeof opts.traceFile === "string"
        ? await createJsonlTraceWriter(opts.traceFile ?? defaultTraceFile(root, `chat-${session.id}.jsonl`))
        : undefined
    const trace = traceWriter ? traceWriter.write : undefined
    trace?.({
      type: "chat.start",
      mode: "chat",
      ts: Date.now(),
      sessionId: session.id,
      provider: config.llm.provider,
      model,
      workspace: root,
      maxSteps: opts.maxSteps,
      ...(typeof opts.maxToolOutput === "number" ? { maxToolResultChars: opts.maxToolOutput } : {}),
      ...(typeof opts.maxTotalToolOutput === "number" ? { maxTotalToolResultChars: opts.maxTotalToolOutput } : {})
    })
    try {
      while (true) {
        const line = (await rl.question(chalk.cyan("> "))).trim()
        if (!line) continue
        if (line === ":q" || line === ":quit" || line === ":exit") break
        trace?.({ type: "turn.start", ts: Date.now(), inputPreview: truncateForTrace(line) })
        const out = await runAgentTurn({
          provider,
          model,
          workspace,
          tools,
          messages: session.messages,
          userInput: line,
          ...(typeof systemPrompt === "string" ? { systemPrompt } : {}),
          ...(typeof opts.stream === "boolean" ? { stream: opts.stream } : {}),
          ...(typeof opts.maxSteps === "number" ? { maxSteps: opts.maxSteps } : {}),
          ...(typeof opts.maxToolOutput === "number" ? { maxToolResultChars: opts.maxToolOutput } : {}),
          ...(typeof opts.maxTotalToolOutput === "number" ? { maxTotalToolResultChars: opts.maxTotalToolOutput } : {}),
          ...(confirm ? { confirm } : {}),
          ...(trace ? { trace } : {}),
          ...(shouldSanitizeToolNames(config.llm.provider) ? { sanitizeToolNames: true } : {})
        })
        trace?.({
          type: "turn.end",
          ts: Date.now(),
          outputChars: out.content.length,
          outputPreview: truncateForTrace(out.content),
          messageCount: out.messages.length
        })
        await store.save(session)
        if (!opts.stream) process.stdout.write(`${out.content}\n`)
      }
    } finally {
      rl.close()
      trace?.({ type: "chat.end", mode: "chat", ts: Date.now(), sessionId: session.id, messageCount: session.messages.length })
      if (traceWriter) await traceWriter.close()
    }
  })

const sessionCmd = program.command("session").description("Manage sessions")

sessionCmd.command("list").description("List sessions").action(async () => {
  const config = await resolveConfig()
  const store = new SessionStore({ dir: config.sessions.dir ?? ".code-cli/sessions" })
  const rows = await store.list()
  for (const r of rows) process.stdout.write(`${r.id}\t${r.updatedAt}\t${r.messageCount}\n`)
})

sessionCmd
  .command("export")
  .description("Export a session as JSON")
  .argument("<id>", "Session id")
  .option("--out <path>", "Write to a file instead of stdout")
  .action(async (id: string, opts: { out?: string }) => {
    const config = await resolveConfig()
    const store = new SessionStore({ dir: config.sessions.dir ?? ".code-cli/sessions" })
    const json = await store.export(id)
    if (opts.out) {
      const ws = new Workspace({ rootDir: (program.opts() as GlobalOpts).workspace })
      await ws.writeText(opts.out, json)
      process.stdout.write(`${opts.out}\n`)
      return
    }
    process.stdout.write(`${json}\n`)
  })

async function resolveConfig(): Promise<CodeCliConfig> {
  const g = program.opts() as GlobalOpts
  const overrides: CodeCliConfigOverrides = {}

  if (
    g.provider ||
    g.model ||
    g.baseUrl ||
    g.apiKey ||
    typeof g.sessionDir === "string" ||
    typeof g.readonly === "boolean" ||
    typeof g.confirmWrites === "boolean" ||
    typeof g.systemPrompt === "string"
  ) {
    overrides.llm = {
      ...(g.provider ? { provider: g.provider } : {}),
      ...(g.model ? { model: g.model } : {}),
      ...(g.baseUrl ? { baseUrl: g.baseUrl } : {}),
      ...(g.apiKey ? { apiKey: g.apiKey } : {})
    }
    overrides.sessions = { ...(g.sessionDir ? { dir: g.sessionDir } : {}) }
    overrides.tools = {
      ...(typeof g.readonly === "boolean" ? { readonly: g.readonly } : {}),
      ...(typeof g.confirmWrites === "boolean" ? { confirmWrites: g.confirmWrites } : {})
    }
    overrides.agent = { ...(typeof g.systemPrompt === "string" ? { systemPrompt: g.systemPrompt } : {}) }
  }

  return loadConfig({
    workspaceRoot: g.workspace,
    ...(typeof g.config === "string" ? { configPath: g.config } : {}),
    overrides
  })
}

function toToolPolicy(config: CodeCliConfig): ToolPolicy {
  const p: ToolPolicy = {}
  if (typeof config.tools.readonly === "boolean") p.readonly = config.tools.readonly
  if (Array.isArray(config.tools.allow)) p.allow = config.tools.allow
  if (Array.isArray(config.tools.deny)) p.deny = config.tools.deny
  if (typeof config.tools.confirmWrites === "boolean") p.confirmWrites = config.tools.confirmWrites
  return p
}

function shouldSanitizeToolNames(provider: string): boolean {
  const p = provider.toLowerCase()
  return p === "openai" || p === "openai-compatible" || p === "kimi" || p === "moonshot"
}

function defaultTraceFile(workspaceRoot: string, basename: string): string {
  return path.join(workspaceRoot, ".code-cli", "traces", basename)
}

function truncateForTrace(s: string, max = 200): string {
  const out = s.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim()
  if (out.length <= max) return out
  return `${out.slice(0, max)}…`
}

async function createConfirmFn(opts: { enabled: boolean }) {
  if (!opts.enabled) return undefined
  if (!process.stdin.isTTY) return async () => false
  return async (req: { name: string; input: unknown }) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const preview = JSON.stringify(req.input)
    const q = chalk.yellow(`allow tool ${req.name}? ${preview} (y/N) `)
    const ans = (await rl.question(q)).trim().toLowerCase()
    rl.close()
    return ans === "y" || ans === "yes"
  }
}

program.parse(process.argv)
