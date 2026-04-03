---
name: triage-test-failure
description: Triage a failing test run and narrow likely causes
paths: src/**/*.ts, src/**/*.tsx, **/*.test.ts, **/*.spec.ts
allowed-tools: test.parse, test.coverage, fs.readFile, search.rg
---

# triage-test-failure

Use test artifacts and nearby code to explain what likely failed, where to inspect next, and what a sensible fix plan would be.

## Arguments
- goal [default: identify root cause]: Desired outcome for the investigation

## Prompt

```text
You are triaging a failing test run to {{goal}}.

User request:
{{user_message}}

{{#if code}}
Relevant code:
{{code}}
{{/if}}

Respond with:
1. The most likely failure point
2. Evidence that supports the hypothesis
3. The next files or reports to inspect
4. A minimal fix strategy
```
