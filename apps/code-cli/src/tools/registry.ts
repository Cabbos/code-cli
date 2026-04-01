import { ToolContext, ToolDefinition } from "./types"
import { ToolPolicy, isToolAllowed, needsConfirmation } from "./policy"
import { validateJsonSchema } from "./validate"
import { isToolAllowedInSkillContext, getAllowedTools } from "../skills/skillContext"

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any, any>>()
  private policy: ToolPolicy | undefined

  constructor(opts?: { policy?: ToolPolicy }) {
    this.policy = opts?.policy
  }

  setPolicy(policy: ToolPolicy | undefined): void {
    this.policy = policy
  }

  register<I, O>(tool: ToolDefinition<I, O>): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool as ToolDefinition<any, any>)
  }

  list(): Array<Pick<ToolDefinition, "name" | "description">> {
    return [...this.tools.values()]
      .map((t) => ({ name: t.name, description: t.description }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  all(): Array<ToolDefinition<any, any>> {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  async call(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool) throw new Error(`Unknown tool: ${name}`)
    const allowed = isToolAllowed(name, this.policy)
    if (!allowed.ok) throw new Error(`Tool blocked by policy: ${allowed.reason}`)

    // Check skill context restrictions (if a skill is active)
    if (!isToolAllowedInSkillContext(name)) {
      const allowedTools = getAllowedTools()
      throw new Error(
        `Tool "${name}" is not allowed in the current skill context. ` +
        `Allowed tools: ${allowedTools?.join(", ") || "none"}`
      )
    }

    if (tool.inputSchema) {
      const vr = validateJsonSchema(tool.inputSchema, input)
      if (!vr.ok) throw new Error(`Invalid tool input: ${vr.error}`)
    }
    if (needsConfirmation(name, this.policy)) {
      if (!ctx.confirm) throw new Error("Tool requires confirmation, but no confirm handler is available")
      const ok = await ctx.confirm({ name, input })
      if (!ok) throw new Error("Tool denied by user")
    }
    return tool.invoke(input, ctx)
  }
}
