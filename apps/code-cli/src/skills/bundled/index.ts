import { SkillDefinition } from "../types"
import { simplifySkill } from "./simplify"
import { debugSkill } from "./debug"
import { rememberSkill } from "./remember"
import { skillifySkill } from "./skillify"
import { explainSkill } from "./explain"
import { testSkill } from "./test"

/**
 * All bundled skills
 */
export const bundledSkills: SkillDefinition[] = [
  simplifySkill,
  debugSkill,
  rememberSkill,
  skillifySkill,
  explainSkill,
  testSkill,
]

/**
 * Get a bundled skill by name
 */
export function getBundledSkill(name: string): SkillDefinition | undefined {
  return bundledSkills.find((s) => s.name === name)
}

/**
 * Get all bundled skill names
 */
export function listBundledSkillNames(): string[] {
  return bundledSkills.map((s) => s.name)
}
