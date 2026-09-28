import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // Both formats: the Nest app is CJS, Vite consumes the ESM build.
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2023',
  treeshake: true,
});
