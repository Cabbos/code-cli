import { promises as fs } from "node:fs"
import path from "node:path"
import process from "node:process"
import { runAgent } from "../agent/runAgent"
import { MockProvider } from "../llm/mock"
import { Workspace } from "../core/workspace"
import { createDefaultToolRegistry } from "../tools/defaultRegistry"

type CaseFile = {
  cases: Array<{ name: string; prompt: string; expectContains: string }>
}

async function main() {
  const root = process.cwd()
  const filePath = path.join(root, "evals", "cases.json")
  const raw = await fs.readFile(filePath, "utf8")
  const data = JSON.parse(raw) as CaseFile

  const provider = new MockProvider()
  const tools = createDefaultToolRegistry()
  const workspace = new Workspace({ rootDir: path.resolve(root, "../..") })

  let failed = 0
  for (const c of data.cases) {
    const out = await runAgent({
      provider,
      model: "mock",
      workspace,
      tools,
      prompt: c.prompt,
      stream: false,
      maxSteps: 4
    })
    const ok = out.includes(c.expectContains)
    process.stdout.write(`${ok ? "PASS" : "FAIL"}\t${c.name}\n`)
    if (!ok) {
      failed++
      process.stdout.write(`expected substring: ${c.expectContains}\n`)
      process.stdout.write(`actual: ${out}\n`)
    }
  }

  if (failed) process.exit(1)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})

