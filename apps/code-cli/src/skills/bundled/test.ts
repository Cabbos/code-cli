import { SkillDefinition } from "../types"

/**
 * Test skill: Generate tests for code
 */
export const testSkill: SkillDefinition = {
  name: "test",
  description: "Generate unit tests for the provided code",
  longDescription:
    "Generates comprehensive unit tests for the given code. Supports common testing patterns " +
    "including happy path, edge cases, and error conditions.",
  arguments: [
    {
      name: "framework",
      description: "Testing framework (e.g., vitest, jest, mocha)",
      required: false,
      default: "vitest",
    },
    {
      name: "language",
      description: "Programming language",
      required: false,
      default: "typescript",
    },
  ],
  prompt: `You are a test generation expert. Generate comprehensive unit tests for the following {{language}} code using {{framework}}.

Include:
- Happy path tests for main functionality
- Edge case tests
- Error condition tests
- Proper setup/teardown if needed

=== CODE TO TEST ===

{{code}}

=== END CODE ===

Output only the test file content in a markdown code block.`,
  source: "bundled",
}
