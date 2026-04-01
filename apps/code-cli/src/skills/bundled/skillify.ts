import { SkillDefinition } from "../types"

/**
 * Skillify skill: Create a new skill from a conversation
 */
export const skillifySkill: SkillDefinition = {
  name: "skillify",
  description: "Create a new skill from a useful conversation or workflow",
  longDescription:
    "Transforms a useful exchange or workflow into a reusable skill definition (SKILL.md format). " +
    "The generated skill can be saved to .code-cli/skills/<name>/SKILL.md for future use.",
  arguments: [
    {
      name: "name",
      description: "Name for the new skill (kebab-case, e.g., my-custom-skill)",
      required: true,
    },
    {
      name: "description",
      description: "One-line description of what the skill does",
      required: true,
    },
  ],
  prompt: `You are a skill designer. Create a SKILL.md file for a new skill based on the conversation.

Skill name: {{name}}
Description: {{description}}

Based on this conversation/workflow:

{{conversation}}

Create a SKILL.md file with:

1. Frontmatter with name and description
2. A # Title heading
3. Optional ## Long Description section
4. Optional ## Arguments section using bullets like:
   - argument_name (required): Description
   - optional_name [default: value]: Description
5. A ## Prompt section with a fenced code block
6. Placeholder syntax limited to double-brace variable names and simple if-block conditionals

Save to: .code-cli/skills/{{name}}/SKILL.md

Make the skill reusable and parameterized where appropriate.`,
  source: "bundled",
}
