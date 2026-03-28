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
  const model = cfg.model

  if (kind === "openai" || kind === "openai-compatible") {
    const baseUrl = cfg.baseUrl ?? "https://api.openai.com"
    const apiKey = cfg.apiKey
    return {
      provider: new OpenAICompatibleProvider(apiKey ? { baseUrl, apiKey } : { baseUrl }),
      model
    }
  }

  return { provider: new MockProvider(), model }
}

export function createProviderFromEnv(): { provider: LlmProvider; model: string } {
  const kind = (process.env.CODECLI_PROVIDER ?? "mock").toLowerCase()
  const model = process.env.CODECLI_MODEL ?? "gpt-4.1-mini"

  if (kind === "openai" || kind === "openai-compatible") {
    const baseUrl = process.env.CODECLI_BASE_URL ?? "https://api.openai.com"
    const apiKey = process.env.CODECLI_API_KEY
    return {
      provider: new OpenAICompatibleProvider(apiKey ? { baseUrl, apiKey } : { baseUrl }),
      model
    }
  }

  return { provider: new MockProvider(), model }
}
