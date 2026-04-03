import { afterEach, describe, expect, it } from "vitest"
import { Workspace } from "../core/workspace"
import { clearActiveSkill, setActiveSkill } from "../skills/skillContext"
import { ToolRegistry } from "./registry"

describe("ToolRegistry", () => {
  afterEach(() => {
    clearActiveSkill()
  })

  it("reports the active skill when a tool is blocked by allowedTools", async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: "search.rg",
      description: "Searches files",
      invoke: async () => ({ ok: true })
    })

    setActiveSkill({
      name: "reader-only",
      description: "Read-only skill",
      prompt: "Use read tools only",
      source: "project",
      allowedTools: ["fs.readFile"]
    })

    await expect(
      registry.call("search.rg", {}, { workspace: new Workspace({ rootDir: process.cwd() }) })
    ).rejects.toThrow('Tool "search.rg" is not allowed while skill "reader-only" (project) is active.')
  })
})
