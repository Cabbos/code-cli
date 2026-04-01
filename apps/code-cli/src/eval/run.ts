import { promises as fs } from "node:fs"
import path from "node:path"
import process from "node:process"
import { runAgent } from "../agent/runAgent"
import { MockProvider } from "../llm/mock"
import { Workspace } from "../core/workspace"
import { createDefaultToolRegistry } from "../tools/defaultRegistry"
import { initFeatureFlags } from "../skills/featureFlags"

type CaseFile = {
  cases: Array<{
    name: string
    prompt: string
    expectContains: string
    expectNotContains?: string[]
  }>
}

async function main() {
  const monorepoRoot = path.resolve(__dirname, "../..")
  const filePath = path.join(monorepoRoot, "evals", "cases.json")

  const { execSync } = require("child_process")
  const raw = await fs.readFile(filePath, "utf8")
  const data = JSON.parse(raw) as CaseFile

  initFeatureFlags()
  const provider = new MockProvider()
  const tools = createDefaultToolRegistry()
  const workspace = new Workspace({ rootDir: monorepoRoot })

  let failed = 0
  for (const c of data.cases) {
    execSync("node scripts/eval-restore.js", { cwd: monorepoRoot })
    const out = await runAgent({
      provider,
      model: "mock",
      workspace,
      tools,
      prompt: c.prompt,
      stream: false,
      maxSteps: 4
    })
    const okContains = out.includes(c.expectContains)
    const okNotContains = (c.expectNotContains ?? []).every((value) => !out.includes(value))
    const ok = okContains && okNotContains
    process.stdout.write(`${ok ? "PASS" : "FAIL"}\t${c.name}\n`)
    if (!ok) {
      failed++
      process.stdout.write(`expected substring: ${c.expectContains}\n`)
      if (!okNotContains) {
        process.stdout.write(`unexpected substrings: ${(c.expectNotContains ?? []).filter((value) => out.includes(value)).join(", ")}\n`)
      }
      process.stdout.write(`actual: ${out}\n`)
    }
  }

  if (failed) process.exit(1)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
