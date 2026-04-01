/**
 * Feature Flags system for code-cli skills.
 *
 * Feature flags control which skills are enabled/disabled at runtime.
 * Priority: CODECLI_FEATURE_<NAME> env var > config.json features.flags > built-in defaults
 */

let cachedFeatureFlags: Record<string, boolean> | undefined = undefined

const DEFAULT_FEATURE_FLAGS: Record<string, boolean> = {
  skill_shell_execution: false
}

function normalizeFlagName(name: string): string {
  return name.toLowerCase().replace(/-/g, "_")
}

function parseFeatureFlagValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined

  const normalized = value.trim().toLowerCase()
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") return true
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false
  return Boolean(normalized)
}

/**
 * Check if a feature flag is enabled.
 * Uses cached flags after first call.
 *
 * @param name - The feature flag name (e.g., "simplify" enables "simplify" skill)
 * @param configFlags - Optional feature flags from config (used if no env var)
 */
export function isFeatureEnabled(
  name: string,
  configFlags?: Record<string, boolean>
): boolean {
  const normalizedName = normalizeFlagName(name)

  const envKey = `CODECLI_FEATURE_${normalizedName.toUpperCase()}`
  const envValue = parseFeatureFlagValue(process.env[envKey])
  if (envValue !== undefined) {
    return envValue
  }

  const effectiveConfigFlags = configFlags ?? cachedFeatureFlags
  if (effectiveConfigFlags && Object.prototype.hasOwnProperty.call(effectiveConfigFlags, normalizedName)) {
    return Boolean(effectiveConfigFlags[normalizedName])
  }

  if (Object.prototype.hasOwnProperty.call(DEFAULT_FEATURE_FLAGS, normalizedName)) {
    return DEFAULT_FEATURE_FLAGS[normalizedName] as boolean
  }

  return true
}

/**
 * Initialize feature flags cache from config.
 * Call this once at startup with the loaded config.
 */
export function initFeatureFlags(configFlags?: Record<string, boolean>): void {
  if (!configFlags) {
    cachedFeatureFlags = {}
    return
  }

  cachedFeatureFlags = Object.fromEntries(
    Object.entries(configFlags).map(([name, value]) => [normalizeFlagName(name), value])
  )
}

export function resetFeatureFlags(): void {
  cachedFeatureFlags = undefined
}

/**
 * Get a feature flag value with caching.
 */
export function isFeatureEnabledCached(name: string): boolean {
  return isFeatureEnabled(name, cachedFeatureFlags)
}

/**
 * Get all feature flag values as an object.
 */
export function getAllFeatureFlags(): Record<string, boolean> {
  const flags: Record<string, boolean> = { ...DEFAULT_FEATURE_FLAGS }

  if (cachedFeatureFlags) {
    for (const [name, value] of Object.entries(cachedFeatureFlags)) {
      flags[normalizeFlagName(name)] = value
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CODECLI_FEATURE_")) {
      const flagName = key.slice("CODECLI_FEATURE_".length).toLowerCase()
      flags[flagName] = parseFeatureFlagValue(value) ?? false
    }
  }

  return flags
}
