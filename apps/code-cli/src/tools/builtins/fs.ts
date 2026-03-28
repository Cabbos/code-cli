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
