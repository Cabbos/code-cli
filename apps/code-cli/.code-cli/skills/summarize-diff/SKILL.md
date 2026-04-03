---
name: summarize-diff
description: Summarize the current git diff for a reviewer or teammate
allowed-tools: git.status, git.diff, fs.readFile
---

# summarize-diff

Summarize the current working tree in a way that helps another engineer quickly understand what changed and why.

## Arguments
- audience [default: engineer]: Intended audience such as engineer, reviewer, or manager

## Prompt

```text
You are summarizing the current git diff for a {{audience}}.

User request:
{{user_message}}

Produce:
1. A short high-level summary
2. The main changed areas
3. Risks, follow-ups, or validation notes
4. Any files that deserve a closer read
```
