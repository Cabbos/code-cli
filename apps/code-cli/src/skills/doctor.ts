import os from "node:os"
import path from "node:path"
import { promises as fs } from "node:fs"
import { hasShellCommands } from "./shellExecution"
import { SkillDefinition } from "./types"
import { loadSkillFromFile } from "./loader"

export type SkillDoctorFinding = {
  severity: "error" | "warning"
  message: string
}

export type SkillDoctorReport = {
  name: string
  source: SkillDefinition["source"]
  sourcePath?: string
  findings: SkillDoctorFinding[]
}

const TEMPLATE_TAG_PATTERN = /\{\{([^}]+)\}\}/g
const VALID_SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/

type ParsedTemplateTag =
  | { kind: "placeholder"; name: string }
  | { kind: "if_open"; name: string }
  | { kind: "if_close" }
  | { kind: "unsupported"; raw: string }

function parseTemplateTags(prompt: string): ParsedTemplateTag[] {
  const tags: ParsedTemplateTag[] = []

  for (const match of prompt.matchAll(TEMPLATE_TAG_PATTERN)) {
    const rawContent = match[1] ?? ""
    const raw = rawContent.trim()
    if (rawContent !== raw) {
      tags.push({ kind: "unsupported", raw: rawContent })
      continue
    }
    const ifOpenMatch = raw.match(/^#if\s+([A-Za-z_][A-Za-z0-9_]*)$/)
    if (ifOpenMatch?.[1]) {
      tags.push({ kind: "if_open", name: ifOpenMatch[1] })
      continue
    }
    if (raw === "/if") {
      tags.push({ kind: "if_close" })
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
      tags.push({ kind: "placeholder", name: raw })
      continue
    }
    tags.push({ kind: "unsupported", raw })
  }

  return tags
}

function stableRuntimeVariables(skill: SkillDefinition): Set<string> {
  const names = new Set<string>(["user_message", "code", "language"])

  switch (skill.name) {
    case "debug":
      names.add("problem")
      names.add("error")
      break
    case "remember":
      names.add("content")
      break
    case "skillify":
      names.add("conversation")
      break
  }

  return names
}

export function inspectSkillDefinition(
  skill: SkillDefinition,
  knownToolNames: string[]
): SkillDoctorReport {
  const findings: SkillDoctorFinding[] = []
  const templateTags = parseTemplateTags(skill.prompt)
  const runtimeVariables = stableRuntimeVariables(skill)
  const argumentNames = new Set((skill.arguments ?? []).map((arg) => arg.name))
  const seenArgumentNames = new Set<string>()
  let ifDepth = 0

  if (!VALID_SKILL_NAME_PATTERN.test(skill.name)) {
    findings.push({
      severity: "warning",
      message: `Skill name "${skill.name}" is not kebab-case; prefer names like "review-typescript".`
    })
  }

  for (const arg of skill.arguments ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.name)) {
      findings.push({
        severity: "error",
        message: `Argument "${arg.name}" is not a valid identifier.`
      })
    }
    if (seenArgumentNames.has(arg.name)) {
      findings.push({
        severity: "error",
        message: `Argument "${arg.name}" is declared more than once.`
      })
    }
    seenArgumentNames.add(arg.name)
  }

  for (const tag of templateTags) {
    if (tag.kind === "unsupported") {
      findings.push({
        severity: "error",
        message: `Unsupported template tag "{{${tag.raw}}}". Only {{name}} and {{#if name}}...{{/if}} are supported.`
      })
      continue
    }

    if (tag.kind === "if_open") {
      ifDepth += 1
    } else if (tag.kind === "if_close") {
      ifDepth -= 1
      if (ifDepth < 0) {
        findings.push({
          severity: "error",
          message: "Found {{/if}} without a matching opening {{#if ...}} block."
        })
        ifDepth = 0
      }
      continue
    }

    const name = tag.name
    if (!argumentNames.has(name) && !runtimeVariables.has(name)) {
      findings.push({
        severity: "warning",
        message: `Template variable "${name}" is not declared in ## Arguments and is not a known runtime variable. Declare it if the skill expects user input.`
      })
    }
  }

  if (ifDepth > 0) {
    findings.push({
      severity: "error",
      message: `Found ${ifDepth} unterminated {{#if ...}} block(s).`
    })
  }

  for (const toolName of skill.allowedTools ?? []) {
    if (!knownToolNames.includes(toolName)) {
      findings.push({
        severity: "error",
        message: `Unknown tool "${toolName}" in allowed-tools.`
      })
    }
  }

  if (hasShellCommands(skill.prompt)) {
    findings.push({
      severity: "warning",
      message: "Prompt contains shell interpolation. It stays inactive unless skill_shell_execution is explicitly enabled."
    })
  }

  return {
    name: skill.name,
    source: skill.source,
    ...(skill.sourcePath ? { sourcePath: skill.sourcePath } : {}),
    findings
  }
}

async function findSkillFiles(skillsRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(skillsRoot, entry.name, "SKILL.md"))
  } catch {
    return []
  }
}

export async function inspectSkillFile(
  filePath: string,
  source: SkillDefinition["source"],
  knownToolNames: string[]
): Promise<SkillDoctorReport> {
  try {
    const skill = await loadSkillFromFile(filePath)
    return inspectSkillDefinition(skill, knownToolNames)
  } catch (error) {
    return {
      name: path.basename(path.dirname(filePath)),
      source,
      sourcePath: filePath,
      findings: [
        {
          severity: "error",
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    }
  }
}

export async function inspectNonBundledSkills(
  workspaceRoot: string,
  knownToolNames: string[]
): Promise<SkillDoctorReport[]> {
  const projectRoot = path.join(workspaceRoot, ".code-cli", "skills")
  const userRoot = path.join(os.homedir(), ".code-cli", "skills")

  const [projectFiles, userFiles] = await Promise.all([findSkillFiles(projectRoot), findSkillFiles(userRoot)])
  const reports = await Promise.all([
    ...projectFiles.map((filePath) => inspectSkillFile(filePath, "project", knownToolNames)),
    ...userFiles.map((filePath) => inspectSkillFile(filePath, "user", knownToolNames))
  ])

  return reports.sort((left, right) => {
    if (left.source !== right.source) return left.source.localeCompare(right.source)
    return left.name.localeCompare(right.name)
  })
}

export function formatSkillDoctorReport(report: SkillDoctorReport): string {
  const hasError = report.findings.some((finding) => finding.severity === "error")
  const hasWarning = report.findings.some((finding) => finding.severity === "warning")
  const status = hasError ? "ERROR" : hasWarning ? "WARN" : "OK"
  const lines = [`${status}\t${report.source}\t${report.name}`]

  if (report.sourcePath) {
    lines.push(`  path: ${report.sourcePath}`)
  }

  for (const finding of report.findings) {
    lines.push(`  ${finding.severity}: ${finding.message}`)
  }

  return lines.join("\n")
}
