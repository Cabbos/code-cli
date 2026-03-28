import { promises as fs } from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { LlmMessage } from "../llm/types"

export type SessionRecord = {
  id: string
  createdAt: string
  updatedAt: string
  messages: LlmMessage[]
}

export class SessionStore {
  private readonly dir: string

  constructor(opts: { dir: string }) {
    this.dir = path.resolve(opts.dir)
  }

  async create(initialMessages: LlmMessage[]): Promise<SessionRecord> {
    const now = new Date().toISOString()
    const rec: SessionRecord = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      messages: initialMessages
    }
    await this.save(rec)
    return rec
  }

  async load(id: string): Promise<SessionRecord> {
    const filePath = this.sessionPath(id)
    const raw = await fs.readFile(filePath, "utf8")
    const data = JSON.parse(raw) as unknown
    if (!isSessionRecord(data)) throw new Error(`Invalid session file: ${filePath}`)
    return data
  }

  async save(rec: SessionRecord): Promise<void> {
    const now = new Date().toISOString()
    const updated: SessionRecord = { ...rec, updatedAt: now }
    await fs.mkdir(this.dir, { recursive: true })
    const filePath = this.sessionPath(rec.id)
    await fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf8")
    rec.updatedAt = updated.updatedAt
  }

  async list(): Promise<Array<{ id: string; updatedAt: string; messageCount: number }>> {
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true })
      const out: Array<{ id: string; updatedAt: string; messageCount: number }> = []
      for (const ent of entries) {
        if (!ent.isFile()) continue
        if (!ent.name.endsWith(".json")) continue
        const id = ent.name.replace(/\.json$/i, "")
        try {
          const rec = await this.load(id)
          out.push({ id: rec.id, updatedAt: rec.updatedAt, messageCount: rec.messages.length })
        } catch {
          continue
        }
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } catch (err) {
      if (err instanceof Error) {
        const anyErr = err as { code?: string }
        if (anyErr.code === "ENOENT") return []
      }
      throw err
    }
  }

  async export(id: string): Promise<string> {
    const rec = await this.load(id)
    return JSON.stringify(rec, null, 2)
  }

  private sessionPath(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "")
    return path.join(this.dir, `${safe}.json`)
  }
}

function isSessionRecord(v: unknown): v is SessionRecord {
  if (!isPlainObject(v)) return false
  if (typeof v.id !== "string") return false
  if (typeof v.createdAt !== "string") return false
  if (typeof v.updatedAt !== "string") return false
  if (!Array.isArray(v.messages)) return false
  return true
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype
}
