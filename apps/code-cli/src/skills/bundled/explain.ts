import { SkillDefinition } from "../types"

/**
 * Explain skill: Explain code in detail
 */
export const explainSkill: SkillDefinition = {
  name: "explain",
  description: "Explain what code does in detail",
  longDescription:
    "Provides a thorough explanation of code including: overall purpose, how pieces fit together, " +
    "data flow, key algorithms, and any non-obvious decisions.",
  arguments: [
    {
      name: "language",
      description: "Programming language",
      required: false,
      default: "typescript",
    },
    {
      name: "level",
      description: "Explanation depth (brief, standard, detailed)",
      required: false,
      default: "standard",
    },
  ],
  prompt: `You are a code explainer. Explain the following {{language}} code{{#if error}} with error: {{error}}{{/if}}.

Provide a {{level}} explanation:
- **Purpose**: What this code does overall
- **Key Components**: Main parts and their roles
- **Data Flow**: How data moves through the code
- **Edge Cases**: Potential issues or limitations

=== CODE TO EXPLAIN ===

{{code}}

=== END CODE ===`,
  source: "bundled",
}
