import { afterEach, describe, expect, it } from "vitest"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { loadSkillFromFile, loadSkillsFromDir } from "./loader"
import { initFeatureFlags, resetFeatureFlags } from "./featureFlags"

describe.sequential("skill loader", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    resetFeatureFlags()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (!dir) continue
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("parses SKILL.md frontmatter, arguments, prompt, and project source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "code-cli-loader-"))
    tempDirs.push(root)
    const skillFile = path.join(root, "workspace", ".code-cli", "skills", "custom-helper", "SKILL.md")
    await mkdir(path.dirname(skillFile), { recursive: true })
    await writeFile(
      skillFile,
      `---
name: custom-helper
description: Custom helper skill
longDescription: Detailed helper description
paths: src/**/*.ts, tests/**/*.ts
allowed-tools: fs.readFile, search.rg
---

# Custom Helper

## Arguments
- snippet (required): Snippet to inspect
- language [default: typescript]: Language name

## Prompt

\`\`\`text
Inspect {{snippet}}
{{#if language}}Language: {{language}}{{/if}}
\`\`\`
`,
      "utf8"
    )

    const skill = await loadSkillFromFile(skillFile)

    expect(skill.name).toBe("custom-helper")
    expect(skill.description).toBe("Custom helper skill")
    expect(skill.longDescription).toBe("Detailed helper description")
    expect(skill.source).toBe("project")
    expect(skill.paths).toEqual(["src/**/*.ts", "tests/**/*.ts"])
    expect(skill.allowedTools).toEqual(["fs.readFile", "search.rg"])
    expect(skill.arguments).toEqual([
      {
        name: "snippet",
        description: "Snippet to inspect",
        required: true
      },
      {
        name: "language",
        description: "Language name",
        default: "typescript"
      }
    ])
    expect(skill.prompt).toContain("Inspect {{snippet}}")
  })

  it("loads only enabled skills from a skills root directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "code-cli-loader-dir-"))
    tempDirs.push(root)
    const skillsRoot = path.join(root, ".code-cli", "skills")
    await mkdir(path.join(skillsRoot, "visible-skill"), { recursive: true })
    await mkdir(path.join(skillsRoot, "disabled-skill"), { recursive: true })
    await mkdir(path.join(skillsRoot, "feature-gated"), { recursive: true })

    await writeFile(
      path.join(skillsRoot, "visible-skill", "SKILL.md"),
      `---
name: visible-skill
description: Visible skill
---

# Visible Skill

## Prompt

\`\`\`text
Visible: {{user_message}}
\`\`\`
`,
      "utf8"
    )
    await writeFile(
      path.join(skillsRoot, "disabled-skill", "SKILL.md"),
      `---
name: disabled-skill
description: Disabled skill
enabled: false
---

# Disabled Skill

## Prompt

\`\`\`text
Disabled
\`\`\`
`,
      "utf8"
    )
    await writeFile(
      path.join(skillsRoot, "feature-gated", "SKILL.md"),
      `---
name: feature-gated
description: Feature gated skill
---

# Feature Gated

## Prompt

\`\`\`text
Feature gated
\`\`\`
`,
      "utf8"
    )

    initFeatureFlags({
      feature_gated: false
    })

    const skills = await loadSkillsFromDir(skillsRoot)

    expect(skills.map((skill) => skill.name)).toEqual(["visible-skill"])
  })
})
