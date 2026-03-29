import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { resolve } from 'path';

export default defineConfig({
  plugins: [preact(), vanillaExtractPlugin()],
  resolve: {
    alias: {
      '@labby/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  base: './',
});
