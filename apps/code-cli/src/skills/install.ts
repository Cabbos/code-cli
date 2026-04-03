import os from "node:os"
import path from "node:path"
import { promises as fs } from "node:fs"
import { loadSkillFromFile } from "./loader"
import { SkillDefinition } from "./types"

export type SkillInstallScope = "project" | "user"

export type ResolvedSkillInstallSource =
  | {
      kind: "bundled"
      skill: SkillDefinition
      displayName: string
    }
  | {
      kind: "directory"
      skill: SkillDefinition
      sourceDir: string
      displayName: string
    }

export function resolveSkillInstallRoot(scope: SkillInstallScope, workspaceRoot: string): string {
  if (scope === "user") {
    return path.join(os.homedir(), ".code-cli", "skills")
  }
  return path.join(workspaceRoot, ".code-cli", "skills")
}

export function resolveSkillExportRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".code-cli", "exports", "skills")
}

export function serializeSkillMarkdown(skill: SkillDefinition): string {
  const lines: string[] = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`
  ]

  if (skill.longDescription) {
    lines.push(`longDescription: ${skill.longDescription}`)
  }
  if (skill.paths && skill.paths.length > 0) {
    lines.push(`paths: ${skill.paths.join(", ")}`)
  }
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    lines.push(`allowed-tools: ${skill.allowedTools.join(", ")}`)
  }

  lines.push("---", "", `# ${skill.name}`, "")

  if (skill.longDescription) {
    lines.push("## Long Description", "", skill.longDescription, "")
  }

  if (skill.arguments && skill.arguments.length > 0) {
    lines.push("## Arguments", "")
    for (const argument of skill.arguments) {
      const requiredSuffix = argument.required ? " (required)" : ""
      const defaultSuffix = argument.default ? ` [default: ${argument.default}]` : ""
      lines.push(`- ${argument.name}${requiredSuffix}${defaultSuffix}: ${argument.description}`)
    }
    lines.push("")
  }

  lines.push("## Prompt", "", "```text", skill.prompt, "```", "")
  return lines.join("\n")
}

export async function resolveSkillInstallSource(
  source: string,
  workspaceRoot: string,
  availableSkills: SkillDefinition[]
): Promise<ResolvedSkillInstallSource> {
  const sourcePath = path.resolve(source)
  try {
    const stat = await fs.stat(sourcePath)
    const sourceDir = stat.isDirectory() ? sourcePath : path.dirname(sourcePath)
    const skillFile = stat.isDirectory() ? path.join(sourcePath, "SKILL.md") : sourcePath

    if (path.basename(skillFile) !== "SKILL.md") {
      throw new Error(`Expected a skill directory or SKILL.md file, got: ${source}`)
    }

    const skill = await loadSkillFromFile(skillFile)
    return {
      kind: "directory",
      skill,
      sourceDir,
      displayName: sourcePath
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== "ENOENT") {
      throw error
    }
  }

  const knownSkill = availableSkills.find((skill) => skill.name === source)
  if (!knownSkill) {
    throw new Error(`Skill or path not found: ${source}`)
  }

  if (knownSkill.source === "bundled" || !knownSkill.sourcePath) {
    return {
      kind: "bundled",
      skill: knownSkill,
      displayName: knownSkill.name
    }
  }

  return {
    kind: "directory",
    skill: knownSkill,
    sourceDir: path.dirname(knownSkill.sourcePath),
    displayName: knownSkill.name
  }
}

async function ensureDestinationAvailable(destinationDir: string, force: boolean): Promise<void> {
  try {
    await fs.stat(destinationDir)
    if (!force) {
      throw new Error(`Destination already exists: ${destinationDir}`)
    }
    await fs.rm(destinationDir, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    if (error instanceof Error && error.message.startsWith("Destination already exists")) {
      throw error
    }
    throw error
  }
}

export async function installSkillToScope(
  source: ResolvedSkillInstallSource,
  destinationDir: string,
  opts?: { force?: boolean }
): Promise<{ skill: SkillDefinition; skillFile: string }> {
  return materializeSkillSource(source, destinationDir, opts)
}

export async function exportSkillToDir(
  source: ResolvedSkillInstallSource,
  destinationDir: string,
  opts?: { force?: boolean }
): Promise<{ skill: SkillDefinition; skillFile: string }> {
  return materializeSkillSource(source, destinationDir, opts)
}

async function materializeSkillSource(
  source: ResolvedSkillInstallSource,
  destinationDir: string,
  opts?: { force?: boolean }
): Promise<{ skill: SkillDefinition; skillFile: string }> {
  const force = Boolean(opts?.force)
  await ensureDestinationAvailable(destinationDir, force)
  await fs.mkdir(path.dirname(destinationDir), { recursive: true })

  if (source.kind === "bundled") {
    await fs.mkdir(destinationDir, { recursive: true })
    const skillFile = path.join(destinationDir, "SKILL.md")
    await fs.writeFile(skillFile, serializeSkillMarkdown(source.skill), "utf8")
    return { skill: source.skill, skillFile }
  }

  await fs.cp(source.sourceDir, destinationDir, { recursive: true, force })
  return { skill: source.skill, skillFile: path.join(destinationDir, "SKILL.md") }
}
