import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { resolve } from 'path';

export default defineConfig({
  plugins: [preact(), vanillaExtractPlugin()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@labby/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  base: './',
  server: {
    port: 4400, // Set your desired port here
  },
  preview: {
    port: 4401, // Set the port for the production preview server
  }
});
