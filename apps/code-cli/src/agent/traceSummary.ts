import path from "node:path"

export type TraceEventRecord = {
  type: string
  [key: string]: unknown
}

type NamedCount = {
  name: string
  count: number
}

type SkillTraceSummary = {
  name: string
  source?: string
  invoked: number
  resolved: number
  activated: number
  cleared: number
  warnings: number
}

export type TraceSummary = {
  mode?: string
  workspace?: string
  eventCount: number
  turns: number
  llmCompletions: number
  toolCallCount: number
  toolErrorCount: number
  truncatedToolResults: number
  skillErrorCount: number
  durationMs?: number
  tools: NamedCount[]
  skillErrors: NamedCount[]
  toolErrors: NamedCount[]
  skills: SkillTraceSummary[]
}

function incrementCounter(map: Map<string, number>, name: string): void {
  map.set(name, (map.get(name) ?? 0) + 1)
}

function incrementSkillCounter(
  map: Map<string, SkillTraceSummary>,
  name: string,
  field: keyof Omit<SkillTraceSummary, "name" | "source">
): SkillTraceSummary {
  const current = map.get(name) ?? {
    name,
    invoked: 0,
    resolved: 0,
    activated: 0,
    cleared: 0,
    warnings: 0
  }
  current[field] += 1
  map.set(name, current)
  return current
}

function namedCounts(map: Map<string, number>): NamedCount[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count
      return left.name.localeCompare(right.name)
    })
}

export function parseJsonlTrace(raw: string): TraceEventRecord[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as TraceEventRecord
        return parsed && typeof parsed.type === "string" ? [parsed] : []
      } catch {
        return []
      }
    })
}

export function summarizeTraceEvents(events: TraceEventRecord[]): TraceSummary {
  const toolCounts = new Map<string, number>()
  const toolErrors = new Map<string, number>()
  const skillErrors = new Map<string, number>()
  const skills = new Map<string, SkillTraceSummary>()

  let mode: string | undefined
  let workspace: string | undefined
  let turns = 0
  let llmCompletions = 0
  let toolCallCount = 0
  let toolErrorCount = 0
  let truncatedToolResults = 0
  let skillErrorCount = 0
  let firstTs: number | undefined
  let lastTs: number | undefined

  for (const event of events) {
    const eventTs = typeof event.ts === "number" ? event.ts : undefined
    if (typeof eventTs === "number") {
      firstTs = firstTs === undefined ? eventTs : Math.min(firstTs, eventTs)
      lastTs = lastTs === undefined ? eventTs : Math.max(lastTs, eventTs)
    }

    if ((event.type === "run.start" || event.type === "chat.start") && typeof event.mode === "string") {
      mode = event.mode
    }
    if ((event.type === "run.start" || event.type === "chat.start") && typeof event.workspace === "string") {
      workspace = event.workspace
    }

    switch (event.type) {
      case "turn.start":
        turns += 1
        break
      case "llm.complete":
        llmCompletions += 1
        break
      case "tool.call": {
        toolCallCount += 1
        const name =
          typeof event.internalName === "string"
            ? event.internalName
            : typeof event.name === "string"
              ? event.name
              : "unknown"
        incrementCounter(toolCounts, name)
        break
      }
      case "tool.error": {
        toolErrorCount += 1
        const name =
          typeof event.internalName === "string"
            ? event.internalName
            : typeof event.name === "string"
              ? event.name
              : "unknown"
        incrementCounter(toolErrors, name)
        break
      }
      case "tool.result":
        if (event.truncated === true) truncatedToolResults += 1
        break
      case "skill.invoke":
        if (typeof event.requestedName === "string") {
          incrementSkillCounter(skills, event.requestedName, "invoked")
        }
        break
      case "skill.resolve":
        if (typeof event.skillName === "string") {
          const current = incrementSkillCounter(skills, event.skillName, "resolved")
          if (typeof event.source === "string") current.source = event.source
        }
        break
      case "skill.activate":
        if (typeof event.skillName === "string") {
          const current = incrementSkillCounter(skills, event.skillName, "activated")
          if (typeof event.source === "string") current.source = event.source
        }
        break
      case "skill.clear":
        if (typeof event.skillName === "string") {
          const current = incrementSkillCounter(skills, event.skillName, "cleared")
          if (typeof event.source === "string") current.source = event.source
        }
        break
      case "skill.render":
        if (typeof event.skillName === "string") {
          const current = skills.get(event.skillName) ?? {
            name: event.skillName,
            invoked: 0,
            resolved: 0,
            activated: 0,
            cleared: 0,
            warnings: 0
          }
          if (typeof event.source === "string") current.source = event.source
          if (typeof event.warningCount === "number") {
            current.warnings += event.warningCount
          }
          skills.set(event.skillName, current)
        }
        break
      case "skill.error": {
        skillErrorCount += 1
        const name =
          typeof event.skillName === "string"
            ? event.skillName
            : typeof event.requestedName === "string"
              ? event.requestedName
              : "unknown"
        incrementCounter(skillErrors, name)
        break
      }
    }
  }

  return {
    ...(mode ? { mode } : {}),
    ...(workspace ? { workspace } : {}),
    eventCount: events.length,
    turns,
    llmCompletions,
    toolCallCount,
    toolErrorCount,
    truncatedToolResults,
    skillErrorCount,
    ...(typeof firstTs === "number" && typeof lastTs === "number" ? { durationMs: Math.max(0, lastTs - firstTs) } : {}),
    tools: namedCounts(toolCounts),
    toolErrors: namedCounts(toolErrors),
    skillErrors: namedCounts(skillErrors),
    skills: [...skills.values()].sort((left, right) => left.name.localeCompare(right.name))
  }
}

export function formatTraceSummary(
  summary: TraceSummary,
  opts?: { filePath?: string }
): string {
  const lines: string[] = ["Trace Summary"]

  if (opts?.filePath) {
    lines.push(`File: ${opts.filePath}`)
  }
  if (summary.mode) {
    lines.push(`Mode: ${summary.mode}`)
  }
  if (summary.workspace) {
    lines.push(`Workspace: ${summary.workspace}`)
  }

  lines.push(
    `Events: ${summary.eventCount} | Turns: ${summary.turns} | LLM: ${summary.llmCompletions} | Tools: ${summary.toolCallCount} | Skills: ${summary.skills.length}`
  )

  if (typeof summary.durationMs === "number") {
    lines.push(`Duration: ${summary.durationMs}ms`)
  }

  if (summary.tools.length > 0) {
    lines.push("")
    lines.push("Tools:")
    for (const tool of summary.tools) {
      lines.push(`  ${tool.name} x${tool.count}`)
    }
  }

  if (summary.skills.length > 0) {
    lines.push("")
    lines.push("Skills:")
    for (const skill of summary.skills) {
      const source = skill.source ? ` [${skill.source}]` : ""
      lines.push(
        `  ${skill.name}${source} invoke:${skill.invoked} resolve:${skill.resolved} activate:${skill.activated} clear:${skill.cleared} warnings:${skill.warnings}`
      )
    }
  }

  if (summary.toolErrorCount > 0 || summary.skillErrorCount > 0 || summary.truncatedToolResults > 0) {
    lines.push("")
    lines.push("Issues:")
    lines.push(`  tool errors: ${summary.toolErrorCount}`)
    lines.push(`  skill errors: ${summary.skillErrorCount}`)
    lines.push(`  truncated tool results: ${summary.truncatedToolResults}`)

    for (const entry of summary.toolErrors) {
      lines.push(`  tool error detail: ${entry.name} x${entry.count}`)
    }
    for (const entry of summary.skillErrors) {
      lines.push(`  skill error detail: ${entry.name} x${entry.count}`)
    }
  }

  return `${lines.join("\n")}\n`
}

export function formatRelativeTraceFile(workspaceRoot: string, filePath: string): string {
  const relative = path.relative(workspaceRoot, filePath)
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative
  return filePath
}
