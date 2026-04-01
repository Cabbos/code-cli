export type LlmConfig = {
  provider: string
  model: string
  baseUrl?: string
  apiKey?: string
}

export type SessionsConfig = {
  dir?: string
}

export type ToolsConfig = {
  readonly?: boolean
  allow?: string[]
  deny?: string[]
  confirmWrites?: boolean
}

export type AgentConfig = {
  systemPrompt?: string
}

export type FeatureFlagsConfig = {
  flags?: Record<string, boolean>
}

export type CodeCliConfig = {
  llm: LlmConfig
  sessions: SessionsConfig
  tools: ToolsConfig
  agent: AgentConfig
  features?: FeatureFlagsConfig
}

export type CodeCliConfigOverrides = {
  llm?: Partial<LlmConfig>
  sessions?: Partial<SessionsConfig>
  tools?: Partial<ToolsConfig>
  agent?: Partial<AgentConfig>
  features?: Partial<FeatureFlagsConfig>
}
