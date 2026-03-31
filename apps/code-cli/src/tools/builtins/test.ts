import { execSync } from "node:child_process"
import { ToolDefinition } from "../types"

type TestResult = {
  passed: number
  failed: number
  skipped: number
  total: number
  duration: number
  framework: string
  output?: string
}

type TestFailure = {
  name: string
  message: string
  location?: string
}

type TestCase = {
  name: string
  className?: string
  time: number
  status: "passed" | "failed" | "skipped"
  message?: string
}

export const runTestTool: ToolDefinition<
  { command?: string; reporter?: string; pattern?: string; timeout?: number },
  { result: TestResult; failures: TestFailure[] }
> = {
  name: "test.run",
  description: "Run tests in the workspace. Detects the test framework (npm test/pytest/go test) or uses provided command. Returns summary with pass/fail counts and failed test details.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string" },
      reporter: { type: "string" },
      pattern: { type: "string" },
      timeout: { type: "number", default: 120 }
    }
  },
  async invoke(input, ctx) {
    const cwd = ctx.workspace.root
    const timeout = (input.timeout ?? 120) * 1000

    try {
      const pkgContent = await ctx.workspace.readText("package.json")
      const pkg = JSON.parse(pkgContent) as any
      const testScript = input.command ?? pkg.scripts?.test ?? "npm test"

      let stdout = ""
      let stderr = ""

      try {
        stdout = execSync(testScript, {
          cwd,
          encoding: "utf-8",
          timeout,
          maxBuffer: 10 * 1024 * 1024
        })
      } catch (err: any) {
        stderr = err.stderr?.toString() ?? ""
        stdout = err.stdout?.toString() ?? ""
      }

      const combined = stdout + "\n" + stderr
      const parsed = parseTestOutput(combined, testScript)

      return {
        result: {
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          total: parsed.total,
          duration: parsed.duration,
          framework: parsed.framework,
          output: combined.slice(0, 20000)
        },
        failures: parsed.failures
      }
    } catch (err: any) {
      return {
        result: {
          passed: 0,
          failed: 0,
          skipped: 0,
          total: 0,
          duration: 0,
          framework: "unknown",
          output: err.message
        },
        failures: []
      }
    }
  }
}

export const parseTestTool: ToolDefinition<
  { reportPath?: string; format?: "tap" | "junit" | "json" | "dot" },
  { tests: TestCase[]; summary: { passed: number; failed: number; skipped: number; total: number } }
> = {
  name: "test.parse",
  description: "Parse test result files (JUnit XML, TAP, JSON) from common locations like test-results/, coverage/, or custom paths.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reportPath: { type: "string" },
      format: { type: "string", enum: ["tap", "junit", "json", "dot"], default: "junit" }
    }
  },
  async invoke(input, ctx) {
    const format = input.format ?? "junit"
    const searchPaths = input.reportPath
      ? [input.reportPath]
      : [
          "test-results/junit.xml",
          "test-results/TAP.txt",
          "test-results/test-results.xml",
          "coverage/coverage-summary.json",
          "coverage/report.json",
          "jest-results.json",
          "vitest-results.json",
          "test-report.xml"
        ]

    let content = ""
    let foundPath = ""

    for (const p of searchPaths) {
      try {
        content = await ctx.workspace.readText(p)
        foundPath = p
        break
      } catch {
        continue
      }
    }

    if (!content) {
      return {
        tests: [],
        summary: { passed: 0, failed: 0, skipped: 0, total: 0 }
      }
    }

    const tests = parseTestContent(content, format)

    return {
      tests,
      summary: {
        passed: tests.filter(t => t.status === "passed").length,
        failed: tests.filter(t => t.status === "failed").length,
        skipped: tests.filter(t => t.status === "skipped").length,
        total: tests.length
      }
    }
  }
}

export const rerunTestTool: ToolDefinition<
  { failedOnly?: boolean; command?: string; timeout?: number },
  { result: TestResult; rerunCommand: string }
> = {
  name: "test.rerun",
  description: "Re-run tests, optionally only failed tests. Uses the last test run command or a provided command. Returns updated results.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      failedOnly: { type: "boolean", default: true },
      command: { type: "string" },
      timeout: { type: "number", default: 120 }
    }
  },
  async invoke(input, ctx) {
    const cwd = ctx.workspace.root
    const timeout = (input.timeout ?? 120) * 1000

    try {
      const pkgContent = await ctx.workspace.readText("package.json")
      const pkg = JSON.parse(pkgContent) as any
      const testCmd = input.command ?? pkg.scripts?.test ?? "npm test"

      const rerunCmd = input.failedOnly
        ? `${testCmd} -- --testPathIgnorePatterns='' --testNamePattern='^(?!.*\\b(passed|skip)\\b).*$'`
        : testCmd

      let stdout = ""
      let stderr = ""

      try {
        stdout = execSync(rerunCmd, {
          cwd,
          encoding: "utf-8",
          timeout,
          maxBuffer: 10 * 1024 * 1024
        })
      } catch (err: any) {
        stderr = err.stderr?.toString() ?? ""
        stdout = err.stdout?.toString() ?? ""
      }

      const combined = stdout + "\n" + stderr
      const parsed = parseTestOutput(combined, rerunCmd)

      return {
        result: {
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          total: parsed.total,
          duration: parsed.duration,
          framework: parsed.framework,
          output: combined.slice(0, 20000)
        },
        rerunCommand: rerunCmd
      }
    } catch (err: any) {
      return {
        result: {
          passed: 0,
          failed: 0,
          skipped: 0,
          total: 0,
          duration: 0,
          framework: "unknown",
          output: err.message
        },
        rerunCommand: input.command ?? "npm test"
      }
    }
  }
}

export const coverageTool: ToolDefinition<
  { reportPath?: string; format?: "json" | "lcov" | "html" | "text" },
  { summary: CoverageSummary; files: FileCoverage[] }
> = {
  name: "test.coverage",
  description: "Parse test coverage reports. Supports Istanbul JSON, lcov, and text formats. Returns per-file and overall coverage summaries.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reportPath: { type: "string" },
      format: { type: "string", enum: ["json", "lcov", "html", "text"], default: "json" }
    }
  },
  async invoke(input, ctx) {
    const format = input.format ?? "json"
    const searchPaths = input.reportPath
      ? [input.reportPath]
      : [
          "coverage/coverage-summary.json",
          "coverage/report.json",
          "coverage-summary.json",
          "coverage/lcov.info",
          "lcov.info",
          "coverage/coverage-final.json"
        ]

    let content = ""
    let foundPath = ""

    for (const p of searchPaths) {
      try {
        content = await ctx.workspace.readText(p)
        foundPath = p
        break
      } catch {
        continue
      }
    }

    if (!content) {
      return { summary: { lines: 0, statements: 0, functions: 0, branches: 0 }, files: [] }
    }

    return parseCoverageContent(content, format)
  }
}

type CoverageSummary = {
  lines: number
  statements: number
  functions: number
  branches: number
}

type FileCoverage = {
  path: string
  lines: number
  statements: number
  functions: number
  branches: number
}

function parseTestOutput(output: string, command: string): TestResult & { failures: TestFailure[] } {
  const failures: TestFailure[] = []
  let passed = 0
  let failed = 0
  let skipped = 0
  let duration = 0
  let framework = "unknown"

  const lines = output.split("\n")

  if (command.includes("pytest") || command.includes("python")) {
    framework = "pytest"
    for (const line of lines) {
      const p = /(\d+) passed/.exec(line)
      if (p) passed = parseInt(p[1]!)
      const f = /(\d+) failed/.exec(line)
      if (f) failed = parseInt(f[1]!)
      const s = /(\d+) skipped/.exec(line)
      if (s) skipped = parseInt(s[1]!)
      const d = /(\d+\.?\d*)s/.exec(line)
      if (d) duration = parseFloat(d[1]!)
    }
    const failBlocks = output.split("FAILED")
    for (let i = 1; i < failBlocks.length; i++) {
      const block = failBlocks[i]!
      const firstLine = block.split("\n")[0]?.trim() ?? block.slice(0, 100)
      failures.push({ name: firstLine, message: block.slice(0, 500) })
    }
  } else if (command.includes("go test") || output.includes("ok")) {
    framework = "go"
    const okMatch = /ok\s+\S+\s+(\d+\.?\d*)s/.exec(output)
    if (okMatch) { passed = 1; duration = parseFloat(okMatch[1]!) }
    const failMatch = /FAIL\s+\S+\s+(\d+\.?\d*)s/.exec(output)
    if (failMatch) { failed = 1; duration = parseFloat(failMatch[1]!) }
  } else {
    framework = "jest/vitest/npm"
    for (const line of lines) {
      const m = /Tests:\s+(\d+)\s+passed.*?(\d+)\s+failed.*?(\d+)\s+skipped/.exec(line)
      if (m) {
        passed = parseInt(m[1]!)
        failed = parseInt(m[2]!)
        skipped = parseInt(m[3]!)
      }
      const d = /Time:\s+(\d+\.?\d*)s/.exec(line)
      if (d) duration = parseFloat(d[1]!)
    }
    if (passed === 0 && failed === 0) {
      const p = /(\d+)\s+pass/.exec(output)
      if (p) passed = parseInt(p[1]!)
      const f = /(\d+)\s+fail/.exec(output)
      if (f) failed = parseInt(f[1]!)
    }
    const failBlocks = output.split("FAIL")
    for (let i = 1; i < failBlocks.length; i++) {
      const block = failBlocks[i]!
      const firstLine = block.split("\n")[0]?.trim() ?? block.slice(0, 100)
      failures.push({ name: firstLine, message: block.slice(0, 500) })
    }
  }

  return { passed, failed, skipped, total: passed + failed + skipped, duration, framework, failures }
}

function parseTestContent(content: string, format: string): TestCase[] {
  if (format === "junit" || content.includes("testsuite")) {
    return parseJUnit(content)
  }
  if (format === "json" || content.trim().startsWith("[")) {
    return parseJsonTest(content)
  }
  if (format === "tap" || content.includes("ok") || content.includes("1..")) {
    return parseTap(content)
  }
  return []
}

function parseJUnit(xml: string): TestCase[] {
  const tests: TestCase[] = []
  const testCaseRegex = /<testcase[^>]+name="([^"]+)"[^>]*>/g
  let match
  while ((match = testCaseRegex.exec(xml)) !== null) {
    const name = match[1] ?? ""
    const after = xml.slice(match.index)
    const timeMatch = /time="([^"]+)"/.exec(after)
    const time = timeMatch ? parseFloat(timeMatch[1]!) : 0
    const isFailed = after.slice(0, 500).includes("<failure") || after.slice(0, 500).includes("<error")
    const isSkipped = after.slice(0, 500).includes("<skipped")
    tests.push({
      name,
      time,
      status: isFailed ? "failed" : isSkipped ? "skipped" : "passed"
    })
  }
  return tests
}

function parseJsonTest(json: string): TestCase[] {
  try {
    const data = JSON.parse(json)
    if (Array.isArray(data)) {
      return data.map((t: any) => ({
        name: t.fullName ?? t.name ?? "",
        time: t.duration ?? t.time ?? 0,
        status: t.status === "passed" ? "passed" : t.status === "skipped" ? "skipped" : "failed",
        message: t.failureMessages?.[0]
      }))
    }
    if (data.testResults) {
      return data.testResults.flatMap((r: any) =>
        (r.assertionResults ?? []).map((a: any) => ({
          name: a.fullName ?? a.title ?? "",
          time: 0,
          status: a.status === "passed" ? "passed" : a.status === "skipped" ? "skipped" : "failed",
          message: a.failureMessages?.[0]
        }))
      )
    }
  } catch {}
  return []
}

function parseTap(tap: string): TestCase[] {
  const tests: TestCase[] = []
  const lines = tap.split("\n")
  for (const line of lines) {
    const okMatch = /^ok\s+(\d+)\s+(.+)/.exec(line)
    if (okMatch) {
      tests.push({ name: okMatch[2] ?? "test", time: 0, status: "passed" })
    }
    const failMatch = /^not ok\s+(\d+)\s+(.+)/.exec(line)
    if (failMatch) {
      tests.push({ name: failMatch[2] ?? "test", time: 0, status: "failed" })
    }
  }
  return tests
}

function parseCoverageContent(content: string, format: string): { summary: CoverageSummary; files: FileCoverage[] } {
  if (format === "json" || format === "html") {
    return parseIstanbulCoverage(content)
  }
  if (format === "lcov") {
    return parseLcov(content)
  }
  return { summary: { lines: 0, statements: 0, functions: 0, branches: 0 }, files: [] }
}

function parseIstanbulCoverage(json: string): { summary: CoverageSummary; files: FileCoverage[] } {
  try {
    const data = JSON.parse(json)
    const files: FileCoverage[] = []

    const addFile = (path: string, cov: any) => {
      files.push({
        path,
        lines: Math.round((cov.lines?.pct ?? cov.lines?.covered ?? 0) as number),
        statements: Math.round((cov.statements?.pct ?? cov.statements?.covered ?? 0) as number),
        functions: Math.round((cov.functions?.pct ?? cov.functions?.covered ?? 0) as number),
        branches: Math.round((cov.branches?.pct ?? cov.branches?.covered ?? 0) as number)
      })
    }

    if (data.total) {
      for (const [key, value] of Object.entries(data)) {
        if (key === "total") continue
        if (typeof value === "object" && value !== null) {
          addFile(key, value)
        }
      }
    } else {
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "object" && value !== null) {
          addFile(key, value)
        }
      }
    }

    const summary: CoverageSummary = {
      lines: 0,
      statements: 0,
      functions: 0,
      branches: 0
    }

    if (data.total) {
      const t = data.total as any
      summary.lines = Math.round(t.lines?.pct ?? 0)
      summary.statements = Math.round(t.statements?.pct ?? 0)
      summary.functions = Math.round(t.functions?.pct ?? 0)
      summary.branches = Math.round(t.branches?.pct ?? 0)
    } else if (files.length > 0) {
      const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0
      summary.lines = avg(files.map(f => f.lines))
      summary.statements = avg(files.map(f => f.statements))
      summary.functions = avg(files.map(f => f.functions))
      summary.branches = avg(files.map(f => f.branches))
    }

    return { summary, files: files.slice(0, 50) }
  } catch {
    return { summary: { lines: 0, statements: 0, functions: 0, branches: 0 }, files: [] }
  }
}

function parseLcov(lcov: string): { summary: CoverageSummary; files: FileCoverage[] } {
  const files: FileCoverage[] = []
  let currentFile = ""
  let currentLines = 0
  let currentBranches = 0

  const lines = lcov.split("\n")
  for (const line of lines) {
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3)
    } else if (line === "end_of_record") {
      if (currentFile) {
        files.push({ path: currentFile, lines: currentLines, statements: currentLines, functions: currentLines, branches: currentBranches })
      }
      currentFile = ""
      currentLines = 0
      currentBranches = 0
    } else if (line.startsWith("LH:")) {
      currentLines = Math.round((parseFloat(line.slice(3)) / 100) * 100)
    } else if (line.startsWith("BRH:")) {
      currentBranches = Math.round((parseFloat(line.slice(4)) / 100) * 100)
    }
  }

  const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0
  return {
    summary: {
      lines: avg(files.map(f => f.lines)),
      statements: avg(files.map(f => f.statements)),
      functions: avg(files.map(f => f.functions)),
      branches: avg(files.map(f => f.branches))
    },
    files: files.slice(0, 50)
  }
}
