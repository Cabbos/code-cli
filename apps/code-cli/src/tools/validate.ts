type JsonSchema =
  | { type: "string" }
  | { type: "number" }
  | { type: "integer" }
  | { type: "boolean" }
  | { type: "array"; items?: JsonSchema }
  | {
      type: "object"
      properties?: Record<string, JsonSchema>
      required?: string[]
      additionalProperties?: boolean
    }

export type ValidationResult = { ok: true } | { ok: false; error: string }

export function validateJsonSchema(schema: unknown, value: unknown): ValidationResult {
  const s = coerceSchema(schema)
  if (!s) return { ok: true }
  const errors: string[] = []
  validateValue(s, value, "$", errors)
  if (!errors.length) return { ok: true }
  return { ok: false, error: errors.join("; ") }
}

function validateValue(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.type === "string") {
    if (typeof value !== "string") errors.push(`${path} should be string`)
    return
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) errors.push(`${path} should be number`)
    return
  }
  if (schema.type === "integer") {
    if (typeof value !== "number" || Number.isNaN(value) || !Number.isInteger(value)) errors.push(`${path} should be integer`)
    return
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${path} should be boolean`)
    return
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path} should be array`)
      return
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) validateValue(schema.items, value[i], `${path}[${i}]`, errors)
    }
    return
  }
  if (schema.type === "object") {
    if (!isRecord(value)) {
      errors.push(`${path} should be object`)
      return
    }
    const props = schema.properties ?? {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const k of required) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) errors.push(`${path}.${k} is required`)
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) errors.push(`${path}.${k} is not allowed`)
      }
    }
    for (const [k, child] of Object.entries(props)) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue
      validateValue(child, value[k], `${path}.${k}`, errors)
    }
    return
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function coerceSchema(schema: unknown): JsonSchema | undefined {
  if (!isRecord(schema)) return undefined
  const type = schema.type
  if (type === "string") return { type: "string" }
  if (type === "number") return { type: "number" }
  if (type === "integer") return { type: "integer" }
  if (type === "boolean") return { type: "boolean" }
  if (type === "array") {
    const items = schema.items
    const coercedItems = coerceSchema(items)
    return coercedItems ? { type: "array", items: coercedItems } : { type: "array" }
  }
  if (type === "object") {
    const properties = isRecord(schema.properties) ? (schema.properties as Record<string, unknown>) : undefined
    const coercedProps: Record<string, JsonSchema> | undefined = properties
      ? Object.fromEntries(
          Object.entries(properties)
            .map(([k, v]) => [k, coerceSchema(v)])
            .filter(([, v]) => Boolean(v)) as Array<[string, JsonSchema]>
        )
      : undefined
    const required = Array.isArray(schema.required) ? (schema.required.filter((x) => typeof x === "string") as string[]) : undefined
    const additionalProperties =
      typeof schema.additionalProperties === "boolean" ? (schema.additionalProperties as boolean) : undefined
    return {
      type: "object",
      ...(coercedProps ? { properties: coercedProps } : {}),
      ...(required ? { required } : {}),
      ...(typeof additionalProperties === "boolean" ? { additionalProperties } : {})
    }
  }
  return undefined
}

