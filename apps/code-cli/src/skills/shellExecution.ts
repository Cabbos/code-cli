/**
 * Shell Command Execution in Skill Prompts
 *
 * Allows skills to embed shell commands in their prompts using:
 * - Inline: !`command`
 * - Block: ```! command ```
 *
 * Commands are executed and their output is substituted into the prompt.
 */

import { execSync } from "node:child_process"

export type ShellExecutionOptions = {
  /** Current working directory for command execution */
  cwd?: string
  /** Environment variables for the command */
  env?: Record<string, string>
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number
}

/**
 * Result of executing a shell command
 */
export type ShellResult = {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Execute a shell command and return the result.
 */
export async function executeShellCommand(
  command: string,
  options: ShellExecutionOptions = {}
): Promise<ShellResult> {
  const timeout = options.timeout ?? 30000
  const cwd = options.cwd ?? process.cwd()
  const env = { ...process.env, ...options.env }

  try {
    const stdout = execSync(command, {
      cwd,
      env,
      timeout,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024, // 10MB max
    })

    return {
      stdout: typeof stdout === "string" ? stdout.trim() : "",
      stderr: "",
      exitCode: 0,
    }
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; status?: number }
    return {
      stdout: typeof err.stdout === "string" ? err.stdout.trim() : "",
      stderr: typeof err.stderr === "string" ? err.stderr.trim() : "",
      exitCode: err.status ?? 1,
    }
  }
}

/**
 * Regular expression for inline shell commands: !`command`
 * Requires whitespace before ! to avoid matching !! or $!
 */
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm

/**
 * Regular expression for shell command blocks: ```! ... ```
 */
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g

/**
 * Process a shell command result and format it for the prompt.
 */
function formatShellOutput(result: ShellResult): string {
  const parts: string[] = []

  if (result.stdout) {
    parts.push(result.stdout)
  }

  if (result.stderr) {
    parts.push(`[stderr] ${result.stderr}`)
  }

  const output = parts.join("\n").trim()
  return output || "(no output)"
}

/**
 * Execute shell commands embedded in a skill prompt.
 *
 * Supports:
 * - Inline: !`git status`
 * - Block:
 *   ```!
 *   git diff
 *   ```
 *
 * @param prompt - The skill prompt text containing shell commands
 * @param options - Execution options (cwd, env, timeout)
 * @returns The prompt with shell commands replaced by their output
 */
export async function executeShellCommandsInPrompt(
  prompt: string,
  options: ShellExecutionOptions = {}
): Promise<string> {
  let result = prompt

  // Process block commands first (```! ... ```)
  const blockMatches = [...result.matchAll(BLOCK_PATTERN)]
  for (const match of blockMatches) {
    const command = match[1]?.trim()
    if (!command) continue

    try {
      const shellResult = await executeShellCommand(command, options)
      // Use function replacer to avoid issues with special chars in output
      result = result.replace(match[0], () => formatShellOutput(shellResult))
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      result = result.replace(match[0], () => `[shell error: ${errorMessage}]`)
    }
  }

  // Process inline commands (!`command`)
  // Only check if there are inline commands to avoid expensive regex
  if (result.includes("!`")) {
    const inlineMatches = [...result.matchAll(INLINE_PATTERN)]
    for (const match of inlineMatches) {
      const command = match[1]?.trim()
      if (!command) continue

      try {
        const shellResult = await executeShellCommand(command, options)
        // Use function replacer to avoid issues with special chars in output
        result = result.replace(match[0], () => formatShellOutput(shellResult))
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        result = result.replace(match[0], () => `[shell error: ${errorMessage}]`)
      }
    }
  }

  return result
}

/**
 * Check if a prompt contains any shell commands.
 * Useful for quick detection before processing.
 */
export function hasShellCommands(prompt: string): boolean {
  return /```!\s*\n?[\s\S]*?\n?```/.test(prompt) || prompt.includes("!`")
}
