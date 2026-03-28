import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { ToolDefinition } from "../types"

const execFileAsync = promisify(execFile)

type GitDiffInput = {
  staged?: boolean
  paths?: string[]
  contextLines?: number
  maxBytes?: number
}

type GitStatusInput = {
  paths?: string[]
  includeUntracked?: boolean
  maxBytes?: number
}

type GitStatusEntry = {
  x: string
  y: string
  path: string
}

export const gitDiffTool: ToolDefinition<GitDiffInput, { isRepo: boolean; diff: string; truncated: boolean }> = {
  name: "git.diff",
  description: "Show git diff for the workspace (optionally staged, optionally scoped to paths)",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      staged: { type: "boolean" },
      paths: { type: "array", items: { type: "string" } },
      contextLines: { type: "number" },
      maxBytes: { type: "number" }
    }
  },
  invoke: async (input, ctx) => {
    const cwd = ctx.workspace.resolvePath(".")
    const maxBytes = typeof input.maxBytes === "number" ? input.maxBytes : 200_000
    const contextLines = typeof input.contextLines === "number" ? input.contextLines : 3
    const staged = input.staged ?? false

    const isRepo = await isGitRepo(cwd)
    if (!isRepo) return { isRepo: false, diff: "", truncated: false }

    const args: string[] = ["diff", `-U${contextLines}`]
    if (staged) args.push("--staged")

    if (Array.isArray(input.paths) && input.paths.length > 0) {
      const safePaths = input.paths.map((p) => {
        ctx.workspace.resolvePath(p)
        return p
      })
      args.push("--", ...safePaths)
    }

    const { stdout, truncated } = await execWithLimit("git", args, { cwd, maxBytes })
    return { isRepo: true, diff: stdout, truncated }
  }
}

export const gitStatusTool: ToolDefinition<
  GitStatusInput,
  {
    isRepo: boolean
    branch?: string
    ahead?: number
    behind?: number
    entries: GitStatusEntry[]
    raw: string
    truncated: boolean
  }
> = {
  name: "git.status",
  description: "Show git status for the workspace (porcelain format)",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      paths: { type: "array", items: { type: "string" } },
      includeUntracked: { type: "boolean" },
      maxBytes: { type: "number" }
    }
  },
  invoke: async (input, ctx) => {
    const cwd = ctx.workspace.resolvePath(".")
    const maxBytes = typeof input.maxBytes === "number" ? input.maxBytes : 100_000
    const includeUntracked = input.includeUntracked ?? true

    const isRepo = await isGitRepo(cwd)
    if (!isRepo) return { isRepo: false, entries: [], raw: "", truncated: false }

    const args: string[] = ["status", "--porcelain=v1", "-b"]
    if (!includeUntracked) args.push("-uno")

    if (Array.isArray(input.paths) && input.paths.length > 0) {
      const safePaths = input.paths.map((p) => {
        ctx.workspace.resolvePath(p)
        return p
      })
      args.push("--", ...safePaths)
    }

    const { stdout, truncated } = await execWithLimit("git", args, { cwd, maxBytes })
    const parsed = parseStatus(stdout)
    return { isRepo: true, raw: stdout, truncated, ...parsed }
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const res = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd })
    return res.stdout.trim() === "true"
  } catch {
    return false
  }
}

function parseStatus(raw: string): {
  branch?: string
  ahead?: number
  behind?: number
  entries: GitStatusEntry[]
} {
  const lines = raw.replace(/\r\n/g, "\n").split("\n").filter(Boolean)
  let branch: string | undefined
  let ahead: number | undefined
  let behind: number | undefined

  const entries: GitStatusEntry[] = []

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const s = line.slice(3)
      const m = /^([^.\s]+)(?:\.\.\.[^\s]+)?(?:\s+\[(.+)\])?$/.exec(s)
      if (m) {
        branch = m[1]
        const meta = m[2]
        if (meta) {
          const a = /ahead\s+([0-9]+)/.exec(meta)
          const b = /behind\s+([0-9]+)/.exec(meta)
          if (a) ahead = Number(a[1])
          if (b) behind = Number(b[1])
        }
      } else {
        branch = s.trim()
      }
      continue
    }

    if (line.length >= 3) {
      const x = line[0] ?? " "
      const y = line[1] ?? " "
      const path = line.slice(3)
      entries.push({ x, y, path })
    }
  }

  return {
    entries,
    ...(typeof branch === "string" ? { branch } : {}),
    ...(typeof ahead === "number" ? { ahead } : {}),
    ...(typeof behind === "number" ? { behind } : {})
  }
}

async function execWithLimit(
  file: string,
  args: string[],
  opts: { cwd: string; maxBytes: number }
): Promise<{ stdout: string; truncated: boolean }> {
  try {
    const res = await execFileAsync(file, args, { cwd: opts.cwd, maxBuffer: opts.maxBytes })
    return { stdout: res.stdout, truncated: false }
  } catch (err) {
    if (err instanceof Error) {
      const anyErr = err as { stdout?: string; message: string; code?: unknown }
      if (typeof anyErr.stdout === "string" && anyErr.stdout.length > 0) {
        return { stdout: anyErr.stdout, truncated: true }
      }
      throw new Error(anyErr.message)
    }
    throw err
  }
}
