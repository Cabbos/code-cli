/**
 * Conditional Skills - Path-based skill activation
 *
 * Skills with `paths` frontmatter only activate when matching files are touched.
 * Uses gitignore-style pattern matching via the `ignore` library.
 */

import ignore, { Ignore } from "ignore"
import path from "node:path"

/**
 * Create an ignore matcher from skill path patterns.
 * Patterns are treated as include patterns (matching files activate the skill).
 */
export function createSkillMatcher(patterns: string[]): Ignore {
  const ig = ignore()
  // Convert to negation patterns for ignore library
  // ignore.ignores() returns true for patterns that should be INCLUDED
  ig.add(patterns)
  return ig
}

/**
 * Check if a skill's paths patterns match any of the given file paths.
 * Returns true if the skill has no paths restriction (always active).
 *
 * @param patterns - Skill's path patterns from frontmatter
 * @param skillSourceDir - The skill's source directory (for resolving relative paths)
 * @param filePaths - File paths to check against the patterns
 */
export function skillMatchesFiles(
  patterns: string[] | undefined,
  skillSourceDir: string,
  filePaths: string[]
): boolean {
  // No restriction - skill is always active
  if (!patterns || patterns.length === 0) {
    return true
  }

  const ig = createSkillMatcher(patterns)

  for (const filePath of filePaths) {
    // Make file path relative to skill source dir
    let relativePath: string
    if (path.isAbsolute(filePath)) {
      relativePath = path.relative(skillSourceDir, filePath)
    } else {
      relativePath = filePath
    }

    // Skip paths that escape the skill's directory
    if (relativePath.startsWith("..")) {
      continue
    }

    // Normalize path separators for cross-platform compatibility
    relativePath = relativePath.replace(/\\/g, "/")

    if (ig.test(relativePath).ignored) {
      return true
    }
  }

  return false
}

/**
 * Parse paths from a comma-separated string.
 * Handles whitespace trimming and filters empty strings.
 */
export function parsePathsString(pathsStr: string): string[] {
  return pathsStr
    .split(",")
    .map(p => p.trim())
    .filter(p => p.length > 0)
}

/**
 * Check if a skill should be active for a given context.
 * Combines isEnabled check and path matching.
 *
 * @param skill - Skill definition with optional isEnabled and paths
 * @param skillSourceDir - The skill's source directory
 * @param filePaths - File paths in the current context
 */
export function isSkillActiveForContext(
  skill: { isEnabled?: () => boolean; paths?: string[] },
  skillSourceDir: string,
  filePaths: string[]
): boolean {
  // Check isEnabled callback first
  if (skill.isEnabled && !skill.isEnabled()) {
    return false
  }

  // Check path patterns
  if (!skillMatchesFiles(skill.paths, skillSourceDir, filePaths)) {
    return false
  }

  return true
}
