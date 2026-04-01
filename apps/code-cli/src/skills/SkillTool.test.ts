import { afterEach, describe, expect, it } from "vitest"
import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { Workspace } from "../core/workspace"
import { bundledSkills } from "./bundled"
import {
  createSkillTool,
  extractSkillContextValues,
  renderSkillTemplate
} from "./SkillTool"
import { initFeatureFlags, resetFeatureFlags } from "./featureFlags"
import { createInitialMessages, runAgentTurn } from "../agent/runAgent"
import { createDefaultToolRegistry } from "../tools/defaultRegistry"
import { getActiveSkill } from "./skillContext"
import { LlmProvider, LlmResponse, LlmCompleteParams } from "../llm/types"

class SkillCallingProvider implements LlmProvider {
  private callCount = 0

  async complete(_params: LlmCompleteParams): Promise<LlmResponse> {
    if (this.callCount === 0) {
      this.callCount += 1
      return {
        content: "",
        toolCalls: [
          {
            id: "skill-1",
            name: "Skill",
            input: {
              name: "remember"
            }
          }
        ]
      }
    }

    return {
      content: "done",
      toolCalls: []
    }
  }
}

describe.sequential("SkillTool", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    resetFeatureFlags()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (!dir) continue
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("renders placeholders and conditional blocks", () => {
    const rendered = renderSkillTemplate(
      `Hello {{name}}
{{#if code}}Code:
{{code}}{{/if}}
Missing: {{unknown}}`,
      {
        name: "world",
        code: "const value = 1;"
      }
    )

    expect(rendered.prompt).toContain("Hello world")
    expect(rendered.prompt).toContain("const value = 1;")
    expect(rendered.warnings).toEqual(['Placeholder "unknown" was not resolved'])
  })

  it("extracts smart context for bundled skills", () => {
    const debugSkill = bundledSkills.find((skill) => skill.name === "debug")
    expect(debugSkill).toBeDefined()

    const values = extractSkillContextValues(
      debugSkill!,
      {
        name: "debug",
        userMessage: `This crashes on startup

\`\`\`ts
const answer = maybeAnswer.value
\`\`\`
TypeError: Cannot read properties of undefined`
      },
      {
        workspace: new Workspace({ rootDir: process.cwd() })
      }
    )

    expect(values.problem).toContain("This crashes on startup")
    expect(values.code).toContain("const answer = maybeAnswer.value")
    expect(values.error).toContain("TypeError")
    expect(values.language).toBe("typescript")
  })

  it("builds a runnable prompt for simplify and leaves shell interpolation off by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "code-cli-skill-tool-"))
    tempDirs.push(root)
    initFeatureFlags({
      skill_shell_execution: false
    })

    const customSkill = {
      name: "shell-check",
      description: "Checks shell interpolation",
      prompt: "Status: !`printf enabled`",
      source: "bundled" as const
    }

    const tool = createSkillTool([customSkill, ...bundledSkills])
    const result = await tool.invoke(
      {
        name: "simplify"
      },
      {
        workspace: new Workspace({ rootDir: root }),
        currentUserInput: `Please simplify this

\`\`\`ts
const result = foo ? foo : bar
\`\`\``
      }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.prompt).toContain("const result = foo ? foo : bar")
      expect(result.prompt).not.toContain("{{code}}")
    }

    const shellResult = await tool.invoke(
      {
        name: "shell-check"
      },
      {
        workspace: new Workspace({ rootDir: root }),
        currentUserInput: "run shell check"
      }
    )

    expect(shellResult.ok).toBe(true)
    if (shellResult.ok) {
      expect(shellResult.prompt).toContain("!`printf enabled`")
    }
  })

  it("passes messages and current input through runAgentTurn and clears skill context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "code-cli-run-agent-"))
    tempDirs.push(root)
    initFeatureFlags()

    const provider = new SkillCallingProvider()
    const workspace = new Workspace({ rootDir: root })
    const tools = createDefaultToolRegistry()
    const messages = createInitialMessages("You are a coding agent.")

    const out = await runAgentTurn({
      provider,
      model: "mock",
      workspace,
      tools,
      messages,
      userInput: "Remember this architecture decision",
      stream: false,
      maxSteps: 2
    })

    const toolMessage = out.messages.find((message) => message.role === "tool" && message.name === "Skill")
    expect(toolMessage).toBeDefined()
    expect(toolMessage?.role).toBe("tool")

    const parsed = JSON.parse(toolMessage?.content ?? "{}") as { prompt?: string }
    expect(parsed.prompt).toContain("Remember this architecture decision")
    expect((parsed as { skill?: { prompt?: string; name?: string } }).skill?.prompt).toBeUndefined()
    expect((parsed as { skill?: { name?: string } }).skill?.name).toBe("remember")
    expect(getActiveSkill()).toBeUndefined()
  })
})
