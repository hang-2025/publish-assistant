// Remove only compiler output paired with source files inside this freshly downloaded fork.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.dirname(fileURLToPath(import.meta.url))
let count = 0
for (const sub of ['packages/extension/src', 'packages/core/src']) {
  const base = path.resolve(root, sub)
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, {withFileTypes:true})) {
      const file = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(file)
      else if (/\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts')) {
        const stem = file.replace(/\.(ts|tsx)$/, '')
        for (const suffix of ['.js','.js.map','.d.ts','.d.ts.map']) {
          const target = path.resolve(stem + suffix)
          if (!target.startsWith(base + path.sep)) throw new Error('Out of build tree')
          if (fs.existsSync(target)) { fs.unlinkSync(target); count++ }
        }
      }
    }
  }
  walk(base)
}
console.log(`Removed ${count} generated compiler files; original TypeScript retained.`)
