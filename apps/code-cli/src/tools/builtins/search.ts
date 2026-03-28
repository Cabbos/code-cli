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
  description: "Search for text in workspace files",
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
    const recursive = input.recursive ?? true
    const maxDepth = typeof input.maxDepth === "number" ? input.maxDepth : 20
    const maxResults = typeof input.maxResults === "number" ? input.maxResults : 50
    const caseSensitive = input.caseSensitive ?? false
    const useRegex = input.regex ?? false

    const files = await ctx.workspace.listFiles(dir, { recursive, maxDepth })
    const matches: SearchMatch[] = []
    let truncated = false

    const needle = caseSensitive ? input.pattern : input.pattern.toLowerCase()
    const re = useRegex ? new RegExp(input.pattern, caseSensitive ? "g" : "gi") : undefined

    for (const relPath of files) {
      if (matches.length >= maxResults) {
        truncated = true
        break
      }

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
          if (matches.length >= maxResults) {
            truncated = true
            break
          }
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
        if (matches.length >= maxResults) {
          truncated = true
          break
        }
        if (m[0].length === 0) re.lastIndex++
      }
    }

    return { matches, truncated }
  }
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
