import { promises as fs } from "node:fs"
import path from "node:path"

export type WorkspaceOptions = {
  rootDir: string
  maxFileBytes?: number
}

export class Workspace {
  private readonly rootDir: string
  private readonly maxFileBytes: number

  constructor(opts: WorkspaceOptions) {
    this.rootDir = path.resolve(opts.rootDir)
    this.maxFileBytes = opts.maxFileBytes ?? 1024 * 1024
  }

  resolvePath(relPath: string): string {
    const resolved = path.resolve(this.rootDir, relPath)
    const rel = path.relative(this.rootDir, resolved)
    const isInside = !rel.startsWith("..") && !path.isAbsolute(rel)
    if (!isInside) throw new Error("Path escapes workspace root")
    return resolved
  }

  async readText(relPath: string): Promise<string> {
    const abs = this.resolvePath(relPath)
    const stat = await fs.stat(abs)
    if (stat.size > this.maxFileBytes) throw new Error("File too large")
    return fs.readFile(abs, "utf8")
  }

  async writeText(relPath: string, content: string): Promise<void> {
    const abs = this.resolvePath(relPath)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, "utf8")
  }

  async listFiles(relDir: string, opts?: { recursive?: boolean; maxDepth?: number }): Promise<string[]> {
    const recursive = opts?.recursive ?? false
    const maxDepth = opts?.maxDepth ?? 10
    const startAbs = this.resolvePath(relDir)
    const out: string[] = []

    const walk = async (absDir: string, depth: number) => {
      if (depth > maxDepth) return
      const entries = await fs.readdir(absDir, { withFileTypes: true })
      for (const ent of entries) {
        const abs = path.join(absDir, ent.name)
        const rel = path.relative(this.rootDir, abs)
        if (ent.isDirectory()) {
          if (recursive) await walk(abs, depth + 1)
          continue
        }
        out.push(rel)
      }
    }

    await walk(startAbs, 0)
    return out.sort()
  }
}
