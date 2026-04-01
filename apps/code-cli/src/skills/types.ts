/**
 * Skill system type definitions
 *
 * A Skill is a reusable, parameterized prompt that can be invoked via the SkillTool.
 * Skills are defined in SKILL.md files and loaded from:
 * - Project-specific: .code-cli/skills/<name>/SKILL.md
 * - User global: ~/.code-cli/skills/<name>/SKILL.md
 * - Bundled: built-in skills
 */

export type SkillArgument = {
  name: string
  description: string
  required?: boolean
  default?: string
}

export type SkillDefinition = {
  /** Unique name of the skill, e.g., "simplify", "debug" */
  name: string
  /** One-line description shown in tool listings */
  description: string
  /** Detailed description explaining what the skill does */
  longDescription?: string
  /** Arguments the skill accepts */
  arguments?: SkillArgument[]
  /** The system prompt / instructions for this skill */
  prompt: string
  /** Source of the skill: "bundled" | "project" | "user" */
  source: "bundled" | "project" | "user"
  /** Path to the SKILL.md file (for non-bundled skills) */
  sourcePath?: string
  /** Optional callback to determine if skill is currently enabled */
  isEnabled?: () => boolean
  // Optional file path patterns (gitignore-style) - skill activates when matching files are touched
  // Patterns are relative to the skill's source directory
  paths?: string[]
  /**
   * Optional list of tool names this skill is allowed to use.
   * When set, only these tools can be used while this skill is active.
   * Example: ["Read", "Write", "Grep"]
   */
  allowedTools?: string[]
}

export type SkillInvokeContext = {
  workspaceRoot: string
  skillName: string
  arguments?: Record<string, string>
  /** The original user message that triggered this skill */
  userMessage: string
  /** Conversation history up to this point */
  conversationHistory?: Array<{ role: string; content: string }>
}

export type SkillInvokeResult = {
  /** The generated prompt after substituting arguments */
  prompt: string
  /** The skill definition used */
  skill: SkillDefinition
  /** Any warnings or notes */
  warnings?: string[]
}
