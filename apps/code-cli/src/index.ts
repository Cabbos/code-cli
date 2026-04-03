#!/usr/bin/env node
import { Command } from "commander"
import chalk from "chalk"
import pkg from "../package.json"
import { createProvider } from "./llm/factory"
import { createDefaultToolRegistry } from "./tools/defaultRegistry"
import { Workspace } from "./core/workspace"
import { createInitialMessages, runAgentTurn } from "./agent/runAgent"
import { createJsonlTraceWriter } from "./agent/trace"
import {
  formatRelativeTraceFile,
  formatTraceSummary,
  parseJsonlTrace,
  summarizeTraceEvents,
  TraceEventRecord
} from "./agent/traceSummary"
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
import { listAllSkills } from "./skills/SkillTool"
import {
  formatSkillDoctorReport,
  inspectNonBundledSkills,
  inspectSkillDefinition
} from "./skills/doctor"
import {
  exportSkillToDir,
  installSkillToScope,
  resolveSkillExportRoot,
  resolveSkillInstallRoot,
  resolveSkillInstallSource,
  SkillInstallScope
} from "./skills/install"

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
  .option("--verbose", "Show extra skill metadata")
  .action(async (opts: { source?: string; verbose?: boolean }) => {
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
          printSkillLine(skill, chalk.green, Boolean(opts.verbose))
        }
      }
    }

    const showProject = !opts.source || opts.source === "project"
    if (showProject) {
      const projectSkills = await loadProjectSkills(workspaceRoot)
      if (projectSkills.length > 0) {
        process.stdout.write(chalk.bold("\n[Project]\n"))
        for (const skill of projectSkills) {
          printSkillLine(skill, chalk.cyan, Boolean(opts.verbose))
        }
      }
    }

    const showUser = !opts.source || opts.source === "user"
    if (showUser) {
      const userSkills = await loadUserSkills()
      if (userSkills.length > 0) {
        process.stdout.write(chalk.bold("\n[User]\n"))
        for (const skill of userSkills) {
          printSkillLine(skill, chalk.magenta, Boolean(opts.verbose))
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
  .command("skill:install")
  .description("Install a skill from a bundled skill name, installed skill name, or local path")
  .argument("<source>", "Bundled skill name, installed skill name, skill directory, or SKILL.md path")
  .option("--scope <scope>", "Install scope: project|user", "project")
  .option("--force", "Overwrite an existing destination if it already exists")
  .action(async (source: string, opts: { scope: SkillInstallScope; force?: boolean }) => {
    try {
      const config = await resolveConfig()
      const workspaceRoot = (program.opts() as GlobalOpts).workspace
      const availableSkills = await listAllSkills(workspaceRoot, bundledSkills.filter(isSkillAvailable))
      const normalizedScope = opts.scope === "user" ? "user" : "project"

      const resolvedSource = await resolveSkillInstallSource(source, workspaceRoot, availableSkills)
      const installRoot = resolveSkillInstallRoot(normalizedScope, workspaceRoot)
      const destinationDir = path.join(installRoot, resolvedSource.skill.name)
      const installed = await installSkillToScope(resolvedSource, destinationDir, {
        force: Boolean(opts.force)
      })

      process.stdout.write(chalk.green(`Installed skill: ${installed.skill.name}\n`))
      process.stdout.write(chalk.dim(`  from: ${resolvedSource.displayName}\n`))
      process.stdout.write(chalk.dim(`  scope: ${normalizedScope}\n`))
      process.stdout.write(chalk.dim(`  path: ${installed.skillFile}\n`))

      const knownToolNames = createDefaultToolRegistry({ policy: toToolPolicy(config) })
        .list()
        .map((tool) => tool.name)
      const doctorReport = inspectSkillDefinition(
        {
          ...installed.skill,
          source: normalizedScope,
          sourcePath: installed.skillFile
        },
        knownToolNames
      )

      if (doctorReport.findings.length > 0) {
        process.stdout.write(chalk.yellow("\nSkill Doctor Warnings\n"))
        process.stdout.write(chalk.dim("=".repeat(50)) + "\n")
        for (const finding of doctorReport.findings) {
          const colorize = finding.severity === "error" ? chalk.red : chalk.yellow
          process.stdout.write(colorize(`  ${finding.severity}: ${finding.message}\n`))
        }
      }
    } catch (error) {
      process.stdout.write(chalk.red(`${error instanceof Error ? error.message : String(error)}\n`))
      process.exitCode = 1
    }
  })

program
  .command("skill:export")
  .description("Export a skill to a shareable directory")
  .argument("<source>", "Bundled skill name, installed skill name, skill directory, or SKILL.md path")
  .option("--out <path>", "Destination directory (defaults to .code-cli/exports/skills/<name>)")
  .option("--force", "Overwrite an existing destination if it already exists")
  .action(async (source: string, opts: { out?: string; force?: boolean }) => {
    try {
      const workspaceRoot = (program.opts() as GlobalOpts).workspace
      await resolveConfig()
      const availableSkills = await listAllSkills(workspaceRoot, bundledSkills.filter(isSkillAvailable))

      const resolvedSource = await resolveSkillInstallSource(source, workspaceRoot, availableSkills)
      const destinationDir = opts.out
        ? path.resolve(workspaceRoot, opts.out)
        : path.join(resolveSkillExportRoot(workspaceRoot), resolvedSource.skill.name)
      const exported = await exportSkillToDir(resolvedSource, destinationDir, {
        force: Boolean(opts.force)
      })

      process.stdout.write(chalk.green(`Exported skill: ${exported.skill.name}\n`))
      process.stdout.write(chalk.dim(`  from: ${resolvedSource.displayName}\n`))
      process.stdout.write(chalk.dim(`  path: ${destinationDir}\n`))
      process.stdout.write(chalk.dim(`  install with: ccode skill:install ${destinationDir}\n`))
    } catch (error) {
      process.stdout.write(chalk.red(`${error instanceof Error ? error.message : String(error)}\n`))
      process.exitCode = 1
    }
  })

program
  .command("skill:inspect")
  .description("Inspect a single available skill")
  .argument("<name>", "Skill name")
  .option("--full-prompt", "Show the full prompt instead of a preview")
  .action(async (name: string, opts: { fullPrompt?: boolean }) => {
    await resolveConfig()
    const workspaceRoot = (program.opts() as GlobalOpts).workspace
    const availableSkills = await listAllSkills(workspaceRoot, bundledSkills.filter(isSkillAvailable))
    const skill = availableSkills.find((entry) => entry.name === name)

    if (!skill) {
      process.stdout.write(chalk.red(`Skill not found: ${name}\n`))
      process.exitCode = 1
      return
    }

    process.stdout.write(chalk.bold(`\nSkill: ${skill.name}\n`))
    process.stdout.write(`Source: ${skill.source}\n`)
    process.stdout.write(`Description: ${skill.description}\n`)
    if (skill.arguments && skill.arguments.length > 0) {
      const args = skill.arguments
        .map((arg) => `${arg.name}${arg.required ? "*" : ""}${arg.default ? `=${arg.default}` : ""}`)
        .join(", ")
      process.stdout.write(`Arguments: ${args}\n`)
    }
    if (skill.allowedTools && skill.allowedTools.length > 0) {
      process.stdout.write(`Allowed tools: ${skill.allowedTools.join(", ")}\n`)
    }
    if (skill.paths && skill.paths.length > 0) {
      process.stdout.write(`Paths: ${skill.paths.join(", ")}\n`)
    }
    if (skill.sourcePath) {
      process.stdout.write(`Path: ${skill.sourcePath}\n`)
    }

    const promptText = opts.fullPrompt ? skill.prompt : previewPrompt(skill.prompt)
    process.stdout.write("\nPrompt:\n")
    process.stdout.write(`${promptText}\n`)
    if (!opts.fullPrompt && promptText !== skill.prompt) {
      process.stdout.write(chalk.dim("(prompt preview truncated, use --full-prompt to show all)\n"))
    }
  })

program
  .command("skill:doctor")
  .description("Validate skills and report common issues")
  .argument("[name]", "Optional skill name to validate")
  .action(async (name?: string) => {
    const config = await resolveConfig()
    const workspaceRoot = (program.opts() as GlobalOpts).workspace
    const knownToolNames = createDefaultToolRegistry({ policy: toToolPolicy(config) })
      .list()
      .map((tool) => tool.name)

    const bundledReports = bundledSkills.map((skill) => inspectSkillDefinition(skill, knownToolNames))
    const nonBundledReports = await inspectNonBundledSkills(workspaceRoot, knownToolNames)
    const reports = [...bundledReports, ...nonBundledReports]
      .filter((report) => !name || report.name === name)
      .sort((left, right) => {
        const sourceOrder = { bundled: 0, project: 1, user: 2 }
        const orderDelta = sourceOrder[left.source] - sourceOrder[right.source]
        if (orderDelta !== 0) return orderDelta
        return left.name.localeCompare(right.name)
      })

    if (reports.length === 0) {
      process.stdout.write(chalk.red(`No skills found${name ? ` for "${name}"` : ""}\n`))
      process.exitCode = 1
      return
    }

    process.stdout.write(chalk.bold("\nSkill Doctor\n"))
    process.stdout.write(chalk.dim("=".repeat(50)) + "\n")

    let okCount = 0
    let warningCount = 0
    let errorCount = 0

    for (const report of reports) {
      const hasError = report.findings.some((finding) => finding.severity === "error")
      const hasWarning = report.findings.some((finding) => finding.severity === "warning")
      if (hasError) errorCount += 1
      else if (hasWarning) warningCount += 1
      else okCount += 1

      const status = hasError ? "ERROR" : hasWarning ? "WARN" : "OK"
      const colorize = hasError ? chalk.red : hasWarning ? chalk.yellow : chalk.green
      const formatted = formatSkillDoctorReport(report)
      const [header, ...rest] = formatted.split("\n")
      process.stdout.write(colorize(header ?? "") + "\n")
      if (rest.length > 0) {
        process.stdout.write(rest.join("\n") + "\n")
      }
    }

    process.stdout.write(
      `\nSummary: ${chalk.green(`${okCount} ok`)}, ${chalk.yellow(`${warningCount} warnings`)}, ${chalk.red(`${errorCount} errors`)}\n`
    )

    if (errorCount > 0) {
      process.exitCode = 1
    }
  })

const traceCmd = program.command("trace").description("Inspect trace output")

traceCmd
  .command("summary")
  .description("Summarize a JSONL trace file")
  .argument("<file>", "Path to a JSONL trace file")
  .action(async (file: string) => {
    const { promises: fs } = await import("node:fs")
    await resolveConfig()
    const workspaceRoot = (program.opts() as GlobalOpts).workspace
    const workspace = new Workspace({ rootDir: workspaceRoot })
    const filePath = path.isAbsolute(file) ? file : workspace.resolvePath(file)
    const raw = await fs.readFile(filePath, "utf8")
    const summary = summarizeTraceEvents(parseJsonlTrace(raw))
    process.stdout.write(
      formatTraceSummary(summary, {
        filePath: formatRelativeTraceFile(workspaceRoot, filePath)
      })
    )
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
    const traceEvents: TraceEventRecord[] = []
    const trace = (event: unknown) => {
      traceEvents.push(event as TraceEventRecord)
      if (traceEvents.length > 500) traceEvents.shift()
      traceWriter?.write(event)
    }
    const defaultStream = process.stdin.isTTY
    const isStream = opts.stream !== false ? defaultStream : opts.stream

    trace({
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
          printTraceSummary(traceEvents)
          continue
        }

        if (line === ":help" || line === ":?") {
          printHelp()
          continue
        }

        trace({ type: "turn.start", ts: Date.now(), inputPreview: truncateForTrace(line) })
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
          trace,
          ...(shouldSanitizeToolNames(config.llm.provider) ? { sanitizeToolNames: true } : {})
        })

        trace({
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
      trace({ type: "chat.end", mode: "chat", ts: Date.now(), sessionId: session.id, messageCount: session.messages.length })
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

function printSkillLine(
  skill: {
    name: string
    description: string
    arguments?: Array<{ name: string; required?: boolean }>
    allowedTools?: string[]
    paths?: string[]
    sourcePath?: string
  },
  colorize: (value: string) => string,
  verbose: boolean
): void {
  process.stdout.write(colorize(`  ${skill.name}`) + chalk.dim(` - ${skill.description}\n`))

  if (skill.arguments && skill.arguments.length > 0) {
    const argsStr = skill.arguments.map((a) => `${a.name}${a.required ? "*" : "?"}`).join(", ")
    process.stdout.write(chalk.dim(`    args: ${argsStr}\n`))
  }

  if (!verbose) return

  if (skill.allowedTools && skill.allowedTools.length > 0) {
    process.stdout.write(chalk.dim(`    allowed tools: ${skill.allowedTools.join(", ")}\n`))
  }
  if (skill.paths && skill.paths.length > 0) {
    process.stdout.write(chalk.dim(`    paths: ${skill.paths.join(", ")}\n`))
  }
  if (skill.sourcePath) {
    process.stdout.write(chalk.dim(`    path: ${skill.sourcePath}\n`))
  }
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

function previewPrompt(prompt: string, maxLines = 12): string {
  const lines = prompt.replace(/\r\n/g, "\n").split("\n")
  if (lines.length <= maxLines) return prompt
  return `${lines.slice(0, maxLines).join("\n")}\n...`
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

function printTraceSummary(events: TraceEventRecord[]): void {
  if (events.length === 0) {
    process.stdout.write(chalk.dim("No trace history\n"))
    return
  }
  process.stdout.write(`\n${formatTraceSummary(summarizeTraceEvents(events))}`)
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
