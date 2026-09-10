import { defineConfig } from 'tsdown'

/**
 * Two artifacts:
 * - `lib/index.js` — the cordis host plugin (the only file allowed to touch
 *   `@deepseek-ai/*`, and only for the configuration schema).
 * - `lib/smoke.js` — a standalone toast smoke test that runs without dsh.
 */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    smoke: 'lib/types/smoke.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
