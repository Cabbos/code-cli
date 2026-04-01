import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { SkillArgument, SkillDefinition } from "./types"
import { isFeatureEnabled } from "./featureFlags"
import { parsePathsString } from "./conditional"

const SKILL_FILE_NAME = "SKILL.md"

type ParsedFrontmatter = Record<string, string>

function parseAllowedToolsString(toolsStr: string): string[] {
  return toolsStr
    .split(",")
    .map((toolName) => toolName.trim())
    .filter((toolName) => toolName.length > 0)
}

function parseFrontmatter(lines: string[]): { frontmatter: ParsedFrontmatter; bodyLines: string[] } {
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, bodyLines: lines }
  }

  const endIndex = lines.indexOf("---", 1)
  if (endIndex <= 0) {
    return { frontmatter: {}, bodyLines: lines }
  }

  const frontmatter: ParsedFrontmatter = {}
  for (const line of lines.slice(1, endIndex)) {
    const colonIndex = line.indexOf(":")
    if (colonIndex <= 0) continue
    const key = line.slice(0, colonIndex).trim()
    const value = line.slice(colonIndex + 1).trim()
    if (!key) continue
    frontmatter[key] = value
  }

  return { frontmatter, bodyLines: lines.slice(endIndex + 1) }
}

function collectSections(lines: string[]): {
  title?: string
  introLines: string[]
  sections: Record<string, string[]>
} {
  const introLines: string[] = []
  const sections: Record<string, string[]> = {}
  let currentSection = ""
  let title: string | undefined
  let inPromptFence = false
  let promptFence = ""

  for (const line of lines) {
    const trimmed = line.trim()

    if (inPromptFence) {
      sections[currentSection] ??= []
      const currentLines = sections[currentSection]
      if (trimmed.startsWith(promptFence)) {
        inPromptFence = false
        continue
      }
      if (!currentLines) continue
      currentLines.push(line)
      continue
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 0
      const heading = headingMatch[2]?.trim() ?? ""
      if (level === 1 && !title && heading) {
        title = heading
      } else {
        currentSection = heading.toLowerCase()
        sections[currentSection] ??= []
      }
      continue
    }

    if (currentSection === "prompt" && trimmed.startsWith("```")) {
      inPromptFence = true
      promptFence = "```"
      continue
    }

    if (currentSection) {
      sections[currentSection] ??= []
      const currentLines = sections[currentSection]
      if (!currentLines) continue
      currentLines.push(line)
      continue
    }

    introLines.push(line)
  }

  return {
    ...(title ? { title } : {}),
    introLines,
    sections
  }
}

function firstNonEmptyParagraph(lines: string[]): string | undefined {
  const joined = lines.join("\n")
  const paragraphs = joined
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)

  return paragraphs[0]
}

function parseArguments(lines: string[]): SkillArgument[] | undefined {
  const result: SkillArgument[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line.startsWith("- ")) continue

    const match = line.match(
      /^-\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+\((required)\))?(?:\s+\[default:\s*([^\]]+)\])?:\s+(.+)$/
    )
    if (!match) continue

    const [, name, required, defaultValue, description] = match
    if (!name || !description) continue

    result.push({
      name,
      description: description.trim(),
      ...(required === "required" ? { required: true } : {}),
      ...(typeof defaultValue === "string" && defaultValue.trim().length > 0
        ? { default: defaultValue.trim() }
        : {})
    })
  }

  return result.length > 0 ? result : undefined
}

function resolveSkillSource(sourcePath: string): "project" | "user" {
  const userSkillsRoot = path.join(os.homedir(), ".code-cli", "skills")
  const normalizedSourcePath = path.resolve(sourcePath)
  const normalizedUserRoot = path.resolve(userSkillsRoot)
  if (
    normalizedSourcePath === normalizedUserRoot ||
    normalizedSourcePath.startsWith(`${normalizedUserRoot}${path.sep}`)
  ) {
    return "user"
  }
  return "project"
}

export async function loadSkillFromFile(filePath: string): Promise<SkillDefinition> {
  const content = await fs.readFile(filePath, "utf8")
  return parseSkillMarkdown(content, filePath)
}

export function parseSkillMarkdown(content: string, sourcePath: string): SkillDefinition {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const { frontmatter, bodyLines } = parseFrontmatter(lines)
  const { title, introLines, sections } = collectSections(bodyLines)

  const name = frontmatter.name || title || path.basename(path.dirname(sourcePath))
  const description =
    frontmatter.description ||
    firstNonEmptyParagraph(sections.description ?? []) ||
    firstNonEmptyParagraph(introLines) ||
    `Skill: ${name}`
  const longDescription =
    frontmatter.longDescription ||
    firstNonEmptyParagraph(sections["long description"] ?? []) ||
    undefined
  const prompt = (sections.prompt ?? []).join("\n").trim()

  if (!prompt) {
    throw new Error(`Skill prompt not found in ${sourcePath}`)
  }

  const argumentsSection = parseArguments(sections.arguments ?? [])
  const source = resolveSkillSource(sourcePath)

  return {
    name,
    description,
    prompt,
    source,
    sourcePath,
    ...(longDescription ? { longDescription } : {}),
    ...(argumentsSection ? { arguments: argumentsSection } : {}),
    ...(frontmatter.paths ? { paths: parsePathsString(frontmatter.paths) } : {}),
    ...(frontmatter.enabled !== undefined
      ? {
          isEnabled: () => frontmatter.enabled === "true" || frontmatter.enabled === "1"
        }
      : {}),
    ...(frontmatter["allowed-tools"]
      ? {
          allowedTools: parseAllowedToolsString(frontmatter["allowed-tools"])
        }
      : {})
  }
}

async function findSkillDirs(skillsRootDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(skillsRootDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(skillsRootDir, entry.name))
  } catch {
    return []
  }
}

export async function loadSkillsFromDir(
  skillsRootDir: string,
  opts?: { skipDisabled?: boolean }
): Promise<SkillDefinition[]> {
  const skillDirs = await findSkillDirs(skillsRootDir)
  const skills: SkillDefinition[] = []

  for (const skillDir of skillDirs) {
    const skillPath = path.join(skillDir, SKILL_FILE_NAME)
    try {
      const skill = await loadSkillFromFile(skillPath)
      if (opts?.skipDisabled !== false && skill.isEnabled && !skill.isEnabled()) {
        continue
      }
      if (!isFeatureEnabled(skill.name)) {
        continue
      }
      skills.push(skill)
    } catch (err) {
      console.warn(`Failed to load skill from ${skillPath}: ${err}`)
    }
  }

  return skills
}

export async function loadUserSkills(): Promise<SkillDefinition[]> {
  return loadSkillsFromDir(path.join(os.homedir(), ".code-cli", "skills"))
}

export async function loadProjectSkills(workspaceRoot: string): Promise<SkillDefinition[]> {
  return loadSkillsFromDir(path.join(workspaceRoot, ".code-cli", "skills"))
}

export async function loadSkillByName(
  name: string,
  workspaceRoot: string
): Promise<SkillDefinition | null> {
  const projectPath = path.join(workspaceRoot, ".code-cli", "skills", name, SKILL_FILE_NAME)
  try {
    return await loadSkillFromFile(projectPath)
  } catch {}

  const userPath = path.join(os.homedir(), ".code-cli", "skills", name, SKILL_FILE_NAME)
  try {
    return await loadSkillFromFile(userPath)
  } catch {
    return null
  }
}
