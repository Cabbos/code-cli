import { promises as fs } from "node:fs"
import path from "node:path"
import process from "node:process"
import { createDefaultToolRegistry } from "../tools/defaultRegistry"
import { Workspace } from "../core/workspace"
import { ToolPolicy } from "../tools/policy"
import { createHash } from "node:crypto"

type ReplayOptions = {
  traceFile: string
  workspaceRoot?: string
  allowWrites: boolean
  ignoreOutput: boolean
}

type TraceEvent = { type: string; [k: string]: unknown }

type ToolCallEvent = TraceEvent & {
  type: "tool.call"
  toolCallId: string
  internalName: string
  input: unknown
}

type ToolResultEvent = TraceEvent & {
  type: "tool.result"
  toolCallId: string
  internalName: string
  rawHash: string
  truncated?: boolean
}

type ToolErrorEvent = TraceEvent & {
  type: "tool.error"
  toolCallId: string
  internalName: string
  error: string
}

type RunStartEvent = TraceEvent & { type: "run.start"; workspace?: string }

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const baseDir = typeof process.env.INIT_CWD === "string" && process.env.INIT_CWD.length > 0 ? process.env.INIT_CWD : process.cwd()
  const absTrace = path.isAbsolute(opts.traceFile) ? opts.traceFile : path.resolve(baseDir, opts.traceFile)
  const raw = await fs.readFile(absTrace, "utf8")
  const events = parseJsonl(raw)

  const runStart = events.find((e): e is RunStartEvent => e.type === "run.start")
  const workspaceRoot =
    opts.workspaceRoot ?? (typeof runStart?.workspace === "string" ? runStart.workspace : baseDir)
  const policy: ToolPolicy = { readonly: !opts.allowWrites }
  const tools = createDefaultToolRegistry({ policy })
  const workspace = new Workspace({ rootDir: workspaceRoot })

  const calls = events.filter((e): e is ToolCallEvent => e.type === "tool.call")
  const resultsById = new Map<string, ToolResultEvent>()
  const errorsById = new Map<string, ToolErrorEvent>()

  for (const e of events) {
    if (e.type === "tool.result") {
      const tr = e as ToolResultEvent
      if (typeof tr.toolCallId === "string") resultsById.set(tr.toolCallId, tr)
    }
    if (e.type === "tool.error") {
      const te = e as ToolErrorEvent
      if (typeof te.toolCallId === "string") errorsById.set(te.toolCallId, te)
    }
  }

  let failed = 0
  for (const c of calls) {
    const id = c.toolCallId
    const expectedResult = resultsById.get(id)
    const expectedError = errorsById.get(id)
    const internalName = c.internalName
    const input = c.input

    let ok = true
    let actualHash: string | undefined
    let actualError: string | undefined

    try {
      const out = await tools.call(internalName, input, { workspace })
      const rawOut = JSON.stringify(out, null, 2)
      actualHash = sha256(rawOut)
      if (!opts.ignoreOutput && expectedResult) ok = actualHash === expectedResult.rawHash
      if (expectedError) ok = false
    } catch (err) {
      actualError = err instanceof Error ? err.message : String(err)
      if (expectedError) ok = actualError === expectedError.error
      else ok = false
    }

    process.stdout.write(`${ok ? "PASS" : "FAIL"}\t${internalName}\t${id}\n`)
    if (!ok) {
      failed++
      if (expectedResult) process.stdout.write(`expectedHash: ${expectedResult.rawHash}\n`)
      if (typeof actualHash === "string") process.stdout.write(`actualHash: ${actualHash}\n`)
      if (expectedError) process.stdout.write(`expectedError: ${expectedError.error}\n`)
      if (typeof actualError === "string") process.stdout.write(`actualError: ${actualError}\n`)
    }
  }

  if (failed) process.exit(1)
}

function parseArgs(args: string[]): ReplayOptions {
  let traceFile = ""
  let workspaceRoot: string | undefined
  let allowWrites = false
  let ignoreOutput = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--trace" || a === "--trace-file") {
      traceFile = args[i + 1] ?? ""
      i++
      continue
    }
    if (a === "--workspace") {
      workspaceRoot = args[i + 1]
      i++
      continue
    }
    if (a === "--allow-writes") {
      allowWrites = true
      continue
    }
    if (a === "--ignore-output") {
      ignoreOutput = true
      continue
    }
  }

  if (!traceFile) throw new Error("Missing --trace <file>")
  return {
    traceFile,
    ...(typeof workspaceRoot === "string" ? { workspaceRoot } : {}),
    allowWrites,
    ignoreOutput
  }
}

function parseJsonl(raw: string): TraceEvent[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n").filter(Boolean)
  const out: TraceEvent[] = []
  for (const line of lines) {
    try {
      const v = JSON.parse(line) as TraceEvent
      if (v && typeof v.type === "string") out.push(v)
    } catch {}
  }
  return out
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
