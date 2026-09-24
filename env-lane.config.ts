import { defineConfig } from 'env-lane';

export default defineConfig({
  selector: {
    envKey: 'ENV_BUILD',
    defaultBuild: 'local',
    builds: ['local', 'railway.production', 'railway.cron.production', 'cloudrun.production'],
    buildValidation: 'error',
    forbidInDotenv: true,
  },
  workspace: {
    aliases: {
      server: 'packages/server',
    },
    defaultTarget: 'server',
    includeRoot: false,
  },
  dotenv: {
    order: ['.env', '.env.{build}'],
    localBuildName: 'local',
    localOverrideFile: '.env.local',
    includeProcessEnv: true,
  },
  sort: {
    server: {
      baseDir: 'packages/server',
      file: '.env',
      template: '.env.example',
      files: { configured: '.env' },
      create: false,
      unlistedVariablesComment: 'Variables not present in .env.example:',
    },
    'server-local': {
      baseDir: 'packages/server',
      file: '.env.local',
      template: '.env.example',
      files: { configured: '.env.local' },
      create: false,
      unlistedVariablesComment: 'Variables not present in .env.example:',
    },
    'railway-production': {
      baseDir: 'packages/server',
      file: '.env.railway.production',
      template: '.env.railway.production.example',
      files: { configured: '.env.railway.production' },
      create: false,
    },
    'railway-cron-production': {
      baseDir: 'packages/server',
      file: '.env.railway.cron.production',
      template: '.env.railway.cron.production.example',
      files: { configured: '.env.railway.cron.production' },
      create: false,
    },
    'cloudrun-production': {
      baseDir: 'packages/server',
      file: '.env.cloudrun.production',
      template: '.env.cloudrun.production.example',
      files: { configured: '.env.cloudrun.production' },
      create: false,
    },
  },
});
