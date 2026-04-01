import { afterEach, describe, expect, it } from "vitest"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { loadSkillFromFile } from "./skills/loader"

const appRoot = process.cwd()
const tsNodeBin = path.resolve(appRoot, "../../node_modules/ts-node/dist/bin.js")
const indexScript = path.join(appRoot, "src/index.ts")

async function writeSkill(
  workspaceRoot: string,
  name: string,
  description: string,
  extraFrontmatter = ""
): Promise<void> {
  const skillDir = path.join(workspaceRoot, ".code-cli", "skills", name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
${extraFrontmatter}---

# ${name}

## Prompt

\`\`\`text
Skill says: {{user_message}}
\`\`\`
`,
    "utf8"
  )
}

describe.sequential("index CLI", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (!dir) continue
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("lists only available skills", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-cli-cli-"))
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "code-cli-home-"))
    tempDirs.push(workspaceRoot, tempHome)

    await writeSkill(workspaceRoot, "visible-skill", "Visible skill")
    await writeSkill(workspaceRoot, "hidden-skill", "Hidden skill", "enabled: false\n")

    const output = execFileSync(
      process.execPath,
      [tsNodeBin, indexScript, "--workspace", workspaceRoot, "skills"],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          HOME: tempHome,
          CODECLI_FEATURE_DEBUG: "false"
        },
        encoding: "utf8"
      }
    )

    expect(output).toContain("visible-skill")
    expect(output).not.toContain("hidden-skill")
    expect(output).not.toContain("  debug -")
  })

  it("creates a parsable skill template", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-cli-create-"))
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "code-cli-home-"))
    tempDirs.push(workspaceRoot, tempHome)

    execFileSync(
      process.execPath,
      [tsNodeBin, indexScript, "--workspace", workspaceRoot, "skill:create", "demo-skill", "Demo skill"],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          HOME: tempHome
        },
        encoding: "utf8"
      }
    )

    const skillFile = path.join(workspaceRoot, ".code-cli", "skills", "demo-skill", "SKILL.md")
    const content = await readFile(skillFile, "utf8")
    const parsed = await loadSkillFromFile(skillFile)

    expect(content).toContain("## Prompt")
    expect(content).toContain("```text")
    expect(parsed.name).toBe("demo-skill")
    expect(parsed.prompt).toContain("{{user_message}}")
  })
})
