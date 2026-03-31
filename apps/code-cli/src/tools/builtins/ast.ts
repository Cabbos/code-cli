import ts from "typescript"
import path from "node:path"
import { ToolDefinition } from "../types"

type Location = { line: number; col: number }
type SymbolEntry = { name: string; kind: string; location: Location; flags: string }

export const listSymbolsTool: ToolDefinition<
  { path: string },
  { symbols: SymbolEntry[]; parseError?: string }
> = {
  name: "ast.listSymbols",
  description: "List all top-level identifiers (functions, classes, variables, interfaces) in a TypeScript/JavaScript file with their kind and locations.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string" } },
    required: ["path"]
  },
  async invoke(input, ctx) {
    if (!input?.path) throw new Error("Missing input.path")
    const content = await ctx.workspace.readText(input.path)
    return parseSymbols(content)
  }
}

type RenameInput = {
  path: string
  oldName: string
  newName: string
  scope?: string
}

export const renameSymbolTool: ToolDefinition<
  RenameInput,
  { path: string; newContent: string; changedRefs: string[] } | { error: string }
> = {
  name: "ast.renameSymbol",
  description: "Simple text-based rename in a file. Does word-boundary text replacement (not scope-aware AST rename). Use fs.writeFile to save changes. For multi-file rename, use this tool for each file separately.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      oldName: { type: "string" },
      newName: { type: "string" },
      scope: { type: "string" }
    },
    required: ["path", "oldName", "newName"]
  },
  async invoke(input, ctx) {
    if (!input?.path) throw new Error("Missing input.path")
    if (!input?.oldName) throw new Error("Missing input.oldName")
    if (!input?.newName) throw new Error("Missing input.newName")

    const content = await ctx.workspace.readText(input.path)

    if (!isValidIdentifier(input.newName)) {
      return { error: `Invalid identifier: ${input.newName}` }
    }

    const updated = renameInContent(content, input.oldName, input.newName)
    return { path: input.path, newContent: updated, changedRefs: [] }
  }
}

type WrapInput = {
  path: string
  functionName?: string
  insertLine?: number
  template?: string
}

export const wrapWithTryCatchTool: ToolDefinition<
  WrapInput,
  { path: string; newContent: string } | { error: string }
> = {
  name: "ast.wrapWithTryCatch",
  description: "Wrap a function body with a try-catch block. Provide either functionName (to find by name) or insertLine (0-based) to specify where to insert.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      functionName: { type: "string" },
      insertLine: { type: "number" },
      template: { type: "string" }
    },
    required: ["path"]
  },
  async invoke(input, ctx) {
    if (!input?.path) throw new Error("Missing input.path")
    const content = await ctx.workspace.readText(input.path)

    const template = input.template ?? "  catch (err) {\n    console.error(err);\n  }"

    let result: string
    if (input.functionName) {
      result = wrapFunctionByName(content, input.functionName, template)
    } else if (typeof input.insertLine === "number") {
      result = wrapAtLine(content, input.insertLine, template)
    } else {
      return { error: "Must provide either functionName or insertLine" }
    }

    if (result === content) {
      return { error: `Function '${input.functionName}' not found` }
    }

    return { path: input.path, newContent: result }
  }
}

type TypeAnnotationInput = {
  path: string
  variableName: string
  typeAnnotation: string
}

export const addTypeAnnotationTool: ToolDefinition<
  TypeAnnotationInput,
  { path: string; newContent: string } | { error: string }
> = {
  name: "ast.addTypeAnnotation",
  description: "Add or replace a type annotation on a variable declaration in a TypeScript file.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      variableName: { type: "string" },
      typeAnnotation: { type: "string" }
    },
    required: ["path", "variableName", "typeAnnotation"]
  },
  async invoke(input, ctx) {
    if (!input?.path) throw new Error("Missing input.path")
    if (!input?.variableName) throw new Error("Missing input.variableName")
    if (!input?.typeAnnotation) throw new Error("Missing input.typeAnnotation")

    const content = await ctx.workspace.readText(input.path)
    const updated = addAnnotation(content, input.variableName, input.typeAnnotation)

    if (updated === content) {
      return { error: `Variable '${input.variableName}' not found or already has a type annotation` }
    }

    return { path: input.path, newContent: updated }
  }
}

type ExtractInput = {
  path: string
  functionName: string
  newFilePath: string
}

export const extractFunctionTool: ToolDefinition<
  ExtractInput,
  { originalFile: string; newContent: string; newFile: string; newFileContent: string } | { error: string }
> = {
  name: "ast.extractFunction",
  description: "Extract a function from a TypeScript/JavaScript file into a new file, replacing the original with an import statement.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      functionName: { type: "string" },
      newFilePath: { type: "string" }
    },
    required: ["path", "functionName", "newFilePath"]
  },
  async invoke(input, ctx) {
    if (!input?.path) throw new Error("Missing input.path")
    if (!input?.functionName) throw new Error("Missing input.functionName")
    if (!input?.newFilePath) throw new Error("Missing input.newFilePath")

    const content = await ctx.workspace.readText(input.path)
    const extracted = extractFn(content, input.functionName)

    if (!extracted) {
      return { error: `Function '${input.functionName}' not found` }
    }

    const { functionText, newOriginalContent } = extracted
    const originalRel = input.path
    const newRel = input.newFilePath

    await ctx.workspace.writeText(newRel, functionText)

    const ext = path.extname(newRel)
    const moduleName = path.basename(newRel, ext)
    const importStatement = `import { ${input.functionName} } from './${moduleName}';\n`

    const finalOriginal = importStatement + newOriginalContent

    return {
      originalFile: originalRel,
      newContent: finalOriginal,
      newFile: newRel,
      newFileContent: functionText
    }
  }
}

function parseSymbols(content: string): { symbols: SymbolEntry[]; parseError?: string } {
  try {
    const sourceFile = ts.createSourceFile("tmp.ts", content, ts.ScriptTarget.Latest, true)
    const symbols: SymbolEntry[] = []

    function getLoc(node: ts.Node, nameNode: ts.Node): Location {
      const sf = nameNode.getSourceFile()
      const pos = sf.getLineAndCharacterOfPosition(nameNode.getStart())
      return { line: pos.line + 1, col: pos.character + 1 }
    }

    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: "FunctionDeclaration", location: getLoc(node, node.name), flags: "" })
      } else if (ts.isClassDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: "ClassDeclaration", location: getLoc(node, node.name), flags: "" })
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
            symbols.push({ name: decl.name.text, kind: "VariableDeclaration", location: getLoc(decl, decl.name), flags: "" })
          }
        }
      } else if (ts.isInterfaceDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: "InterfaceDeclaration", location: getLoc(node, node.name), flags: "interface" })
      } else if (ts.isTypeAliasDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: "TypeAliasDeclaration", location: getLoc(node, node.name), flags: "type" })
      } else if (ts.isEnumDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: "EnumDeclaration", location: getLoc(node, node.name), flags: "enum" })
      } else if (ts.isArrowFunction(node)) {
        const sf = node.getSourceFile()
        const pos = sf.getLineAndCharacterOfPosition(node.getStart())
        symbols.push({ name: "(arrow)", kind: "ArrowFunction", location: { line: pos.line + 1, col: pos.character + 1 }, flags: "" })
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return { symbols }
  } catch (err) {
    return { symbols: [], parseError: err instanceof Error ? err.message : String(err) }
  }
}

function renameInContent(content: string, oldName: string, newName: string): string {
  const re = new RegExp(`\\b${escapeRe(oldName)}\\b`, "g")
  return content.replace(re, newName)
}

function wrapFunctionByName(content: string, fnName: string, catchTemplate: string): string {
  const sourceFile = ts.createSourceFile("tmp.ts", content, ts.ScriptTarget.Latest, true)

  let foundText = ""
  let found = false

  function visit(node: ts.Node) {
    if (!found && ts.isFunctionDeclaration(node) && node.name?.text === fnName && node.body) {
      const bodyStart = node.body.getStart()
      const bodyEnd = node.body.getEnd()
      const beforeBody = content.slice(0, bodyStart)
      const bodyText = content.slice(bodyStart, bodyEnd)

      const sf = node.body.getSourceFile()
      const lineInfo = sf.getLineAndCharacterOfPosition(bodyStart)
      const lines = content.split("\n")
      const lineAtBodyStart = lines[lineInfo.line] ?? ""
      const indent = /^(\s*)/.exec(lineAtBodyStart)?.[1] ?? ""

      const catchLines = catchTemplate.split("\n").map((l, i) => i === 0 ? l : `${indent}${l}`).join("\n")
      const wrappedBodyLines = bodyText.trim().split("\n").map(l => `${indent}    ${l}`)
      const wrapped = `${indent}{\n${indent}  try {\n${wrappedBodyLines.join("\n")}\n${indent}  } catch (err) {\n${catchLines}\n${indent}  }\n`

      foundText = beforeBody + wrapped + content.slice(bodyEnd)
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return foundText
}

function wrapAtLine(content: string, insertLine: number, template: string): string {
  const lines = content.split("\n")
  if (insertLine < 0 || insertLine > lines.length) {
    throw new Error(`Line ${insertLine} out of range (0-${lines.length})`)
  }
  const lineAtIdx = lines[insertLine] ?? ""
  const indent = /^(\s*)/.exec(lineAtIdx)?.[1] ?? ""
  const indented = template.split("\n").map((l, i) => i === 0 ? l : `${indent}${l}`).join("\n")
  if (insertLine < lines.length) {
    lines.splice(insertLine + 1, 0, indented)
  } else {
    lines.push(indented)
  }
  return lines.join("\n")
}

function addAnnotation(content: string, varName: string, annotation: string): string {
  const re = new RegExp(`(\\b(const|let|var)\\s+${escapeRe(varName)}\\s*)(:?\\s*=\\s*[^;]+)?(;?)`)
  const match = re.exec(content)
  if (!match) return content

  const before = match[1]
  const after = match[3] ?? ""
  const end = match[4]
  return content.slice(0, match.index) + `${before}: ${annotation}${after}${end}` + content.slice(match.index + match[0].length)
}

function extractFn(content: string, fnName: string): { functionText: string; newOriginalContent: string } | null {
  const sourceFile = ts.createSourceFile("tmp.ts", content, ts.ScriptTarget.Latest, true)
  let foundNode: ts.FunctionDeclaration | null = null

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) {
      foundNode = node
    } else {
      ts.forEachChild(node, visit)
    }
  }
  visit(sourceFile)

  if (!foundNode) return null

  const fn = foundNode as ts.FunctionDeclaration
  const fnText = content.slice(fn.getStart(), fn.getEnd())
  const beforeFn = content.slice(0, fn.getStart())
  const afterFn = content.slice(fn.getEnd())
  const newOriginalContent = beforeFn + afterFn

  return { functionText: fnText, newOriginalContent }
}

function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) && !isTsKeyword(name)
}

function isTsKeyword(name: string): boolean {
  return ["break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
    "do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "if",
    "import", "in", "instanceof", "new", "null", "return", "static", "super", "switch",
    "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "with",
    "abstract", "as", "any", "boolean", "constructor", "declare", "get", "module",
    "namespace", "number", "private", "protected", "public", "set", "string", "symbol",
    "type", "from", "of", "async", "await", "yield", "let"].includes(name)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
