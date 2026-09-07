import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
export default defineConfig({
  resolve: { alias: { '@wechatsync/core': resolve(__dirname, '../core/src') } },
  test: { environment: 'jsdom', include: ['tests/local-import.test.ts'] },
})
