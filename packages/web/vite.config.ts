import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import { resolve } from 'path';

const VITE_DEPLOYMENT_MODE = process.env.VITE_DEPLOYMENT_MODE || 'frontend-only';
const REPO_NAME = process.env.GITHUB_REPOSITORY?.split('/')[1];
const CI_PAGES_BASE = REPO_NAME ? `/${REPO_NAME}/` : undefined;
const VITE_BASE = process.env.VITE_BASE || (process.env.GITHUB_ACTIONS === 'true' ? CI_PAGES_BASE : undefined) || './';

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
  base: VITE_BASE,
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
