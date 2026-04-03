import { afterEach, describe, expect, it } from "vitest"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
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

  it("lists user skills and verbose metadata", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-cli-cli-"))
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "code-cli-home-"))
    tempDirs.push(workspaceRoot, tempHome)

    await writeSkill(workspaceRoot, "project-skill", "Project skill", "allowed-tools: fs.readFile, search.rg\n")

    const userSkillDir = path.join(tempHome, ".code-cli", "skills", "user-skill")
    await mkdir(userSkillDir, { recursive: true })
    await writeFile(
      path.join(userSkillDir, "SKILL.md"),
      `---
name: user-skill
description: User skill
paths: src/**/*.ts
---

# user-skill

## Prompt

\`\`\`text
User says: {{user_message}}
\`\`\`
`,
      "utf8"
    )

    const output = execFileSync(
      process.execPath,
      [tsNodeBin, indexScript, "--workspace", workspaceRoot, "skills", "--verbose"],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          HOME: tempHome
        },
        encoding: "utf8"
      }
    )

    expect(output).toContain("[Project]")
    expect(output).toContain("project-skill")
    expect(output).toContain("allowed tools: fs.readFile, search.rg")
    expect(output).toContain("[User]")
    expect(output).toContain("user-skill")
    expect(output).toContain("paths: src/**/*.ts")
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

  it("installs a bundled skill into project scope", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-cli-install-project-"))
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "code-cli-home-"))
    tempDirs.push(workspaceRoot, tempHome)

    const output = execFileSync(
      process.execPath,
      [tsNodeBin, indexScript, "--workspace", workspaceRoot, "skill:install", "simplify"],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          HOME: tempHome
        },
        encoding: "utf8"
      }
    )

    const installedFile = path.join(workspaceRoot, ".code-cli", "skills", "simplify", "SKILL.md")
    const content = await readFile(installedFile, "utf8")
    expect(output).toContain("Installed skill: simplify")
    expect(content).toContain("name: simplify")
  })

  it("installs a local skill directory into user scope", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-cli-install-user-"))
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "code-cli-home-"))
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "code-cli-source-skill-"))
    tempDirs.push(workspaceRoot, tempHome, sourceRoot)

    await writeFile(
      path.join(sourceRoot, "SKILL.md"),
      `---
name: imported-skill
description: Imported skill
---

# imported-skill

## Prompt

\`\`\`text
Imported: {{user_message}}
\`\`\`
`,
      "utf8"
    )
    await writeFile(path.join(sourceRoot, "asset.txt"), "skill asset", "utf8")

    const output = execFileSync(
      process.execPath,
      [tsNodeBin, indexScript, "--workspace", workspaceRoot, "skill:install", sourceRoot, "--scope", "user"],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          HOME: tempHome
        },
        encoding: "utf8"
      }
    )

    const installedDir = path.join(tempHome, ".code-cli", "skills", "imported-skill")
    expect(output).toContain("scope: user")
    expect(await readFile(path.join(installedDir, "SKILL.md"), "utf8")).toContain("name: imported-skill")
    expect(await readFile(path.join(installedDir, "asset.txt"), "utf8")).toContain("skill asset")
  })

  it("exports a bundled skill to a shareable directory", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-cli-export-project-"))
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "code-cli-home-"))
    tempDirs.push(workspaceRoot, tempHome)

    const exportDir = path.join(workspaceRoot, "shared-simplify")
    const output = execFileSync(
      process.execPath,
      [tsNodeBin, indexScript, "--workspace", workspaceRoot, "skill:export", "simplify", "--out", exportDir],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          HOME: tempHome
        },
        encoding: "utf8"
      }
    )

    expect(output).toContain("Exported skill: simplify")
    expect(output).toContain("install with:")
    expect(await readFile(path.join(exportDir, "SKILL.md"), "utf8")).toContain("name: simplify")
  })

  it("exports a project skill and installs it into user scope", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-cli-export-roundtrip-"))
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "code-cli-home-"))
    tempDirs.push(workspaceRoot, tempHome)

    await writeSkill(workspaceRoot, "shared-skill", "Shared skill")
    await writeFile(
      path.join(workspaceRoot, ".code-cli", "skills", "shared-skill", "asset.txt"),
      "roundtrip asset",
      "utf8"
    )

    const exportDir = path.join(workspaceRoot, "exports", "shared-skill")
    execFileSync(
      process.execPath,
      [tsNodeBin, indexScript, "--workspace", workspaceRoot, "skill:export", "shared-skill", "--out", exportDir],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          HOME: tempHome
        },
        encoding: "utf8"
      }
    )

    execFileSync(
      process.execPath,
      [tsNodeBin, indexScript, "--workspace", workspaceRoot, "skill:install", exportDir, "--scope", "user"],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          HOME: tempHome
        },
        encoding: "utf8"
      }
    )

    const installedDir = path.join(tempHome, ".code-cli", "skills", "shared-skill")
    expect(await readFile(path.join(installedDir, "SKILL.md"), "utf8")).toContain("name: shared-skill")
    expect(await readFile(path.join(installedDir, "asset.txt"), "utf8")).toContain("roundtrip asset")
  })

  it("inspects a skill with prompt preview", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-cli-inspect-"))
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "code-cli-home-"))
    tempDirs.push(workspaceRoot, tempHome)

    await writeSkill(
      workspaceRoot,
      "inspect-me",
      "Inspect me",
      "allowed-tools: fs.readFile, search.rg\npaths: src/**/*.ts\n"
    )

    const output = execFileSync(
      process.execPath,
      [tsNodeBin, indexScript, "--workspace", workspaceRoot, "skill:inspect", "inspect-me"],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          HOME: tempHome
        },
        encoding: "utf8"
      }
    )

    expect(output).toContain("Skill: inspect-me")
    expect(output).toContain("Source: project")
    expect(output).toContain("Allowed tools: fs.readFile, search.rg")
    expect(output).toContain("Paths: src/**/*.ts")
    expect(output).toContain("Prompt:")
    expect(output).toContain("Skill says: {{user_message}}")
  })

  it("summarizes a trace file", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-cli-trace-"))
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "code-cli-home-"))
    tempDirs.push(workspaceRoot, tempHome)

    const traceFile = path.join(workspaceRoot, "trace.jsonl")
    await writeFile(
      traceFile,
      [
        JSON.stringify({ type: "run.start", mode: "run", workspace: workspaceRoot, ts: 100 }),
        JSON.stringify({ type: "turn.start", ts: 110 }),
        JSON.stringify({ type: "tool.call", internalName: "search.rg", ts: 120 }),
        JSON.stringify({ type: "skill.invoke", requestedName: "remember", ts: 130 }),
        JSON.stringify({ type: "skill.resolve", skillName: "remember", source: "bundled", ts: 140 }),
        JSON.stringify({ type: "skill.render", skillName: "remember", source: "bundled", warningCount: 0, ts: 150 }),
        JSON.stringify({ type: "skill.activate", skillName: "remember", source: "bundled", ts: 160 }),
        JSON.stringify({ type: "skill.clear", skillName: "remember", source: "bundled", ts: 170 })
      ].join("\n"),
      "utf8"
    )

    const output = execFileSync(
      process.execPath,
      [tsNodeBin, indexScript, "--workspace", workspaceRoot, "trace", "summary", "trace.jsonl"],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          HOME: tempHome
        },
        encoding: "utf8"
      }
    )

    expect(output).toContain("Trace Summary")
    expect(output).toContain("Mode: run")
    expect(output).toContain("search.rg x1")
    expect(output).toContain("remember [bundled] invoke:1 resolve:1 activate:1 clear:1 warnings:0")
  })

  it("validates skills with skill:doctor", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "code-cli-doctor-"))
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "code-cli-home-"))
    tempDirs.push(workspaceRoot, tempHome)

    await writeSkill(
      workspaceRoot,
      "broken-skill",
      "Broken skill",
      "allowed-tools: nope.tool\n"
    )

    const skillFile = path.join(workspaceRoot, ".code-cli", "skills", "broken-skill", "SKILL.md")
    await writeFile(
      skillFile,
      `---
name: broken-skill
description: Broken skill
allowed-tools: nope.tool
---

# broken-skill

## Prompt

\`\`\`text
Broken: {{missing}}
{{#if missing}}
\`\`\`
`,
      "utf8"
    )

    const result = spawnSync(
      process.execPath,
      [tsNodeBin, indexScript, "--workspace", workspaceRoot, "skill:doctor", "broken-skill"],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          HOME: tempHome
        },
        encoding: "utf8"
      }
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toContain("Skill Doctor")
    expect(result.stdout).toContain("ERROR\tproject\tbroken-skill")
    expect(result.stdout).toContain('Unknown tool "nope.tool"')
    expect(result.stdout).toContain('Template variable "missing"')
  })
})
