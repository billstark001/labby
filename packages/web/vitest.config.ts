import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
export default defineConfig({
  resolve: {alias: {'@':fileURLToPath(new URL('./src',import.meta.url))}},
  plugins: [preact(), vanillaExtractPlugin()],
  test: {environment:'happy-dom',include:['tests/*.render.test.tsx']},
});
