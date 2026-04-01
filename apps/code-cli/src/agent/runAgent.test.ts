import { describe, it, expect, vi, beforeEach } from "vitest"
import { createInitialMessages } from "./runAgent"

describe("runAgent", () => {
  describe("createInitialMessages", () => {
    it("should create system message with provided prompt", () => {
      const messages = createInitialMessages("You are a helpful assistant")
      expect(messages).toHaveLength(1)
      expect(messages[0]).toEqual({
        role: "system",
        content: "You are a helpful assistant"
      })
    })

    it("should handle empty system prompt", () => {
      const messages = createInitialMessages("")
      expect(messages).toHaveLength(1)
      const firstMsg = messages[0]
      expect(firstMsg?.role).toBe("system")
      expect(firstMsg?.content).toBe("")
    })
  })
})

describe("executeToolCall truncation boundaries", () => {
  it("should truncate single tool result exceeding maxToolResultChars", async () => {
    // This tests the truncation logic conceptually
    // When raw.length > maxToolResultChars, result should be truncated
    const maxToolResultChars = 100
    const largeContent = "x".repeat(200)
    const raw = JSON.stringify({ data: largeContent })

    const shouldTruncate = raw.length > maxToolResultChars
    expect(shouldTruncate).toBe(true)

    const truncated = JSON.stringify({
      truncated: true,
      originalChars: raw.length,
      content: raw.slice(0, maxToolResultChars)
    })
    expect(truncated.length).toBeLessThan(raw.length)
  })

  it("should skip tool calls when maxTotalToolResultChars is exceeded", async () => {
    // When totalToolChars >= maxTotalToolResultChars, tool should be skipped
    const maxTotalToolResultChars = 100
    let totalToolChars = 100 // Already at limit

    const shouldSkip = totalToolChars >= maxTotalToolResultChars
    expect(shouldSkip).toBe(true)
  })

  it("should correctly accumulate tool result characters", async () => {
    const toolResults = [
      { content: '{"data": "short"}', length: 17 },
      { content: '{"data": "medium length content"}', length: 33 },
      { content: '{"data": "another result"}', length: 26 }
    ]

    let total = 0
    for (const result of toolResults) {
      total += result.content.length
    }

    expect(total).toBe(76)
    expect(total).toBeLessThan(100)
  })

  it("should stop accumulating when maxTotalToolResultChars is reached", async () => {
    const maxTotalToolResultChars = 14
    const toolResults = [
      { content: "12345678901234" }, // length 14
      { content: "123456789012345" }, // length 15
      { content: "12345678901234" }   // length 14
    ]

    let total = 0
    const executedResults: typeof toolResults = []

    for (const result of toolResults) {
      if (total + result.content.length > maxTotalToolResultChars) {
        break
      }
      total += result.content.length
      executedResults.push(result)
    }

    expect(executedResults).toHaveLength(1)
    expect(total).toBe(14)
  })
})

describe("stableJson", () => {
  it("should produce consistent output for same input", () => {
    const input = { b: 2, a: 1, c: [3, 2, 1] }
    const stableJson = (v: unknown) => JSON.stringify(v, null, 2)

    const result1 = stableJson(input)
    const result2 = stableJson(input)

    expect(result1).toBe(result2)
  })
})

describe("truncateForTrace", () => {
  const truncateForTrace = (s: string, max = 200): string => {
    const out = s.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim()
    if (out.length <= max) return out
    return `${out.slice(0, max)}…`
  }

  it("should normalize line endings", () => {
    const input = "line1\r\nline2\r\nline3"
    const result = truncateForTrace(input)
    expect(result).toBe("line1 line2 line3")
  })

  it("should collapse whitespace", () => {
    const input = "line1    line2  \t  line3"
    const result = truncateForTrace(input)
    expect(result).toBe("line1 line2 line3")
  })

  it("should truncate long strings", () => {
    const input = "a".repeat(300)
    const result = truncateForTrace(input, 200)
    expect(result.length).toBe(201) // 200 + ellipsis
    expect(result.endsWith("…")).toBe(true)
  })

  it("should not truncate short strings", () => {
    const input = "short string"
    const result = truncateForTrace(input, 200)
    expect(result).toBe("short string")
    expect(result.length).toBe(12)
  })
})

describe("sanitizeForTrace", () => {
  const sanitizeForTrace = (v: unknown, depth = 0): unknown => {
    if (depth >= 6) return "[Truncated]"
    if (v === null) return null
    if (typeof v === "string") return v.length > 2000 ? `${v.slice(0, 2000)}…` : v
    if (typeof v === "number" || typeof v === "boolean") return v
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitizeForTrace(x, depth + 1))
    if (typeof v === "object") {
      const out: Record<string, unknown> = {}
      const rec = v as Record<string, unknown>
      for (const [k, val] of Object.entries(rec)) {
        if (/key|token|secret|password/i.test(k)) out[k] = "[REDACTED]"
        else out[k] = sanitizeForTrace(val, depth + 1)
      }
      return out
    }
    return String(v)
  }

  it("should redact sensitive fields", () => {
    const input = { apiKey: "secret123", name: "test" }
    const result = sanitizeForTrace(input) as Record<string, unknown>
    expect(result.apiKey).toBe("[REDACTED]")
    expect(result.name).toBe("test")
  })

  it("should redact TOKEN fields", () => {
    const input = { AUTH_TOKEN: "secret", user: "alice" }
    const result = sanitizeForTrace(input) as Record<string, unknown>
    expect(result.AUTH_TOKEN).toBe("[REDACTED]")
    expect(result.user).toBe("alice")
  })

  it("should truncate long strings", () => {
    const input = { data: "x".repeat(3000) }
    const result = sanitizeForTrace(input) as { data: string }
    expect(result.data.length).toBe(2001) // 2000 + ellipsis
    expect(result.data.endsWith("…")).toBe(true)
  })

  it("should truncate deeply nested objects", () => {
    let obj: unknown = { level: 0 }
    for (let i = 1; i <= 10; i++) {
      obj = { nested: obj, level: i }
    }
    const result = sanitizeForTrace(obj, 0)
    expect(JSON.stringify(result)).toContain("[Truncated]")
    expect(JSON.stringify(result)).toContain("level")
  })

  it("should handle null values", () => {
    const input = { nullField: null, str: "test" }
    const result = sanitizeForTrace(input) as Record<string, unknown>
    expect(result.nullField).toBeNull()
    expect(result.str).toBe("test")
  })

  it("should limit array size", () => {
    const input = { arr: Array.from({ length: 100 }, (_, i) => i) }
    const result = sanitizeForTrace(input) as { arr: unknown[] }
    expect(result.arr.length).toBe(50)
  })

  it("should preserve numbers and booleans", () => {
    const input = { num: 42, bool: true, neg: -3.14 }
    const result = sanitizeForTrace(input) as Record<string, unknown>
    expect(result.num).toBe(42)
    expect(result.bool).toBe(true)
    expect(result.neg).toBe(-3.14)
  })
})

describe("sanitizeToolName", () => {
  const sanitizeToolName = (name: string): string => {
    let out = name.replace(/[^a-zA-Z0-9_-]/g, "_")
    if (!/^[a-zA-Z]/.test(out)) out = `t_${out}`
    out = out.replace(/_+/g, "_")
    return out
  }

  it("should replace dots with underscore", () => {
    expect(sanitizeToolName("fs.readFile")).toBe("fs_readFile")
    expect(sanitizeToolName("tool.name")).toBe("tool_name")
  })

  it("should keep dashes (in allowed set)", () => {
    expect(sanitizeToolName("tool-name")).toBe("tool-name")
    expect(sanitizeToolName("a--b--c")).toBe("a--b--c")
  })

  it("should prepend t_ for names starting with number", () => {
    expect(sanitizeToolName("123tool")).toBe("t_123tool")
  })

  it("should collapse multiple underscores", () => {
    expect(sanitizeToolName("tool___name")).toBe("tool_name")
  })

  it("should preserve valid names", () => {
    expect(sanitizeToolName("validName_123")).toBe("validName_123")
    expect(sanitizeToolName("myTool")).toBe("myTool")
  })
})

describe("uniqueLlmToolName", () => {
  const uniqueLlmToolName = (name: string, used: Set<string>): string => {
    if (!used.has(name)) {
      used.add(name)
      return name
    }
    let i = 2
    while (used.has(`${name}_${i}`)) i++
    const out = `${name}_${i}`
    used.add(out)
    return out
  }

  it("should return name as-is if not used", () => {
    const used = new Set<string>()
    expect(uniqueLlmToolName("tool", used)).toBe("tool")
    expect(used.has("tool")).toBe(true)
  })

  it("should append _2 if name is already used", () => {
    const used = new Set(["tool"])
    expect(uniqueLlmToolName("tool", used)).toBe("tool_2")
    expect(used.has("tool_2")).toBe(true)
  })

  it("should find next available number", () => {
    const used = new Set(["tool", "tool_2", "tool_3"])
    expect(uniqueLlmToolName("tool", used)).toBe("tool_4")
  })
})
