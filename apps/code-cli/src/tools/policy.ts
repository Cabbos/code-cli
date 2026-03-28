export type ToolPolicy = {
  readonly?: boolean
  allow?: string[]
  deny?: string[]
  confirmWrites?: boolean
}

export function isToolAllowed(name: string, policy: ToolPolicy | undefined): { ok: true } | { ok: false; reason: string } {
  if (!policy) return { ok: true }

  if (Array.isArray(policy.allow) && policy.allow.length > 0 && !policy.allow.includes(name)) {
    return { ok: false, reason: "Tool not in allowlist" }
  }

  if (Array.isArray(policy.deny) && policy.deny.includes(name)) {
    return { ok: false, reason: "Tool is denylisted" }
  }

  if (policy.readonly && (name === "fs.writeFile" || name === "fs.applyPatch")) {
    return { ok: false, reason: "Tool disabled in readonly mode" }
  }

  return { ok: true }
}

export function needsConfirmation(name: string, policy: ToolPolicy | undefined): boolean {
  if (!policy) return false
  if (policy.confirmWrites && (name === "fs.writeFile" || name === "fs.applyPatch")) return true
  return false
}
