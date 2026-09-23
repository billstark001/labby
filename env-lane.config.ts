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
    includeRoot: true,
  },
  dotenv: {
    order: ['.env', '.env.{build}'],
    localBuildName: 'local',
    localOverrideFile: '.env.local',
    includeProcessEnv: true,
  },
});
