import { SkillDefinition } from "../types"

/**
 * Simplify skill: Refactor code to be more readable and concise
 */
export const simplifySkill: SkillDefinition = {
  name: "simplify",
  description: "Refactor code to be more readable, concise, and idiomatic",
  longDescription:
    "Analyzes the provided code and suggests simplifications including: removing redundant logic, " +
    "consolidating nested conditionals, replacing complex patterns with simpler alternatives, " +
    "using more idiomatic language features, and improving variable naming.",
  arguments: [
    {
      name: "language",
      description: "Programming language (e.g., typescript, python)",
      required: false,
      default: "typescript",
    },
  ],
  prompt: `You are a code simplification expert. Given the code below, refactor it to be more:

1. **Readable** - Clear intent, good naming, logical structure
2. **Concise** - Remove redundancy, no dead code, minimal boilerplate
3. **Idiomatic** - Use language idioms, best practices for {{language}}

Respond with:
1. Brief explanation of what simplified
2. The simplified code in a markdown code block

=== CODE TO SIMPLIFY ===

{{code}}

=== END CODE ===

Provide only the simplified version, no other commentary.`,
  source: "bundled",
}
