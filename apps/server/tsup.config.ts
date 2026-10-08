import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  // The shared package ships TypeScript sources, so it has to be bundled in.
  noExternal: ['@dnd-map/shared'],
});
