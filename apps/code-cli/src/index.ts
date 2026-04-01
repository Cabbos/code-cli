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
import { LlmMessage } from "./llm/types"
import { bundledSkills } from "./skills/bundled"
import { loadProjectSkills, loadUserSkills } from "./skills/loader"
import { initFeatureFlags, isFeatureEnabled } from "./skills/featureFlags"

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
  .command("skills")
  .description("List available skills")
  .option("--source <source>", "Filter by source: bundled|project|user")
  .action(async (opts: { source?: string }) => {
    await resolveConfig()
    const workspaceRoot = (program.opts() as GlobalOpts).workspace

    process.stdout.write(chalk.bold("\nAvailable Skills:\n"))
    process.stdout.write(chalk.dim("=".repeat(50)) + "\n")

    const showBundled = !opts.source || opts.source === "bundled"
    if (showBundled) {
      const availableBundledSkills = bundledSkills.filter(isSkillAvailable)
      if (availableBundledSkills.length > 0) {
        process.stdout.write(chalk.bold("\n[Bundled]\n"))
        for (const skill of availableBundledSkills) {
          process.stdout.write(chalk.green(`  ${skill.name}`) + chalk.dim(` - ${skill.description}\n`))
          if (skill.arguments && skill.arguments.length > 0) {
            const argsStr = skill.arguments.map((a) => `${a.name}${a.required ? "*" : "?"}`).join(", ")
            process.stdout.write(chalk.dim(`    args: ${argsStr}\n`))
          }
        }
      }
    }

    const showProject = !opts.source || opts.source === "project"
    if (showProject) {
      const projectSkills = await loadProjectSkills(workspaceRoot)
      if (projectSkills.length > 0) {
        process.stdout.write(chalk.bold("\n[Project]\n"))
        for (const skill of projectSkills) {
          process.stdout.write(chalk.cyan(`  ${skill.name}`) + chalk.dim(` - ${skill.description}\n`))
        }
      }
    }

    const showUser = !opts.source || opts.source === "user"
    if (showUser) {
      const userSkills = await loadUserSkills()
      if (userSkills.length > 0) {
        process.stdout.write(chalk.bold("\n[User]\n"))
        for (const skill of userSkills) {
          process.stdout.write(chalk.magenta(`  ${skill.name}`) + chalk.dim(` - ${skill.description}\n`))
        }
      }
    }

    process.stdout.write("\n")
    process.stdout.write(chalk.dim("Use Skill in chat mode to invoke a listed skill.\n"))
    process.stdout.write(chalk.dim("Create skills in .code-cli/skills/<name>/SKILL.md\n"))
  })

program
  .command("skill:create")
  .description("Create a new skill from a template")
  .argument("<name>", "Skill name (kebab-case)")
  .argument("<description>", "One-line description")
  .option("--path <path>", "Directory to create skill in", ".code-cli/skills")
  .action(async (name: string, description: string, opts: { path: string }) => {
    const { promises: fs } = await import("node:fs")
    const g = program.opts() as GlobalOpts
    const workspaceRoot = g.workspace
    const skillDir = path.join(workspaceRoot, opts.path, name)
    const skillFile = path.join(skillDir, "SKILL.md")

    // Check if already exists
    try {
      await fs.readFile(skillFile, "utf8")
      process.stdout.write(chalk.red(`Skill "${name}" already exists at ${skillFile}\n`))
      return
    } catch {}

    // Create directory
    try {
      await fs.mkdir(skillDir, { recursive: true })
    } catch (err: any) {
      if (err.code !== "EEXIST") {
        process.stdout.write(chalk.red(`Failed to create directory: ${err.message}\n`))
        return
      }
    }

    const content = createSkillTemplate(name, description)

    try {
      await fs.writeFile(skillFile, content, "utf8")
      process.stdout.write(chalk.green(`Created skill: ${name}\n`))
      process.stdout.write(chalk.dim(`  Path: ${skillFile}\n`))
    } catch (err: any) {
      process.stdout.write(chalk.red(`Failed to create skill: ${err.message}\n`))
    }
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
    const defaultStream = process.stdin.isTTY
    const isStream = opts.stream !== false ? defaultStream : opts.stream
    const traceHistory: Array<{ step: number; name: string; resultChars: number; truncated: boolean }> = []

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

    let interrupted = false
    const interruptHandler = () => {
      interrupted = true
      process.stdout.write(chalk.yellow("\n[Interrupted] Saving session...\n"))
    }
    process.on("SIGINT", interruptHandler)

    try {
      while (true) {
        if (interrupted) {
          await store.save(session)
          process.stdout.write(chalk.green(`\nSession saved: ${session.id}\n`))
          process.stdout.write(chalk.dim(`Use :resume ${session.id} to continue\n`))
          break
        }

        const line = (await rl.question(chalk.cyan("> "))).trim()
        if (!line) continue

        if (line === ":q" || line === ":quit" || line === ":exit") {
          await store.save(session)
          process.stdout.write(chalk.green(`Session saved: ${session.id}\n`))
          break
        }

        if (line.startsWith(":resume ") || line === ":resume") {
          const targetId = line.split(" ")[1] ?? session.id
          try {
            const target = await store.load(targetId)
            session.messages = target.messages
            session.updatedAt = target.updatedAt
            process.stdout.write(chalk.green(`Resumed session: ${targetId} (${target.messages.length} messages)\n`))
            continue
          } catch {
            process.stdout.write(chalk.red(`Session not found: ${targetId}\n`))
            continue
          }
        }

        if (line === ":continue") {
          const lastUser = findLastUserMessage(session.messages)
          if (lastUser) {
            session.messages.pop()
            process.stdout.write(chalk.dim(`Continuing from: "${lastUser.content.slice(0, 50)}..."\n`))
          } else {
            process.stdout.write(chalk.yellow("No previous message to continue from\n"))
            continue
          }
        }

        if (line === ":retry") {
          const lastFailed = findLastFailedToolResult(session.messages)
          if (lastFailed) {
            const userMsg = findPreviousUserMessage(session.messages, lastFailed)
            if (userMsg) {
              session.messages = session.messages.slice(0, session.messages.indexOf(userMsg) + 1)
              process.stdout.write(chalk.dim(`Retrying last failed tool call\n`))
            } else {
              process.stdout.write(chalk.yellow("Could not find context to retry\n"))
              continue
            }
          } else {
            process.stdout.write(chalk.yellow("No failed tool calls to retry\n"))
            continue
          }
        }

        if (line === ":trace") {
          printTraceSummary(traceHistory)
          continue
        }

        if (line === ":help" || line === ":?") {
          printHelp()
          continue
        }

        trace?.({ type: "turn.start", ts: Date.now(), inputPreview: truncateForTrace(line) })
        const out = await runAgentTurn({
          provider,
          model,
          workspace,
          tools,
          messages: session.messages,
          userInput: line,
          ...(typeof systemPrompt === "string" ? { systemPrompt } : {}),
          ...(isStream !== undefined ? { stream: isStream } : {}),
          ...(typeof opts.maxSteps === "number" ? { maxSteps: opts.maxSteps } : {}),
          ...(typeof opts.maxToolOutput === "number" ? { maxToolResultChars: opts.maxToolOutput } : {}),
          ...(typeof opts.maxTotalToolOutput === "number" ? { maxTotalToolResultChars: opts.maxTotalToolOutput } : {}),
          ...(confirm ? { confirm } : {}),
          ...(trace ? { trace } : {}),
          ...(shouldSanitizeToolNames(config.llm.provider) ? { sanitizeToolNames: true } : {})
        })

        const toolCallsInTurn = out.messages.filter(
          (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0
        ).length
        if (toolCallsInTurn > 0) {
          traceHistory.push({
            step: traceHistory.length,
            name: "turn",
            resultChars: out.content.length,
            truncated: false
          })
          if (traceHistory.length > 20) traceHistory.shift()
        }

        trace?.({
          type: "turn.end",
          ts: Date.now(),
          outputChars: out.content.length,
          outputPreview: truncateForTrace(out.content),
          messageCount: out.messages.length
        })
        await store.save(session)
        if (!isStream) process.stdout.write(`${out.content}\n`)
      }
    } finally {
      process.removeListener("SIGINT", interruptHandler)
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

  const config = await loadConfig({
    workspaceRoot: g.workspace,
    ...(typeof g.config === "string" ? { configPath: g.config } : {}),
    overrides
  })

  initFeatureFlags(config.features?.flags)
  return config
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

function isSkillAvailable(skill: { name: string; isEnabled?: () => boolean }): boolean {
  if (skill.isEnabled && !skill.isEnabled()) return false
  return isFeatureEnabled(skill.name)
}

function createSkillTemplate(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
---

# ${name}

${description}

## Arguments

Add bullet lines here if the skill accepts arguments.
Format:
- argument_name (required): Description
- optional_name [default: value]: Description

## Prompt

\`\`\`text
You are a ${name} expert.

User request:
{{user_message}}

{{#if code}}
Relevant code:
{{code}}
{{/if}}

Respond with the result.
\`\`\`
`
}

function truncateForTrace(s: string, max = 200): string {
  const out = s.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim()
  if (out.length <= max) return out
  return `${out.slice(0, max)}…`
}

function findLastUserMessage(messages: LlmMessage[]): LlmMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === "user") return m
  }
  return null
}

function findLastFailedToolResult(messages: LlmMessage[]): LlmMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === "tool") {
      try {
        const parsed = JSON.parse(m.content)
        if (parsed?.error) return m
      } catch {}
    }
  }
  return null
}

function findPreviousUserMessage(messages: LlmMessage[], toolMsg: LlmMessage): LlmMessage | null {
  const idx = messages.indexOf(toolMsg)
  for (let i = idx - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === "user") return m
  }
  return null
}

type TraceEntry = { step: number; name: string; resultChars: number; truncated: boolean }

function printTraceSummary(history: TraceEntry[]): void {
  if (history.length === 0) {
    process.stdout.write(chalk.dim("No trace history\n"))
    return
  }
  process.stdout.write(chalk.bold("\nTrace Summary:\n"))
  for (const entry of history) {
    const icon = entry.truncated ? chalk.yellow("⚠") : chalk.green("✓")
    process.stdout.write(`${icon} Step ${entry.step}: ${entry.name} (${entry.resultChars} chars)\n`)
  }
  process.stdout.write("\n")
}

function printHelp(): void {
  process.stdout.write(chalk.bold("\nAvailable commands:\n"))
  process.stdout.write("  :q, :quit, :exit    Exit and save session\n")
  process.stdout.write("  :resume [id]        Resume a session by id\n")
  process.stdout.write("  :continue           Continue from last user message\n")
  process.stdout.write("  :retry              Retry last failed tool call\n")
  process.stdout.write("  :trace              Show trace summary\n")
  process.stdout.write("  :help, :?          Show this help\n")
  process.stdout.write("\n")
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
