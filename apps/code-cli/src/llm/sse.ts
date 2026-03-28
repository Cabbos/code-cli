export async function* sseLinesFromResponse(res: Response): AsyncGenerator<string> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    while (true) {
      const idx = buf.indexOf("\n")
      if (idx === -1) break
      const line = buf.slice(0, idx).replace(/\r$/, "")
      buf = buf.slice(idx + 1)
      yield line
    }
  }

  const tail = buf.trimEnd()
  if (tail) yield tail
}

