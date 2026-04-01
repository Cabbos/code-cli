import { SkillDefinition } from "../types"

/**
 * Debug skill: Help diagnose and fix bugs
 */
export const debugSkill: SkillDefinition = {
  name: "debug",
  description: "Diagnose bugs and suggest fixes with explanations",
  longDescription:
    "Takes problematic code and error messages to identify root causes, explain what went wrong, " +
    "and provide a corrected implementation with explanation of the fix.",
  arguments: [
    {
      name: "error",
      description: "Error message or description of the bug",
      required: false,
    },
    {
      name: "language",
      description: "Programming language",
      required: false,
      default: "typescript",
    },
  ],
  prompt: `You are an expert debugger. Analyze the issue below and identify:

{{#if problem}}
Problem report:
{{problem}}
{{/if}}

{{#if error}}
Reported error:
{{error}}
{{/if}}

{{#if code}}
Code under investigation ({{language}}):
{{code}}
{{/if}}

1. **Root Cause** - What specifically is causing the bug
2. **Explanation** - Why this causes the problem
3. **Fix** - The corrected code with the fix applied

Be specific and technical. If multiple issues exist, identify the most critical first.`,
  source: "bundled",
}
