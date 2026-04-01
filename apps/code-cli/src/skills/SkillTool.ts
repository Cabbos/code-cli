import path from "node:path"
import { LlmMessage } from "../llm/types"
import { ToolContext, ToolDefinition } from "../tools/types"
import { skillMatchesFiles } from "./conditional"
import { discoverSkillDirsForPaths } from "./discovery"
import { isFeatureEnabled } from "./featureFlags"
import { loadSkillByName, loadProjectSkills, loadSkillsFromDir, loadUserSkills } from "./loader"
import { executeShellCommandsInPrompt, hasShellCommands } from "./shellExecution"
import { SkillArgument, SkillDefinition, SkillInvokeResult } from "./types"

export type SkillToolInput = {
  name: string
  arguments?: Record<string, string>
  userMessage?: string
}

type SkillToolOutput =
  | ({ ok: true } & SkillInvokeResult)
  | { ok: false; error: string }

type CodeBlock = {
  language?: string
  code: string
}

const CONDITIONAL_BLOCK_PATTERN = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g
const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g
const CODE_BLOCK_PATTERN = /```([^\n`]*)\n([\s\S]*?)```/m

function defaultArgumentValues(skill: SkillDefinition): Record<string, string> {
  const values: Record<string, string> = {}
  for (const arg of skill.arguments ?? []) {
    if (typeof arg.default === "string") {
      values[arg.name] = arg.default
    }
  }
  return values
}

function validateArguments(
  skill: SkillDefinition,
  providedArgs: Record<string, string> | undefined
): string[] {
  const errors: string[] = []
  if (!skill.arguments) return errors

  const values = { ...defaultArgumentValues(skill), ...(providedArgs ?? {}) }
  for (const arg of skill.arguments) {
    if (arg.required && !values[arg.name]) {
      errors.push(`Missing required argument: ${arg.name}`)
    }
  }

  return errors
}

function isTruthy(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0
}

export function renderSkillTemplate(
  prompt: string,
  values: Record<string, string | undefined>
): { prompt: string; warnings: string[] } {
  const warnings = new Set<string>()

  let rendered = prompt.replace(CONDITIONAL_BLOCK_PATTERN, (_, name: string, body: string) => {
    return isTruthy(values[name]) ? body : ""
  })

  rendered = rendered.replace(PLACEHOLDER_PATTERN, (_, name: string) => {
    const value = values[name]
    if (value !== undefined) return value
    warnings.add(`Placeholder "${name}" was not resolved`)
    return `{{${name}}}`
  })

  return {
    prompt: rendered.trim(),
    warnings: [...warnings]
  }
}

export function extractPrimaryCodeBlock(text: string): CodeBlock | undefined {
  const match = text.match(CODE_BLOCK_PATTERN)
  if (!match || !match[2]) return undefined

  const language = match[1]?.trim() || undefined
  const code = match[2].trim()
  if (!code) return undefined

  return {
    ...(language ? { language } : {}),
    code
  }
}

function stripCodeBlocks(text: string): string {
  return text.replace(/```[^\n`]*\n[\s\S]*?```/g, "").trim()
}

function lastUserMessage(messages?: LlmMessage[]): string {
  if (!messages) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === "user") {
      return message.content
    }
  }
  return ""
}

function resolveUserMessage(input: SkillToolInput, ctx: ToolContext): string {
  const message = input.userMessage ?? ctx.currentUserInput ?? lastUserMessage(ctx.messages)
  return message.trim()
}

function truncateFromEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const keptChars = Math.max(0, maxChars - 4)
  return `...\n${value.slice(value.length - keptChars)}`
}

function formatConversation(messages?: LlmMessage[]): string {
  if (!messages) return ""

  const recentMessages = messages
    .filter((message) => {
      if (message.role === "tool" || message.role === "system") return false
      return message.content.trim().length > 0
    })
    .slice(-12)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.content.trim()}`)

  return truncateFromEnd(recentMessages.join("\n\n"), 8_000)
}

function normalizeLanguageTag(language: string | undefined): string | undefined {
  if (!language) return undefined

  const normalized = language.trim().toLowerCase()
  if (!normalized) return undefined

  if (normalized === "ts" || normalized === "tsx") return "typescript"
  if (normalized === "js" || normalized === "jsx") return "javascript"
  if (normalized === "py") return "python"
  return normalized
}

export function extractSkillContextValues(
  skill: SkillDefinition,
  input: SkillToolInput,
  ctx: ToolContext
): Record<string, string> {
  const userMessage = resolveUserMessage(input, ctx)
  const codeBlock = extractPrimaryCodeBlock(userMessage)
  const inferredLanguage = normalizeLanguageTag(codeBlock?.language)

  const values: Record<string, string> = {
    user_message: userMessage
  }

  switch (skill.name) {
    case "simplify":
    case "explain":
    case "test":
      values.code = codeBlock?.code ?? userMessage
      if (inferredLanguage) values.language = inferredLanguage
      break
    case "debug": {
      const problem = userMessage
      const nonCodeText = stripCodeBlocks(userMessage)
      if (problem) values.problem = problem
      if (codeBlock?.code) values.code = codeBlock.code
      if (nonCodeText) values.error = nonCodeText
      if (inferredLanguage) values.language = inferredLanguage
      break
    }
    case "remember":
      values.content = userMessage
      break
    case "skillify":
      values.conversation = formatConversation(ctx.messages)
      break
    default:
      if (codeBlock?.code) values.code = codeBlock.code
      if (inferredLanguage) values.language = inferredLanguage
      break
  }

  return values
}

function buildRuntimeValues(
  skill: SkillDefinition,
  input: SkillToolInput,
  ctx: ToolContext
): Record<string, string> {
  return {
    ...defaultArgumentValues(skill),
    ...extractSkillContextValues(skill, input, ctx),
    ...(input.arguments ?? {})
  }
}

async function findAvailableSkill(
  name: string,
  bundledSkillMap: Map<string, SkillDefinition>,
  ctx: ToolContext,
  touchedFiles: string[]
): Promise<SkillDefinition | undefined> {
  const bundled = bundledSkillMap.get(name)
  if (bundled) return bundled

  const loaded = await loadSkillByName(name, ctx.workspace.root)
  if (loaded) return loaded

  if (touchedFiles.length > 0) {
    const discoveredDirs = await discoverSkillDirsForPaths(touchedFiles, ctx.workspace.root)
    for (const skillsDir of discoveredDirs) {
      const dirSkills = await loadSkillsFromDir(skillsDir)
      const found = dirSkills.find((skill) => skill.name === name)
      if (found) return found
    }
  }

  return undefined
}

function isSkillEnabledForContext(
  skill: SkillDefinition,
  touchedFiles: string[]
): { ok: true } | { ok: false; error: string } {
  if (skill.isEnabled && !skill.isEnabled()) {
    return { ok: false, error: `Skill "${skill.name}" is not currently enabled` }
  }

  if (!isFeatureEnabled(skill.name)) {
    return { ok: false, error: `Skill "${skill.name}" is disabled via feature flag` }
  }

  if (skill.paths && skill.sourcePath) {
    const skillDir = path.dirname(skill.sourcePath)
    if (!skillMatchesFiles(skill.paths, skillDir, touchedFiles)) {
      return {
        ok: false,
        error: `Skill "${skill.name}" is only available for files matching: ${skill.paths.join(", ")}`
      }
    }
  }

  return { ok: true }
}

async function availableSkillNames(bundledSkillMap: Map<string, SkillDefinition>, workspaceRoot: string): Promise<string[]> {
  const [projectSkills, userSkills] = await Promise.all([
    loadProjectSkills(workspaceRoot),
    loadUserSkills()
  ])

  return [
    ...bundledSkillMap.keys(),
    ...projectSkills.map((skill) => skill.name),
    ...userSkills.map((skill) => skill.name)
  ].sort((left, right) => left.localeCompare(right))
}

function buildContextPrompt(
  skill: SkillDefinition,
  promptBody: string,
  userMessage: string
): string {
  const sections: string[] = [`=== SKILL: ${skill.name.toUpperCase()} ===`]

  if (skill.longDescription) {
    sections.push(skill.longDescription)
  }

  if (userMessage) {
    sections.push(`USER REQUEST: ${userMessage}`)
  }

  sections.push("---")
  sections.push(promptBody)
  sections.push("---")

  return sections.join("\n\n")
}

export function createSkillTool(
  bundledSkills: SkillDefinition[],
  opts?: { touchedFiles?: string[] }
): ToolDefinition<SkillToolInput, SkillToolOutput> {
  const skillMap = new Map<string, SkillDefinition>()

  for (const skill of bundledSkills) {
    if (skill.isEnabled && !skill.isEnabled()) continue
    if (!isFeatureEnabled(skill.name)) continue
    skillMap.set(skill.name, skill)
  }

  const bundledNames = [...skillMap.keys()].sort()

  return {
    name: "Skill",
    description:
      bundledNames.length > 0
        ? `Invokes a reusable skill runtime. Bundled skills: ${bundledNames.join(", ")}.`
        : "Invokes a reusable skill runtime.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name to invoke."
        },
        arguments: {
          type: "object",
          description: "Optional named arguments for the skill.",
          additionalProperties: { type: "string" }
        },
        userMessage: {
          type: "string",
          description: "Optional override for the user request used to build skill context."
        }
      },
      required: ["name"]
    },

    async invoke(input: SkillToolInput, ctx: ToolContext): Promise<SkillToolOutput> {
      const touchedFiles = opts?.touchedFiles ?? []
      const skill = await findAvailableSkill(input.name, skillMap, ctx, touchedFiles)

      if (!skill) {
        return {
          ok: false,
          error: `Skill not found: "${input.name}". Available skills: ${(await availableSkillNames(skillMap, ctx.workspace.root)).join(", ") || "none"}`
        }
      }

      const availability = isSkillEnabledForContext(skill, touchedFiles)
      if (!availability.ok) {
        return { ok: false, error: availability.error }
      }

      const validationErrors = validateArguments(skill, input.arguments)
      if (validationErrors.length > 0) {
        return {
          ok: false,
          error: `Invalid arguments for skill "${skill.name}": ${validationErrors.join(", ")}`
        }
      }

      const runtimeValues = buildRuntimeValues(skill, input, ctx)
      const rendered = renderSkillTemplate(skill.prompt, runtimeValues)
      let promptBody = rendered.prompt

      if (isFeatureEnabled("skill_shell_execution") && hasShellCommands(promptBody)) {
        promptBody = await executeShellCommandsInPrompt(promptBody, {
          cwd: ctx.workspace.root
        })
      }

      return {
        ok: true,
        prompt: buildContextPrompt(skill, promptBody, resolveUserMessage(input, ctx)),
        skill,
        ...(rendered.warnings.length > 0 ? { warnings: rendered.warnings } : {})
      }
    }
  }
}

export async function listAllSkills(workspaceRoot: string, bundled: SkillDefinition[] = []): Promise<SkillDefinition[]> {
  const [projectSkills, userSkills] = await Promise.all([
    loadProjectSkills(workspaceRoot),
    loadUserSkills()
  ])

  return [...bundled, ...projectSkills, ...userSkills]
}
