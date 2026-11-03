import { defineConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-logalyze'

/**
 * Client half build: one closure-factory bundle registered through
 * `window.__ModuleLoader__`. React and its JSX runtime come from the web
 * shell's platform module table; everything else is inlined. DSH consumes the
 * built `lib/client.js`, never the TypeScript source.
 */
export default defineConfig({
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  external: [
    'react',
    'react/jsx-runtime',
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
