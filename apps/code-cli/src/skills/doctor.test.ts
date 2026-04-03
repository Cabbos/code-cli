import { describe, expect, it } from "vitest"
import { inspectSkillDefinition } from "./doctor"

describe("skill doctor", () => {
  it("reports unsupported tags, undeclared variables, and unknown tools", () => {
    const report = inspectSkillDefinition(
      {
        name: "broken skill",
        description: "Broken skill",
        prompt: `Hello {{ user_message }}
{{#if missing}}
Unknown: {{missing}}
Allowed: {{user_message}}
`,
        source: "project",
        allowedTools: ["tool.unknown"],
        arguments: [
          {
            name: "user_message",
            description: "Should not normally be user declared"
          }
        ]
      },
      ["fs.readFile", "search.rg"]
    )

    const messages = report.findings.map((finding) => finding.message)
    expect(messages.some((message) => message.includes("not kebab-case"))).toBe(true)
    expect(messages.some((message) => message.includes("Unsupported template tag"))).toBe(true)
    expect(messages.some((message) => message.includes('Template variable "missing"'))).toBe(true)
    expect(messages.some((message) => message.includes('Unknown tool "tool.unknown"'))).toBe(true)
  })

  it("accepts a healthy skill definition", () => {
    const report = inspectSkillDefinition(
      {
        name: "review-typescript",
        description: "Review TypeScript changes",
        prompt: `User request:
{{user_message}}

{{#if code}}
Code:
{{code}}
{{/if}}`,
        source: "project",
        allowedTools: ["fs.readFile", "search.rg"],
        arguments: [
          {
            name: "focus",
            description: "Review focus",
            default: "correctness"
          }
        ]
      },
      ["fs.readFile", "search.rg"]
    )

    expect(report.findings).toEqual([])
  })
})
