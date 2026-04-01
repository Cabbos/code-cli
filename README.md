# code-cli

A minimal, extensible coding agent CLI inspired by tools like Claude Code.
Built with Node.js, TypeScript, and designed to help developers explore AI agent infrastructure.

## Features

- **Agent Loop**: Iterative tool-call loops with max-step controls.
- **Pluggable Tools**: Built-in tools for filesystem (`fs.readFile`, `fs.writeFile`, `fs.listFiles`, `fs.applyPatch`), search (`search.rg`), and git (`git.diff`, `git.status`).
- **Workspace Sandbox**: Strict directory bounds to prevent agent path traversal.
- **Session Management**: Chat loops are saved locally and can be resumed or exported.
- **Config & Policies**: Support for `readonly` mode, write confirmations, and tool allow/deny lists.
- **Skill Runtime**: Bundled, project, and user skills can be listed and invoked through the `Skill` tool.
- **Offline Evals**: A lightweight evaluation runner to verify tool behavior without hitting LLM APIs.
- **Tracing & Replay**: JSONL trace output for debugging and offline tool-call replay.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Interface                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │  Interactive │  │    Run      │  │   Tools     │  │  Session    │      │
│  │    Chat      │  │   Single    │  │   List      │  │   List      │      │
│  │   (:chat)   │  │   Prompt    │  │             │  │             │      │
│  └──────┬──────┘  └──────┬──────┘  └─────────────┘  └─────────────┘      │
└─────────┼─────────────────┼────────────────────────────────────────────────┘
          │                 │
          ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Agent Core                                        │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      runAgentTurn()                                   │    │
│  │                                                                       │    │
│  │   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐     │    │
│  │   │ LLM      │───▶│ Tool Call │───▶│ Execute  │───▶│ Truncate │     │    │
│  │   │ Complete │    │  Parse    │    │  Tool    │    │ Result   │     │    │
│  │   └──────────┘    └──────────┘    └────┬─────┘    └──────────┘     │    │
│  │                                       │                              │    │
│  │                                       ▼                              │    │
│  │                              ┌──────────────┐                       │    │
│  │                              │   Sandbox    │                       │    │
│  │                              │  (Workspace) │                       │    │
│  │                              └──────────────┘                       │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Tool Registry                                      │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                    ToolRegistry.call(name, input, ctx)                 │  │
│  │                              │                                        │  │
│  │         ┌────────────────────┼────────────────────┐                   │  │
│  │         ▼                    ▼                    ▼                   │  │
│  │  ┌────────────┐      ┌────────────┐      ┌────────────┐            │  │
│  │  │    fs.*    │      │   git.*    │      │   ast.*    │            │  │
│  │  │   deps.*   │      │  search.*  │      │   test.*   │            │  │
│  │  └────────────┘      └────────────┘      └────────────┘            │  │
│  │                              │                                        │  │
│  │                              ▼                                        │  │
│  │                    ┌──────────────────┐                                │  │
│  │                    │  Tool Policy    │                                │  │
│  │                    │ (allow/deny/rw) │                                │  │
│  │                    └──────────────────┘                                │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Design Decisions

### 1. 为什么使用 Workspace Sandbox？

Workspace 是安全边界，限制 AI 代理只能访问指定目录：

```typescript
resolvePath(relPath: string): string {
  const resolved = path.resolve(this.rootDir, relPath)
  const rel = path.relative(this.rootDir, resolved)
  if (rel.startsWith("..")) throw new Error("Path escapes workspace")
  return resolved
}
```

**设计原则**：
- 路径穿越防护：所有文件操作必须通过 `resolvePath` 验证
- 符号链接检查：防止通过 symlink 逃逸到外部目录
- 显式白名单：工具无法访问 workspace 外的任何文件

### 2. 为什么使用 Tool Registry 模式？

```typescript
// 工具定义与注册分离
const tool: ToolDefinition<I, O> = { name: "fs.readFile", invoke: async (...) => {...} }
registry.register(tool)
```

**设计原则**：
- **单一职责**：每个工具定义只包含输入验证和业务逻辑
- **策略控制**：通过 `ToolPolicy` 控制工具的可用性
- **类型安全**：泛型 `ToolDefinition<I, O>` 确保输入输出类型正确
- **可扩展**：新增工具只需实现 `ToolDefinition` 并注册

### 3. 为什么使用 Offline Eval 框架？

```
Eval Cases (cases.json) ──▶ LLM Mock ──▶ Tool Execution ──▶ Result Diff
```

**设计原则**：
- **零 API 成本**：不调用真实 LLM，节省费用
- **快速回归**：每次提交自动运行 30+ 测试用例
- **确定性**：相同输入总是产生相同输出
- **可重现**：replay fixtures 确保 CI 结果一致

### 4. Truncation 策略

Tool 结果可能很大，需要限制：

```typescript
const maxToolResultChars = 20_000    // 单个工具结果上限
const maxTotalToolResultChars = 80_000  // 所有工具结果累计上限
```

**设计原则**：
- 超过 `maxToolResultChars` 的结果会被截断并标记 `truncated: true`
- 达到 `maxTotalToolResultChars` 后，后续工具调用被跳过
- 截断信息写入 trace，便于调试

## Project Structure

This is an npm workspace monorepo:

- `apps/code-cli`: The core agent CLI implementation.
  - `src/agent`: Core LLM interaction and tool-calling loop.
  - `src/skills`: Skill runtime, loaders, bundled skills, and template handling.
  - `src/tools`: Registry and built-in tools (fs, git, search).
  - `src/core`: Workspace boundary enforcement.
  - `src/session`: Persistent chat sessions.
  - `evals/`: Offline regression cases.

## Installation & Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the CLI:
   ```bash
   npm run build
   ```

3. (Optional) Make it globally available locally:
   ```bash
   npm -w apps/code-cli link
   ```
   *This links the CLI as `ccode` (and `code-cli`) in your global npm bin.*

## Usage

You can run the CLI directly via the local bin shim:

```bash
# Start an interactive chat session
./node_modules/.bin/ccode chat

# Run a single prompt (non-interactive)
./node_modules/.bin/ccode run "List all files in the src directory"

# List available tools
./node_modules/.bin/ccode tools

# List available skills
./node_modules/.bin/ccode skills

# Create a new project skill template
./node_modules/.bin/ccode skill:create my-skill "One-line description"

# Manage sessions
./node_modules/.bin/ccode session list
./node_modules/.bin/ccode session export <session-id>
```

### Skills

- Bundled skills are enabled by default and exposed through the `Skill` tool.
- Project skills live in `<workspace>/.code-cli/skills/<name>/SKILL.md`.
- User skills live in `~/.code-cli/skills/<name>/SKILL.md`.
- `skills` only shows currently available skills after frontmatter and feature-flag filtering.

Example `SKILL.md` shape:

````md
---
name: explain-snippet
description: Explain the current code snippet
---

# explain-snippet

## Prompt

```text
Explain this request:
{{user_message}}

{{#if code}}
Code:
{{code}}
{{/if}}
```
````

Feature flags:

- `features.flags.<skill_name>` or `CODECLI_FEATURE_<SKILL_NAME>` can disable an individual skill.
- `features.flags.skill_shell_execution` or `CODECLI_FEATURE_SKILL_SHELL_EXECUTION` controls shell interpolation inside skill prompts.
- Shell interpolation is disabled by default.

### Options & Security

- `--workspace <dir>`: Limit the agent to a specific directory (default: current working directory).
- `--readonly`: Disable tools that write to the filesystem (e.g., `fs.writeFile`, `fs.applyPatch`).
- `--confirm-writes`: Ask for human confirmation before writing files.

## Real LLM Setup (OpenAI-compatible)

The CLI supports OpenAI-compatible `/v1/chat/completions` providers.

### Kimi (Moonshot)

```bash
export CODECLI_PROVIDER=kimi
export CODECLI_API_KEY=sk-...
export CODECLI_MODEL=moonshot-v1-8k
export CODECLI_BASE_URL=https://api.moonshot.cn

./node_modules/.bin/ccode run "hello"
```

Notes:
- `CODECLI_BASE_URL` can be set to either `https://api.moonshot.cn` or `https://api.moonshot.cn/v1`.
- Avoid committing API keys. Prefer env vars or a local config file outside the repo.

## Testing

Run the offline evaluation suite:

```bash
npm test
```

### Trace (JSONL)

```bash
./node_modules/.bin/ccode run "tool:git.status {\"maxBytes\":5000}" --no-stream --trace
```

Trace files are written under `<workspace>/.code-cli/traces/` by default.

### Replay eval (offline tool-call replay)

Re-run the recorded tool calls without hitting any LLM provider:

```bash
npm -w apps/code-cli run eval:replay -- --trace .code-cli/traces/<trace>.jsonl --ignore-output
```

Notes:
- Replay runs in readonly mode by default. Add `--allow-writes` to replay write tools.
- Omit `--ignore-output` to compare tool result hashes to the trace.

### Trace fixtures (CI-friendly)

This repo includes committed JSONL trace fixtures under `apps/code-cli/evals/fixtures/` so CI can replay tool calls without any real LLM.

Regenerate fixtures:

```bash
npm -w apps/code-cli run eval:trace
```

Replay fixtures:

```bash
npm -w apps/code-cli run eval:replay:fixtures
```

### Live eval (real LLM)

Run a smoke regression against a real OpenAI-compatible provider:

```bash
export CODECLI_PROVIDER=kimi
export CODECLI_BASE_URL=https://api.moonshot.cn
export CODECLI_MODEL=moonshot-v1-8k
export CODECLI_API_KEY=sk-...

export CODECLI_EVAL_WORKSPACE=/Users/cabbos/project/projects/agent_learning_tracker
npm -w apps/code-cli run eval:live
```

## Future Roadmap

- Expand Git tools (`git.add`, `git.commit`).
- Task planning & reasoning modes.
- TUI (Terminal UI) improvements for tool execution visibility.
