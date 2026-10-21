import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';

/**
 * The test-framework entries must share the main entry's module instance: it owns the global
 * patches and the session context. Point their `./index.js` import at the package itself.
 */
const selfImport: Plugin = {
  name: 'rewind-self-import',
  setup(build) {
    build.onResolve({ filter: /^\.\/index\.js$/ }, () => ({ path: 'llm-rewind', external: true }));
  },
};

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node18',
  },
  {
    entry: ['src/vitest.ts', 'src/jest.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'node18',
    external: ['vitest', 'llm-rewind'],
    esbuildPlugins: [selfImport],
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    sourcemap: true,
    target: 'node18',
  },
]);
