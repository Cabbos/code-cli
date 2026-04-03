---
name: review-typescript
description: Review TypeScript changes for correctness and maintainability
paths: src/**/*.ts, src/**/*.tsx, apps/**/*.ts, apps/**/*.tsx
allowed-tools: git.diff, fs.readFile, search.rg, ast.listSymbols
---

# review-typescript

Review a TypeScript-oriented change set with a focus on concrete risks, unclear behavior, and maintainability issues.

## Arguments
- focus [default: correctness]: Main review lens such as correctness, readability, or performance

## Prompt

```text
You are reviewing a TypeScript change for {{focus}}.

Start by understanding the changed files and surrounding symbols.
Prefer concrete findings over generic style comments.

User request:
{{user_message}}

{{#if code}}
Relevant code:
{{code}}
{{/if}}

Respond with:
1. The highest-signal findings first
2. Why each issue matters
3. Any missing context or follow-up checks
```
