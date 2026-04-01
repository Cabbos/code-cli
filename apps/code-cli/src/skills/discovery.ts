/**
 * Dynamic Skill Discovery
 *
 * Discovers .code-cli/skills directories by walking up from file paths.
 * Skills in nested directories are discovered on-demand during file operations.
 */

import { promises as fs } from "node:fs"
import path from "node:path"

// Cache of checked directory paths to avoid repeated stat calls
const checkedDirs = new Map<string, string | null>()

/**
 * Clear the discovery cache. Useful for testing.
 */
export function clearDiscoveryCache(): void {
  checkedDirs.clear()
}

/**
 * Discover .code-cli/skills directories from file paths.
 * Walks up from each file path looking for .code-cli/skills,
 * returns sorted unique list (deepest first).
 *
 * @param filePaths - Array of file paths to search from
 * @param cwd - Current working directory (upper bound for discovery)
 * @returns Array of discovered skill directory paths, sorted deepest first
 */
export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string
): Promise<string[]> {
  const results = new Set<string>()
  const normalizedCwd = cwd.endsWith(path.sep) ? cwd.slice(0, -1) : cwd

  for (const filePath of filePaths) {
    // Resolve to absolute path
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(cwd, filePath)

    // Start from the file's parent directory
    let currentDir = path.dirname(absPath)

    // Walk up to cwd but NOT including cwd itself
    while (currentDir.startsWith(normalizedCwd + path.sep) || currentDir === normalizedCwd) {
      // Check cache first
      const cached = checkedDirs.get(currentDir)
      if (cached !== undefined) {
        if (cached) results.add(cached)
        break // No skills dir at this level or above
      }

      const skillsDir = path.join(currentDir, ".code-cli", "skills")

      try {
        const stat = await fs.stat(skillsDir)
        if (stat.isDirectory()) {
          checkedDirs.set(currentDir, skillsDir)
          results.add(skillsDir)
          // Continue walking up to find more
          const parent = path.dirname(currentDir)
          if (parent === currentDir) break
          currentDir = parent
          continue
        }
      } catch {
        // No skills dir at this level - cache negative result
        checkedDirs.set(currentDir, null)
      }

      // Move to parent directory
      const parent = path.dirname(currentDir)
      if (parent === currentDir) break
      currentDir = parent
    }
  }

  // Sort by depth (deepest first) so skills closer to the file take precedence
  return [...results].sort((a, b) => {
    const depthA = a.split(path.sep).length
    const depthB = b.split(path.sep).length
    return depthB - depthA
  })
}

/**
 * Check if a directory path has already been cached.
 */
export function isDirCached(dirPath: string): boolean {
  return checkedDirs.has(dirPath)
}

/**
 * Get all cached directory results.
 */
export function getCachedDirs(): Map<string, string | null> {
  return new Map(checkedDirs)
}
