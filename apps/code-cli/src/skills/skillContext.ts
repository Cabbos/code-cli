/**
 * Skill Context - Tracks the currently active skill for enforcing allowedTools
 *
 * When a skill is invoked, its allowedTools are set here.
 * Subsequent tool calls check against these restrictions.
 */

import { SkillDefinition } from "./types"

// Module-level storage for active skill context
let activeSkill: SkillDefinition | undefined

/**
 * Set the active skill context (called when SkillTool is invoked)
 */
export function setActiveSkill(skill: SkillDefinition): void {
  activeSkill = skill
}

/**
 * Get the currently active skill (if any)
 */
export function getActiveSkill(): SkillDefinition | undefined {
  return activeSkill
}

/**
 * Clear the active skill context (called after skill result is added to messages)
 */
export function clearActiveSkill(): void {
  activeSkill = undefined
}

/**
 * Check if a tool is allowed in the current skill context.
 * Returns true if no active skill or if tool is in allowedTools.
 * Returns false if tool is NOT in allowedTools.
 */
export function isToolAllowedInSkillContext(toolName: string): boolean {
  const skill = getActiveSkill()
  if (!skill) return true // No active skill, allow all
  if (!skill.allowedTools || skill.allowedTools.length === 0) return true // No restrictions
  return skill.allowedTools.includes(toolName)
}

/**
 * Get the list of allowed tools for the current skill context.
 * Returns undefined if no active skill or no restrictions.
 */
export function getAllowedTools(): string[] | undefined {
  const skill = getActiveSkill()
  return skill?.allowedTools
}

export function getActiveSkillSummary():
  | { name: string; source: SkillDefinition["source"]; allowedTools?: string[] }
  | undefined {
  const skill = getActiveSkill()
  if (!skill) return undefined

  return {
    name: skill.name,
    source: skill.source,
    ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {})
  }
}
