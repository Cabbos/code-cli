import { afterEach, describe, expect, it } from "vitest"
import { getAllFeatureFlags, initFeatureFlags, isFeatureEnabled, resetFeatureFlags } from "./featureFlags"

const ENV_KEYS = [
  "CODECLI_FEATURE_SIMPLIFY",
  "CODECLI_FEATURE_SKILL_SHELL_EXECUTION"
]

describe.sequential("featureFlags", () => {
  afterEach(() => {
    resetFeatureFlags()
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }
  })

  it("defaults regular skill flags to enabled and shell execution to disabled", () => {
    expect(isFeatureEnabled("simplify")).toBe(true)
    expect(isFeatureEnabled("project-helper")).toBe(true)
    expect(isFeatureEnabled("skill_shell_execution")).toBe(false)
  })

  it("prefers environment variables over config flags", () => {
    initFeatureFlags({
      simplify: true,
      skill_shell_execution: false
    })
    process.env.CODECLI_FEATURE_SIMPLIFY = "false"
    process.env.CODECLI_FEATURE_SKILL_SHELL_EXECUTION = "true"

    expect(isFeatureEnabled("simplify")).toBe(false)
    expect(isFeatureEnabled("skill_shell_execution")).toBe(true)
  })

  it("merges cached and env flags in getAllFeatureFlags", () => {
    initFeatureFlags({
      simplify: false
    })
    process.env.CODECLI_FEATURE_SKILL_SHELL_EXECUTION = "true"

    expect(getAllFeatureFlags()).toMatchObject({
      skill_shell_execution: true,
      simplify: false
    })
  })
})
