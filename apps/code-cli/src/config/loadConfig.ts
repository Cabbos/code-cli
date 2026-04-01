import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultConfig } from "./defaults"
import { CodeCliConfig, CodeCliConfigOverrides } from "./types"

export type LoadConfigParams = {
  workspaceRoot: string
  configPath?: string
  overrides?: CodeCliConfigOverrides
}

export async function loadConfig(params: LoadConfigParams): Promise<CodeCliConfig> {
  const base = defaultConfig()
  const fromFile = await loadConfigFile(params.workspaceRoot, params.configPath)
  const fromEnv = loadFromEnv()
  const merged = mergeConfig(base, fromFile, fromEnv, params.overrides)
  return merged
}

async function loadConfigFile(workspaceRoot: string, configPath?: string): Promise<CodeCliConfigOverrides> {
  const tried: string[] = []
  const candidates = configPath
    ? [configPath]
    : [
        path.join(workspaceRoot, ".code-cli", "config.json"),
        path.join(workspaceRoot, "code-cli.config.json"),
        path.join(os.homedir(), ".code-cli", "config.json")
      ]

  for (const p of candidates) {
    tried.push(p)
    try {
      const raw = await fs.readFile(p, "utf8")
      const data = JSON.parse(raw) as unknown
      if (!isPlainObject(data)) throw new Error("Config must be a JSON object")
      return data as CodeCliConfigOverrides
    } catch (err) {
      if (err instanceof Error) {
        const anyErr = err as { code?: string }
        if (anyErr.code === "ENOENT") continue
      }
      throw new Error(`Failed to load config: ${p}`)
    }
  }

  void tried
  return {}
}

function loadFromEnv(): CodeCliConfigOverrides {
  const provider = process.env.CODECLI_PROVIDER
  const model = process.env.CODECLI_MODEL
  const baseUrl = process.env.CODECLI_BASE_URL
  const apiKey = process.env.CODECLI_API_KEY
  const sessionsDir = process.env.CODECLI_SESSION_DIR
  const readonlyEnv = process.env.CODECLI_TOOLS_READONLY
  const confirmWritesEnv = process.env.CODECLI_TOOLS_CONFIRM_WRITES
  const systemPrompt = process.env.CODECLI_SYSTEM_PROMPT

  // Extract CODECLI_FEATURE_* environment variables
  const featureFlags: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CODECLI_FEATURE_")) {
      const flagName = key.slice("CODECLI_FEATURE_".length).toLowerCase()
      featureFlags[flagName] = parseBool(value ?? "false")
    }
  }

  const result: CodeCliConfigOverrides = {
    llm: {
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {})
    },
    sessions: {
      ...(sessionsDir ? { dir: sessionsDir } : {})
    },
    tools: {
      ...(typeof readonlyEnv === "string" ? { readonly: parseBool(readonlyEnv) } : {}),
      ...(typeof confirmWritesEnv === "string" ? { confirmWrites: parseBool(confirmWritesEnv) } : {})
    },
    agent: {
      ...(systemPrompt ? { systemPrompt } : {})
    }
  }

  if (Object.keys(featureFlags).length > 0) {
    result.features = { flags: featureFlags }
  }

  return result
}

function mergeConfig(...parts: Array<CodeCliConfigOverrides | undefined>): CodeCliConfig {
  let out = defaultConfig()
  for (const p of parts) {
    if (!p) continue
    out = {
      ...out,
      llm: { ...out.llm, ...(p.llm ?? {}) },
      sessions: { ...out.sessions, ...(p.sessions ?? {}) },
      tools: { ...out.tools, ...(p.tools ?? {}) },
      agent: { ...out.agent, ...(p.agent ?? {}) },
      features: {
        flags: {
          ...(out.features?.flags ?? {}),
          ...(p.features?.flags ?? {})
        }
      }
    }
  }
  return out
}

function parseBool(v: string): boolean {
  const s = v.trim().toLowerCase()
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true
  if (s === "0" || s === "false" || s === "no" || s === "off") return false
  return Boolean(s)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype
}
