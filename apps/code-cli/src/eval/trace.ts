import path from "node:path"
import process from "node:process"
import { MockProvider } from "../llm/mock"
import { Workspace } from "../core/workspace"
import { createDefaultToolRegistry } from "../tools/defaultRegistry"
import { createInitialMessages, runAgentTurn } from "../agent/runAgent"
import { createJsonlTraceWriter } from "../agent/trace"

type Fixture = {
  name: string
  filePath: string
  prompts: string[]
}

async function main() {
  const root = process.cwd()
  const workspaceRoot = path.join(root, "evals", "replay-workspace")

  const provider = new MockProvider()
  const tools = createDefaultToolRegistry()
  const workspace = new Workspace({ rootDir: workspaceRoot })

  const fixtures: Fixture[] = [
    {
      name: "replay-basic",
      filePath: path.join(root, "evals", "fixtures", "replay-basic.jsonl"),
      prompts: [
        "tool:fs.listFiles {\"dir\":\".\",\"recursive\":true}",
        "tool:search.rg {\"pattern\":\"TODO\",\"dir\":\".\",\"maxResults\":10}",
        "tool:git.status {\"maxBytes\":5000}"
      ]
    },
    {
      name: "replay-strict",
      filePath: path.join(root, "evals", "fixtures", "replay-strict.jsonl"),
      prompts: [
        "tool:fs.readFile {\"path\":\"hello.txt\"}",
        "tool:search.rg {\"pattern\":\"hello\",\"dir\":\".\",\"maxResults\":10}"
      ]
    }
  ]

  for (const f of fixtures) {
    const w = await createJsonlTraceWriter(f.filePath, { append: false })
    const trace = w.write
    trace({ type: "run.start", mode: "fixture", name: f.name, ts: Date.now(), workspace: workspaceRoot })
    try {
      for (const p of f.prompts) {
        trace({ type: "turn.start", ts: Date.now(), inputPreview: p })
        const messages = createInitialMessages("You are a coding agent.")
        const out = await runAgentTurn({
          provider,
          model: "mock",
          workspace,
          tools,
          messages,
          userInput: p,
          maxSteps: 2,
          stream: false,
          trace
        })
        trace({ type: "turn.end", ts: Date.now(), outputChars: out.content.length })
      }
      trace({ type: "run.end", mode: "fixture", name: f.name, ts: Date.now() })
    } finally {
      await w.close()
    }
    process.stdout.write(`${path.relative(root, f.filePath)}\n`)
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})

