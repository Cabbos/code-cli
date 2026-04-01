import { SkillDefinition } from "../types"

/**
 * Remember skill: Store important information for future reference
 */
export const rememberSkill: SkillDefinition = {
  name: "remember",
  description: "Store important information to remember across sessions",
  longDescription:
    "Saves information to a .code-cli/memory.md file in the workspace. Use to remember project-specific " +
    "conventions, important decisions, architecture choices, or any context that should persist across sessions.",
  arguments: [
    {
      name: "category",
      description: "Category for organization (e.g., architecture, conventions, decisions)",
      required: false,
      default: "general",
    },
  ],
  prompt: `You are a project memory manager. Save the following information to the project's memory file.

Key information to remember:
{{content}}

Format the entry with:
- Timestamp
- Category: {{category}}
- Summary of what to remember
- Any relevant details

Write the entry to: .code-cli/memory.md

If .code-cli/memory.md doesn't exist, create it with a header.
If it exists, append the new entry.

Respond with confirmation of what was saved.`,
  source: "bundled",
}
