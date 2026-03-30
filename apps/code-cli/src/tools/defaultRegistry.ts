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
import { ToolPolicy } from "./policy"

export function createDefaultToolRegistry(opts?: { policy?: ToolPolicy }): ToolRegistry {
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
  return reg
}
