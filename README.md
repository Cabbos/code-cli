# code-cli

A minimal, extensible coding agent CLI inspired by tools like Claude Code. 
Built with Node.js, TypeScript, and designed to help developers explore AI agent infrastructure.

## Features

- **Agent Loop**: Iterative tool-call loops with max-step controls.
- **Pluggable Tools**: Built-in tools for filesystem (`fs.readFile`, `fs.writeFile`, `fs.listFiles`, `fs.applyPatch`), search (`search.rg`), and git (`git.diff`, `git.status`).
- **Workspace Sandbox**: Strict directory bounds to prevent agent path traversal.
- **Session Management**: Chat loops are saved locally and can be resumed or exported.
- **Config & Policies**: Support for `readonly` mode, write confirmations, and tool allow/deny lists.
- **Offline Evals**: A lightweight evaluation runner to verify tool behavior without hitting LLM APIs.

## Project Structure

This is an npm workspace monorepo:

- `apps/code-cli`: The core agent CLI implementation.
  - `src/agent`: Core LLM interaction and tool-calling loop.
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

# Manage sessions
./node_modules/.bin/ccode session list
./node_modules/.bin/ccode session export <session-id>
```

### Options & Security

- `--workspace <dir>`: Limit the agent to a specific directory (default: current working directory).
- `--readonly`: Disable tools that write to the filesystem (e.g., `fs.writeFile`, `fs.applyPatch`).
- `--confirm-writes`: Ask for human confirmation before writing files.

## Testing

Run the offline evaluation suite:

```bash
npm test
```

## Future Roadmap

- Expand Git tools (`git.add`, `git.commit`).
- Task planning & reasoning modes.
- TUI (Terminal UI) improvements for tool execution visibility.
