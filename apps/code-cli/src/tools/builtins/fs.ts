import { promises as fs } from "node:fs"
import path from "node:path"
import { ToolDefinition } from "../types"

export const readFileTool: ToolDefinition<{ path: string }, { content: string }> = {
  name: "fs.readFile",
  description: "Read a UTF-8 text file from the workspace",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string" } },
    required: ["path"]
  },
  async invoke(input, ctx) {
    if (!input?.path) throw new Error("Missing input.path")
    const content = await ctx.workspace.readText(input.path)
    return { content }
  }
}

export const writeFileTool: ToolDefinition<{ path: string; content: string }, { ok: true }> = {
  name: "fs.writeFile",
  description: "Write a UTF-8 text file into the workspace",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"]
  },
  async invoke(input, ctx) {
    if (!input?.path) throw new Error("Missing input.path")
    if (typeof input.content !== "string") throw new Error("Missing input.content")
    await ctx.workspace.writeText(input.path, input.content)
    return { ok: true }
  }
}

export const applyPatchTool: ToolDefinition<{ path: string; patch: string }, { ok: true }> = {
  name: "fs.applyPatch",
  description: "Apply a unified diff patch to a UTF-8 text file in the workspace",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string" }, patch: { type: "string" } },
    required: ["path", "patch"]
  },
  async invoke(input, ctx) {
    if (!input?.path) throw new Error("Missing input.path")
    if (typeof input.patch !== "string") throw new Error("Missing input.patch")

    let original: string
    try {
      original = await ctx.workspace.readText(input.path)
    } catch {
      throw new Error("File not found")
    }

    const updated = applyUnifiedDiff(original, input.patch)
    await ctx.workspace.writeText(input.path, updated)
    return { ok: true }
  }
}

export const listFilesTool: ToolDefinition<
  { dir: string; recursive?: boolean; maxDepth?: number },
  { files: string[] }
> = {
  name: "fs.listFiles",
  description: "List files under a directory in the workspace",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      dir: { type: "string" },
      recursive: { type: "boolean" },
      maxDepth: { type: "number" }
    },
    required: ["dir"]
  },
  async invoke(input, ctx) {
    if (!input?.dir) throw new Error("Missing input.dir")
    const opts: { recursive?: boolean; maxDepth?: number } = { recursive: input.recursive ?? false }
    if (typeof input.maxDepth === "number") opts.maxDepth = input.maxDepth
    const files = await ctx.workspace.listFiles(input.dir, opts)
    return { files }
  }
}

type BatchReadEntry = {
  path: string
  content?: string
  error?: string
}

export const batchReadTool: ToolDefinition<
  { paths: string[]; maxTotalBytes?: number },
  { entries: BatchReadEntry[]; totalBytes: number; truncated: boolean }
> = {
  name: "fs.batchRead",
  description: "Read multiple UTF-8 text files at once, with an optional total byte limit",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      paths: { type: "array", items: { type: "string" } },
      maxTotalBytes: { type: "number" }
    },
    required: ["paths"]
  },
  async invoke(input, ctx) {
    const paths = Array.isArray(input.paths) ? input.paths : []
    const maxTotal = typeof input.maxTotalBytes === "number" ? input.maxTotalBytes : 200_000
    const entries: BatchReadEntry[] = []
    let totalBytes = 0

    for (const p of paths) {
      if (totalBytes >= maxTotal) break
      try {
        const content = await ctx.workspace.readText(p)
        if (totalBytes + content.length > maxTotal) {
          const e: BatchReadEntry = { path: p, error: "skipped: maxTotalBytes exceeded" }
          entries.push(e)
          continue
        }
        totalBytes += content.length
        entries.push({ path: p, content })
      } catch (err) {
        const e: BatchReadEntry = { path: p, error: err instanceof Error ? err.message : String(err) }
        entries.push(e)
      }
    }

    return { entries, totalBytes, truncated: totalBytes >= maxTotal }
  }
}

type BatchWriteEntry = { path: string; content: string }

export const batchWriteTool: ToolDefinition<
  { entries: BatchWriteEntry[]; rollbackOnError?: boolean },
  { written: string[]; failed: { path: string; error: string }[]; rolledBack: boolean }
> = {
  name: "fs.batchWrite",
  description:
    "Write multiple UTF-8 text files at once. By default (rollbackOnError=true) it is atomic: if any file fails, all previously written files in this batch are deleted (rolled back). Set rollbackOnError=false to write files independently.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"]
        }
      },
      rollbackOnError: { type: "boolean" }
    },
    required: ["entries"]
  },
  async invoke(input, ctx) {
    const entries: BatchWriteEntry[] = Array.isArray(input.entries) ? input.entries : []
    const rollbackOnError = input.rollbackOnError !== false
    const written: string[] = []
    const failed: { path: string; error: string }[] = []
    let rolledBack = false

    for (const entry of entries) {
      try {
        await ctx.workspace.writeText(entry.path, entry.content)
        written.push(entry.path)
      } catch (err) {
        failed.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) })
        if (rollbackOnError) {
          for (const wp of written) {
            try {
              await ctx.workspace.deleteFile(wp)
            } catch {}
          }
          written.length = 0
          rolledBack = true
          break
        }
      }
    }

    return { written, failed, rolledBack }
  }
}

type RenameEntry = { from: string; to: string }

export const renameTool: ToolDefinition<
  { from: string; to: string } | { pairs: RenameEntry[] },
  { renamed: { from: string; to: string }[]; failed: { from: string; error: string }[] }
> = {
  name: "fs.rename",
  description:
    "Rename or move a single file (from/to) or multiple files at once (pairs). Handles directory creation for the destination.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      pairs: {
        type: "array",
        items: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"]
        }
      }
    }
  },
  async invoke(input, ctx) {
    const pairs: RenameEntry[] = []
    if ("from" in input && "to" in input) {
      pairs.push({ from: input.from as string, to: input.to as string })
    } else if (Array.isArray(input.pairs)) {
      for (const p of input.pairs) {
        if (p.from && p.to) pairs.push({ from: p.from, to: p.to })
      }
    }

    const renamed: { from: string; to: string }[] = []
    const failed: { from: string; error: string }[] = []

    for (const pair of pairs) {
      try {
        await ctx.workspace.rename(pair.from, pair.to)
        renamed.push({ from: pair.from, to: pair.to })
      } catch (err) {
        failed.push({ from: pair.from, error: err instanceof Error ? err.message : String(err) })
      }
    }

    return { renamed, failed }
  }
}

export const deleteTool: ToolDefinition<{ path: string; recursive?: boolean }, { deleted: string; ok: true }> = {
  name: "fs.delete",
  description: "Delete a file or directory from the workspace. Set recursive=true to delete non-empty directories.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean" }
    },
    required: ["path"]
  },
  async invoke(input, ctx) {
    if (!input?.path) throw new Error("Missing input.path")
    await ctx.workspace.deleteFile(input.path, input.recursive ?? false)
    return { deleted: input.path, ok: true }
  }
}

export const copyTool: ToolDefinition<{ from: string; to: string }, { copied: string; ok: true }> = {
  name: "fs.copy",
  description: "Copy a file or directory to a new location within the workspace.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: { type: "string" },
      to: { type: "string" }
    },
    required: ["from", "to"]
  },
  async invoke(input, ctx) {
    if (!input?.from) throw new Error("Missing input.from")
    if (!input?.to) throw new Error("Missing input.to")
    await ctx.workspace.copyFile(input.from, input.to)
    return { copied: input.to, ok: true }
  }
}

export const symlinkTool: ToolDefinition<{ target: string; linkPath: string }, { linkPath: string; ok: true }> = {
  name: "fs.symlink",
  description: "Create a symbolic link at linkPath pointing to target (both must be inside the workspace).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      target: { type: "string" },
      linkPath: { type: "string" }
    },
    required: ["target", "linkPath"]
  },
  async invoke(input, ctx) {
    if (!input?.target) throw new Error("Missing input.target")
    if (!input?.linkPath) throw new Error("Missing input.linkPath")
    ctx.workspace.resolvePath(input.target)
    const linkAbs = ctx.workspace.resolvePath(input.linkPath)
    const targetAbs = ctx.workspace.resolvePath(input.target)
    await fs.symlink(targetAbs, linkAbs)
    return { linkPath: input.linkPath, ok: true }
  }
}

function applyUnifiedDiff(original: string, patch: string): string {
  const originalEndsWithNl = original.endsWith("\n")
  const origLines = splitLines(original)
  const patchLines = patch.replace(/\r\n/g, "\n").split("\n")

  const hunks: Array<{ oldStart: number; oldCount: number; lines: string[] }> = []
  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i] ?? ""
    if (line.startsWith("@@")) {
      const m = /^@@\s+-([0-9]+)(?:,([0-9]+))?\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/.exec(line)
      if (!m) throw new Error("Invalid patch hunk header")
      const oldStart = Number(m[1])
      const oldCount = typeof m[2] === "string" ? Number(m[2]) : 1
      const hunkLines: string[] = []
      i++
      for (; i < patchLines.length; i++) {
        const hl = patchLines[i] ?? ""
        if (hl.startsWith("@@")) {
          i--
          break
        }
        if (hl.startsWith("---") || hl.startsWith("+++")) continue
        if (hl.startsWith("\\ No newline at end of file")) continue
        if (!hl) {
          hunkLines.push(" ")
          continue
        }
        const tag = hl[0]
        if (tag !== " " && tag !== "+" && tag !== "-") break
        hunkLines.push(hl)
      }
      hunks.push({ oldStart, oldCount, lines: hunkLines })
    }
  }

  if (!hunks.length) throw new Error("Patch has no hunks")

  let cursor = 0
  const out: string[] = []

  for (const h of hunks) {
    const target = h.oldStart - 1
    if (target < 0) throw new Error("Invalid hunk location")
    while (cursor < target) {
      out.push(origLines[cursor] ?? "")
      cursor++
    }

    for (const hl of h.lines) {
      const tag = hl[0]
      const text = hl.slice(1)
      if (tag === " ") {
        const cur = origLines[cursor] ?? ""
        if (cur !== text) throw new Error("Patch context mismatch")
        out.push(cur)
        cursor++
      } else if (tag === "-") {
        const cur = origLines[cursor] ?? ""
        if (cur !== text) throw new Error("Patch removal mismatch")
        cursor++
      } else if (tag === "+") {
        out.push(text)
      }
    }
  }

  while (cursor < origLines.length) {
    out.push(origLines[cursor] ?? "")
    cursor++
  }

  const joined = out.join("\n")
  if (originalEndsWithNl) return joined.endsWith("\n") ? joined : `${joined}\n`
  return joined.endsWith("\n") ? joined.slice(0, -1) : joined
}

function splitLines(text: string): string[] {
  const norm = text.replace(/\r\n/g, "\n")
  const endsWithNl = norm.endsWith("\n")
  const parts = norm.split("\n")
  if (endsWithNl) parts.pop()
  return parts
}
