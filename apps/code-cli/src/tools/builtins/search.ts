import { execFile } from "node:child_process"
import { ToolDefinition } from "../types"

type SearchInput = {
  pattern: string
  dir?: string
  recursive?: boolean
  maxDepth?: number
  maxResults?: number
  caseSensitive?: boolean
  regex?: boolean
}

type SearchMatch = {
  path: string
  line: number
  col: number
  preview: string
}

export const searchRgTool: ToolDefinition<SearchInput, { matches: SearchMatch[]; truncated: boolean }> = {
  name: "search.rg",
  description: "Search for text in workspace files using ripgrep (rg) with JS fallback",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      pattern: { type: "string" },
      dir: { type: "string" },
      recursive: { type: "boolean" },
      maxDepth: { type: "number" },
      maxResults: { type: "number" },
      caseSensitive: { type: "boolean" },
      regex: { type: "boolean" }
    },
    required: ["pattern"]
  },
  invoke: async (input, ctx) => {
    const dir = input.dir ?? "."
    const maxResults = typeof input.maxResults === "number" ? input.maxResults : 50
    const caseSensitive = input.caseSensitive ?? false
    const useRegex = input.regex ?? false

    const cwd = ctx.workspace.root
    const args: string[] = []

    if (!caseSensitive) args.push("-i")
    if (useRegex) args.push("--regex")
    else args.push("-F")
    args.push("--json", input.pattern)

    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile("rg", args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err && !stdout) {
            reject(err)
          } else {
            resolve(stdout)
          }
        })
      })

      const matches = parseRgJsonOutput(output, maxResults)
      return { matches, truncated: matches.length >= maxResults }
    } catch {
      return fallbackSearch(input, ctx, dir, maxResults, caseSensitive, useRegex)
    }
  }
}

async function fallbackSearch(
  input: SearchInput,
  ctx: { workspace: { listFiles: Function; readText: Function } },
  dir: string,
  maxResults: number,
  caseSensitive: boolean,
  useRegex: boolean
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  const recursive = input.recursive ?? true
  const maxDepth = typeof input.maxDepth === "number" ? input.maxDepth : 20

  const files = await ctx.workspace.listFiles(dir, { recursive, maxDepth })
  const matches: SearchMatch[] = []

  const needle = caseSensitive ? input.pattern : input.pattern.toLowerCase()
  const re = useRegex ? new RegExp(input.pattern, caseSensitive ? "g" : "gi") : undefined

  for (const relPath of files) {
    if (matches.length >= maxResults) break

    let text: string
    try {
      text = await ctx.workspace.readText(relPath)
    } catch {
      continue
    }

    const hay = caseSensitive ? text : text.toLowerCase()

    if (!useRegex) {
      let from = 0
      while (true) {
        const idx = hay.indexOf(needle, from)
        if (idx === -1) break
        const { line, col, preview } = locate(text, idx)
        matches.push({ path: relPath, line, col, preview })
        if (matches.length >= maxResults) break
        from = idx + Math.max(1, needle.length)
      }
      continue
    }

    if (!re) continue
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const idx = m.index
      const { line, col, preview } = locate(text, idx)
      matches.push({ path: relPath, line, col, preview })
      if (matches.length >= maxResults) break
      if (m[0].length === 0) re.lastIndex++
    }
  }

  return { matches, truncated: matches.length >= maxResults }
}

function parseRgJsonOutput(output: string, maxResults: number): SearchMatch[] {
  const matches: SearchMatch[] = []
  const lines = output.split("\n").filter(Boolean)

  for (const line of lines) {
    if (matches.length >= maxResults) break
    try {
      const entry = JSON.parse(line)
      if (entry.type !== "match") continue
      const data = entry.data
      matches.push({
        path: data.path?.text ?? data.path ?? "",
        line: data.line_number ?? 0,
        col: data.columns?.start ?? 0,
        preview: (data.lines?.text ?? "").trim().slice(0, 300)
      })
    } catch {
      continue
    }
  }

  return matches
}

function locate(text: string, idx: number): { line: number; col: number; preview: string } {
  const before = text.slice(0, idx)
  const line = before.split("\n").length
  const lastNl = before.lastIndexOf("\n")
  const col = idx - (lastNl === -1 ? 0 : lastNl + 1) + 1
  const start = lastNl === -1 ? 0 : lastNl + 1
  const endNl = text.indexOf("\n", idx)
  const end = endNl === -1 ? text.length : endNl
  const preview = text.slice(start, end).slice(0, 300)
  return { line, col, preview }
}
