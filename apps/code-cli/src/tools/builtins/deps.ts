import { execSync } from "node:child_process"
import path from "node:path"
import { ToolDefinition } from "../types"

type DepEntry = {
  name: string
  version: string
  type: "prod" | "dev" | "peer" | "optional"
}

interface NpmLsNode {
  name?: string
  version?: string
  path?: string
  dependencies?: Record<string, NpmLsNode>
  dev?: boolean
  peer?: boolean
  optional?: boolean
  missing?: boolean
  peerMissing?: boolean
}

export const listDepsTool: ToolDefinition<
  { packageJsonPath?: string; includeDev?: boolean; includePeer?: boolean; includeOptional?: boolean },
  { dependencies: DepEntry[]; root: string }
> = {
  name: "deps.list",
  description: "List all dependencies from a package.json file. Supports filtering by type (prod, dev, peer, optional).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      packageJsonPath: { type: "string" },
      includeDev: { type: "boolean", default: true },
      includePeer: { type: "boolean", default: false },
      includeOptional: { type: "boolean", default: false }
    }
  },
  async invoke(input, ctx) {
    const pkgPath = input.packageJsonPath ?? "package.json"
    ctx.workspace.resolvePath(pkgPath)
    const content = await ctx.workspace.readText(pkgPath)
    const pkg = JSON.parse(content)

    const deps: DepEntry[] = []

    if (input.includeDev !== false && pkg.devDependencies) {
      for (const [name, version] of Object.entries(pkg.devDependencies as Record<string, string>)) {
        deps.push({ name, version: String(version), type: "dev" })
      }
    }
    if (pkg.dependencies) {
      for (const [name, version] of Object.entries(pkg.dependencies as Record<string, string>)) {
        deps.push({ name, version: String(version), type: "prod" })
      }
    }
    if (input.includePeer && pkg.peerDependencies) {
      for (const [name, version] of Object.entries(pkg.peerDependencies as Record<string, string>)) {
        deps.push({ name, version: String(version), type: "peer" })
      }
    }
    if (input.includeOptional && pkg.optionalDependencies) {
      for (const [name, version] of Object.entries(pkg.optionalDependencies as Record<string, string>)) {
        deps.push({ name, version: String(version), type: "optional" })
      }
    }

    return { dependencies: deps, root: ctx.workspace.root }
  }
}

export const outdatedTool: ToolDefinition<
  { packageJsonPath?: string; json?: boolean },
  { outdated: OutdatedEntry[]; error?: string }
> = {
  name: "deps.outdated",
  description: "Check for outdated npm packages. Shows current, wanted, latest, and dependency type for each outdated package.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      packageJsonPath: { type: "string" },
      json: { type: "boolean", default: true }
    }
  },
  async invoke(input, ctx) {
    const cwd = ctx.workspace.root
    try {
      const result = execSync("npm ls --depth=999 --json 2>/dev/null || true", {
        cwd,
        encoding: "utf-8",
        timeout: 30_000
      })
      const tree = JSON.parse(result) as NpmLsNode
      const outdated = flattenOutdated(tree)
      return { outdated }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { outdated: [], error: `Failed to check outdated: ${msg}` }
    }
  }
}

type OutdatedEntry = {
  name: string
  current: string
  wanted: string
  latest: string
  location: string
  type: string
}

function flattenOutdated(node: NpmLsNode | undefined, result: OutdatedEntry[] = [], type = "prod"): OutdatedEntry[] {
  if (!node || typeof node !== "object") return result

  if (node.peerMissing) {
    for (const [name, info] of Object.entries(node.peerMissing)) {
      result.push({
        name,
        current: (info as { required?: string }).required || "missing",
        wanted: (info as { required?: string }).required || "?",
        latest: "?",
        location: node.path || "",
        type: "peer"
      })
    }
  }

  if (node.dependencies) {
    for (const [name, dep] of Object.entries(node.dependencies)) {
      const d = dep as NpmLsNode
      const depType = d.dev ? "dev" : d.peer ? "peer" : d.optional ? "optional" : "prod"
      if (d.missing || d.peerMissing) {
        result.push({
          name,
          current: "missing",
          wanted: d.version || "?",
          latest: "?",
          location: d.path || "",
          type: depType
        })
      }
      flattenOutdated(d, result, depType)
    }
  }

  return result
}

export const graphTool: ToolDefinition<
  { packageJsonPath?: string; format?: "dot" | "json"; maxDepth?: number },
  { graph: string; nodeCount: number; edgeCount: number }
> = {
  name: "deps.graph",
  description: "Generate a dependency graph for the project. Outputs DOT format (for Graphviz) or JSON. Shows package relationships up to maxDepth.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      packageJsonPath: { type: "string" },
      format: { type: "string", enum: ["dot", "json"], default: "dot" },
      maxDepth: { type: "number", default: 2 }
    }
  },
  async invoke(input, ctx) {
    const cwd = ctx.workspace.root
    const maxDepth = input.maxDepth ?? 2
    const format = input.format ?? "dot"

    try {
      const result = execSync(`npm ls --all --depth=${maxDepth} --json 2>/dev/null || echo '{}'`, {
        cwd,
        encoding: "utf-8",
        timeout: 30_000
      })
      const tree = JSON.parse(result) as NpmLsNode
      const nodes = new Set<string>()
      const edges: [string, string][] = []

      function traverse(node: NpmLsNode | undefined, depth = 0) {
        if (!node || typeof node !== "object" || depth > maxDepth) return
        if (node.name) nodes.add(node.name)
        if (node.dependencies) {
          for (const [name, dep] of Object.entries(node.dependencies)) {
            const d = dep as NpmLsNode
            nodes.add(name)
            edges.push([node.name || "root", name])
            traverse(d, depth + 1)
          }
        }
      }

      traverse(tree)

      if (format === "json") {
        const graph = { nodes: Array.from(nodes), edges }
        return { graph: JSON.stringify(graph, null, 2), nodeCount: nodes.size, edgeCount: edges.length }
      }

      const dotLines = ["digraph deps {", "  rankdir=LR;", "  node [shape=box];", ""]
      for (const n of nodes) {
        dotLines.push(`  "${n}";`)
      }
      dotLines.push("")
      for (const [from, to] of edges) {
        dotLines.push(`  "${from}" -> "${to}";`)
      }
      dotLines.push("}")

      return { graph: dotLines.join("\n"), nodeCount: nodes.size, edgeCount: edges.length }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { graph: `// Error: ${msg}`, nodeCount: 0, edgeCount: 0 }
    }
  }
}

export const conflictsTool: ToolDefinition<
  { packageJsonPath?: string },
  { conflicts: ConflictEntry[]; ok: boolean }
> = {
  name: "deps.conflicts",
  description: "Detect version conflicts in the dependency tree. Checks for mismatched versions of the same package across different branches.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      packageJsonPath: { type: "string" }
    }
  },
  async invoke(input, ctx) {
    const cwd = ctx.workspace.root
    const maxDepth = 100

    try {
      const result = execSync(`npm ls --all --depth=${maxDepth} --json 2>/dev/null || echo '{}'`, {
        cwd,
        encoding: "utf-8",
        timeout: 30_000
      })
      const tree = JSON.parse(result) as NpmLsNode
      const pkgVersions = new Map<string, Map<string, string>>()

      function collect(node: NpmLsNode | undefined, path: string[] = [], depth = 0) {
        if (!node || typeof node !== "object" || depth > maxDepth) return
        if (node.name && node.version) {
          const pkg = node.name
          if (!pkgVersions.has(pkg)) pkgVersions.set(pkg, new Map())
          pkgVersions.get(pkg)!.set(node.version, path.join(" > "))
        }
        if (node.dependencies && depth < maxDepth) {
          for (const [, dep] of Object.entries(node.dependencies)) {
            collect(dep as NpmLsNode, [...path, node.name || "root"], depth + 1)
          }
        }
      }

      collect(tree)

      const conflicts: ConflictEntry[] = []
      for (const [pkg, versions] of pkgVersions) {
        if (versions.size > 1) {
          const entries: { version: string; via: string }[] = []
          for (const [version, via] of versions) {
            entries.push({ version, via: via || "(root)" })
          }
          conflicts.push({ package: pkg, versions: entries })
        }
      }

      return { conflicts, ok: conflicts.length === 0 }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { conflicts: [], ok: false }
    }
  }
}

type ConflictEntry = {
  package: string
  versions: { version: string; via: string }[]
}

export const whyTool: ToolDefinition<
  { packageName: string; packageJsonPath?: string },
  { reason: string; foundIn: string[] }
> = {
  name: "deps.why",
  description: "Explain why a package is installed. Shows which packages depend on it (reverse dependency analysis).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      packageName: { type: "string" },
      packageJsonPath: { type: "string" }
    },
    required: ["packageName"]
  },
  async invoke(input, ctx) {
    if (!input?.packageName) {
      return { reason: "Missing packageName", foundIn: [] }
    }

    const cwd = ctx.workspace.root
    const pkgName = input.packageName

    try {
      const result = execSync(`npm ls --all --depth=999 --json 2>/dev/null || echo '{}'`, {
        cwd,
        encoding: "utf-8",
        timeout: 30_000
      })
      const tree = JSON.parse(result) as NpmLsNode
      const foundIn: string[] = []

      function search(node: NpmLsNode | undefined, path: string[] = []) {
        if (!node || typeof node !== "object") return
        if (node.name) {
          if (node.dependencies?.[pkgName]) {
            const prefix = path.length > 0 ? path.join(" > ") + " > " : ""
            foundIn.push(prefix + node.name + ` (depends on ${pkgName})`)
          }
        }
        if (node.dependencies) {
          for (const [, dep] of Object.entries(node.dependencies)) {
            search(dep as NpmLsNode, [...path, node.name || "root"])
          }
        }
      }

      search(tree)

      if (foundIn.length === 0) {
        const rootPkg = JSON.parse(await ctx.workspace.readText("package.json")) as any
        const isDirect = rootPkg.dependencies?.[pkgName] || rootPkg.devDependencies?.[pkgName]
        return {
          reason: isDirect
            ? `${pkgName} is a direct dependency declared in package.json`
            : `${pkgName} is a transitive dependency. Run 'npm explain ${pkgName}' for details.`,
          foundIn: []
        }
      }

      return {
        reason: `${pkgName} is required by ${foundIn.length} package(s):`,
        foundIn
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { reason: `Error: ${msg}`, foundIn: [] }
    }
  }
}
