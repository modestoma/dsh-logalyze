import { defineConfig } from 'tsdown'

/**
 * Host half build: emit `lib/index.js` so an installed package runs as plain
 * ESM under the DSH Loader. Runtime dependencies stay external and resolve
 * through the package's own `node_modules`.
 */
export default defineConfig({
  name: 'dsh-logalyze/host',
  entry: { index: 'src/index.ts' },
  tsconfig: 'tsconfig.json',
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  external: [
    'diff',
    'yaml',
    'zod',
  ],
})
