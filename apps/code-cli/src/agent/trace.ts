import { createWriteStream, promises as fs } from "node:fs"
import path from "node:path"

export type TraceWriter = {
  write: (event: unknown) => void
  close: () => Promise<void>
}

export async function createJsonlTraceWriter(filePath: string, opts?: { append?: boolean }): Promise<TraceWriter> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const stream = createWriteStream(filePath, { flags: opts?.append === false ? "w" : "a" })
  return {
    write: (event: unknown) => {
      stream.write(`${JSON.stringify(event)}\n`)
    },
    close: async () => {
      await new Promise<void>((resolve) => stream.end(resolve))
    }
  }
}
