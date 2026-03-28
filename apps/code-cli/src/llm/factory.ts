import { MockProvider } from "./mock"
import { OpenAICompatibleProvider } from "./openaiCompatible"
import { LlmProvider } from "./types"

export type ProviderConfig = {
  provider: string
  model: string
  baseUrl?: string
  apiKey?: string
}

export function createProvider(cfg: ProviderConfig): { provider: LlmProvider; model: string } {
  const kind = (cfg.provider ?? "mock").toLowerCase()
  const model = kind === "kimi" || kind === "moonshot" ? (cfg.model === "gpt-4.1-mini" ? "moonshot-v1-8k" : cfg.model) : cfg.model

  if (kind === "openai" || kind === "openai-compatible" || kind === "kimi" || kind === "moonshot") {
    const baseUrl =
      nonEmpty(cfg.baseUrl) ?? (kind === "kimi" || kind === "moonshot" ? "https://api.moonshot.cn" : "https://api.openai.com")
    const apiKey = nonEmpty(cfg.apiKey)
    return {
      provider: new OpenAICompatibleProvider(apiKey ? { baseUrl, apiKey } : { baseUrl }),
      model
    }
  }

  return { provider: new MockProvider(), model }
}

export function createProviderFromEnv(): { provider: LlmProvider; model: string } {
  const kind = (process.env.CODECLI_PROVIDER ?? "mock").toLowerCase()
  const model = nonEmpty(process.env.CODECLI_MODEL) ?? (kind === "kimi" || kind === "moonshot" ? "moonshot-v1-8k" : "gpt-4.1-mini")

  if (kind === "openai" || kind === "openai-compatible" || kind === "kimi" || kind === "moonshot") {
    const baseUrl =
      nonEmpty(process.env.CODECLI_BASE_URL) ?? (kind === "kimi" || kind === "moonshot" ? "https://api.moonshot.cn" : "https://api.openai.com")
    const apiKey = nonEmpty(process.env.CODECLI_API_KEY)
    return {
      provider: new OpenAICompatibleProvider(apiKey ? { baseUrl, apiKey } : { baseUrl }),
      model
    }
  }

  return { provider: new MockProvider(), model }
}

function nonEmpty(v: string | undefined): string | undefined {
  const s = typeof v === "string" ? v.trim() : ""
  return s.length ? s : undefined
}
