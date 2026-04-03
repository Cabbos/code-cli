import { describe, expect, it } from "vitest"
import { formatTraceSummary, summarizeTraceEvents, TraceEventRecord } from "./traceSummary"

describe("traceSummary", () => {
  it("summarizes tool and skill activity", () => {
    const events: TraceEventRecord[] = [
      { type: "run.start", mode: "run", workspace: "/tmp/workspace", ts: 100 },
      { type: "turn.start", ts: 110 },
      { type: "llm.complete", ts: 120 },
      { type: "skill.invoke", requestedName: "remember", ts: 130 },
      { type: "skill.resolve", skillName: "remember", source: "bundled", ts: 140 },
      { type: "skill.render", skillName: "remember", source: "bundled", warningCount: 1, ts: 150 },
      { type: "skill.activate", skillName: "remember", source: "bundled", ts: 160 },
      { type: "tool.call", internalName: "fs.readFile", ts: 170 },
      { type: "tool.result", truncated: true, ts: 180 },
      { type: "skill.clear", skillName: "remember", source: "bundled", ts: 190 },
      { type: "tool.error", internalName: "search.rg", ts: 200 },
      { type: "skill.error", requestedName: "missing-skill", ts: 210 }
    ]

    const summary = summarizeTraceEvents(events)

    expect(summary.mode).toBe("run")
    expect(summary.turns).toBe(1)
    expect(summary.toolCallCount).toBe(1)
    expect(summary.toolErrorCount).toBe(1)
    expect(summary.skillErrorCount).toBe(1)
    expect(summary.truncatedToolResults).toBe(1)
    expect(summary.skills).toEqual([
      {
        name: "remember",
        source: "bundled",
        invoked: 1,
        resolved: 1,
        activated: 1,
        cleared: 1,
        warnings: 1
      }
    ])

    const formatted = formatTraceSummary(summary)
    expect(formatted).toContain("Tools:")
    expect(formatted).toContain("fs.readFile x1")
    expect(formatted).toContain("remember [bundled] invoke:1 resolve:1 activate:1 clear:1 warnings:1")
    expect(formatted).toContain("tool errors: 1")
  })
})
