import { ToolRegistry } from "./registry"
import {
  applyPatchTool,
  batchReadTool,
  batchWriteTool,
  copyTool,
  deleteTool,
  listFilesTool,
  readFileTool,
  renameTool,
  symlinkTool,
  writeFileTool
} from "./builtins/fs"
import { gitDiffTool, gitStatusTool } from "./builtins/git"
import { searchRgTool } from "./builtins/search"
import {
  addTypeAnnotationTool,
  extractFunctionTool,
  listSymbolsTool,
  renameSymbolTool,
  wrapWithTryCatchTool
} from "./builtins/ast"
import {
  conflictsTool,
  graphTool,
  listDepsTool,
  outdatedTool,
  whyTool
} from "./builtins/deps"
import {
  coverageTool,
  parseTestTool,
  rerunTestTool,
  runTestTool
} from "./builtins/test"
import { ToolPolicy } from "./policy"
import { SkillDefinition } from "../skills/types"
import { createSkillTool } from "../skills/SkillTool"
import { bundledSkills } from "../skills/bundled"

export function createDefaultToolRegistry(opts?: { policy?: ToolPolicy; skills?: SkillDefinition[] }): ToolRegistry {
  const reg = new ToolRegistry(opts?.policy ? { policy: opts.policy } : undefined)
  reg.register(readFileTool)
  reg.register(writeFileTool)
  reg.register(applyPatchTool)
  reg.register(listFilesTool)
  reg.register(batchReadTool)
  reg.register(batchWriteTool)
  reg.register(renameTool)
  reg.register(deleteTool)
  reg.register(copyTool)
  reg.register(symlinkTool)
  reg.register(searchRgTool)
  reg.register(gitDiffTool)
  reg.register(gitStatusTool)
  reg.register(listSymbolsTool)
  reg.register(renameSymbolTool)
  reg.register(wrapWithTryCatchTool)
  reg.register(addTypeAnnotationTool)
  reg.register(extractFunctionTool)
  reg.register(listDepsTool)
  reg.register(outdatedTool)
  reg.register(graphTool)
  reg.register(conflictsTool)
  reg.register(whyTool)
  reg.register(runTestTool)
  reg.register(parseTestTool)
  reg.register(rerunTestTool)
  reg.register(coverageTool)

  // Register SkillTool with bundled skills
  const skillsToUse = opts?.skills ?? bundledSkills
  const skillTool = createSkillTool(skillsToUse)
  reg.register(skillTool)

  return reg
}
