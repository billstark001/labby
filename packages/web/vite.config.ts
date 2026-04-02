import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { resolve } from 'path';

const VITE_DEPLOYMENT_MODE = process.env.VITE_DEPLOYMENT_MODE || 'frontend-only';
if (!['frontend-only', 'server'].includes(VITE_DEPLOYMENT_MODE)) {
  throw new Error(`Invalid VITE_DEPLOYMENT_MODE: ${VITE_DEPLOYMENT_MODE}`);
}

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
    port: 4400,
    proxy: VITE_DEPLOYMENT_MODE === 'server' ? {
      '/api': 'http://localhost:4410',
    } : undefined,
  },
  preview: {
    port: 4401,
  },
});
