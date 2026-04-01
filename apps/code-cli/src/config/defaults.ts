import os from "node:os"
import path from "node:path"
import { CodeCliConfig } from "./types"

export function defaultConfig(): CodeCliConfig {
  return {
    llm: {
      provider: "mock",
      model: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com"
    },
    sessions: {
      dir: path.join(os.homedir(), ".code-cli", "sessions")
    },
    tools: {
      readonly: false,
      confirmWrites: false
    },
    agent: {
      systemPrompt:
        "You are a coding agent. Use tools when you need to read/write/list files. Prefer tools over guessing. Keep outputs concise."
    },
    features: {
      flags: {
        skill_shell_execution: false
      }
    }
  }
}
