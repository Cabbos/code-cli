import { describe, expect, it } from "vitest"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { bundledSkills } from "./bundled"
import {
  exportSkillToDir,
  installSkillToScope,
  resolveSkillExportRoot,
  resolveSkillInstallRoot,
  resolveSkillInstallSource,
  serializeSkillMarkdown
} from "./install"

describe("skill install", () => {
  it("serializes bundled skills into a valid markdown file", () => {
    const simplify = bundledSkills.find((skill) => skill.name === "simplify")
    expect(simplify).toBeDefined()

    const markdown = serializeSkillMarkdown(simplify!)
    expect(markdown).toContain("name: simplify")
    expect(markdown).toContain("longDescription:")
    expect(markdown).toContain("## Prompt")
    expect(markdown).toContain("{{code}}")
  })

  it("installs a bundled skill into a destination directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "code-cli-install-"))
    try {
      const simplify = bundledSkills.find((skill) => skill.name === "simplify")
      expect(simplify).toBeDefined()

      const destinationDir = path.join(root, "skills", "simplify")
      const result = await installSkillToScope(
        {
          kind: "bundled",
          skill: simplify!,
          displayName: "simplify"
        },
        destinationDir
      )

      const content = await readFile(result.skillFile, "utf8")
      expect(content).toContain("name: simplify")
      expect(content).toContain("## Prompt")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("resolves and installs a local skill directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "code-cli-install-local-"))
    try {
      const sourceDir = path.join(root, "source-skill")
      await mkdir(sourceDir, { recursive: true })
      await writeFile(
        path.join(sourceDir, "SKILL.md"),
        `---
name: local-skill
description: Local skill
---

# local-skill

## Prompt

\`\`\`text
Local: {{user_message}}
\`\`\`
`,
        "utf8"
      )
      await writeFile(path.join(sourceDir, "NOTES.txt"), "extra asset", "utf8")

      const resolved = await resolveSkillInstallSource(sourceDir, root, bundledSkills)
      const destinationDir = path.join(root, "installed", "local-skill")
      await installSkillToScope(resolved, destinationDir)

      expect(await readFile(path.join(destinationDir, "SKILL.md"), "utf8")).toContain("name: local-skill")
      expect(await readFile(path.join(destinationDir, "NOTES.txt"), "utf8")).toContain("extra asset")
      expect(resolveSkillInstallRoot("project", root)).toBe(path.join(root, ".code-cli", "skills"))
      expect(resolveSkillExportRoot(root)).toBe(path.join(root, ".code-cli", "exports", "skills"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("exports a bundled skill into a shareable directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "code-cli-export-bundled-"))
    try {
      const remember = bundledSkills.find((skill) => skill.name === "remember")
      expect(remember).toBeDefined()

      const destinationDir = path.join(root, "exports", "remember")
      const result = await exportSkillToDir(
        {
          kind: "bundled",
          skill: remember!,
          displayName: "remember"
        },
        destinationDir
      )

      const content = await readFile(result.skillFile, "utf8")
      expect(content).toContain("name: remember")
      expect(content).toContain("## Prompt")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
