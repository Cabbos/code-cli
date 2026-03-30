const fs = require('fs')
const path = require('path')

const d = path.join(__dirname, '..', 'evals', 'replay-workspace')

const files = [
  'note_copy.md',
  'extracted_fn.ts',
  'extracted_fn.d.ts',
  'extracted_fn.d.ts.map',
  'extracted_fn.js',
  'extracted_fn.js.map'
]

for (const f of files) {
  try {
    fs.unlinkSync(path.join(d, f))
  } catch (_) {}
}

fs.writeFileSync(path.join(d, 'hello.txt'), 'const greeting = "hello"\nconst count = 42\n', 'utf8')
