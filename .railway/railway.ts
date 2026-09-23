import { defineRailway, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const labbyApi = service("labby-api", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    start: "pnpm --filter @labby/server start",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    networking: { serviceDomains: { "labby-api-production.up.railway.app": { port: 8080 } } },
    replicas: { "us-east4-eqdc4a": 1 },
    deploy: { restartPolicyMaxRetries: 3, sleepApplication: true },
    env: { DATABASE_URL: preserve(), DB_DRIVER: preserve(), PASETO_SECRET: preserve(), PUBLIC_BASE_URL: preserve(), ROOT_EMAIL: preserve(), ROOT_PASSWORD: preserve(), ROOT_USERNAME: preserve(), SCHEDULER_DISPATCH_API_KEY: preserve(), SCHEDULER_MODE: preserve(), WEB_DIST_DIR: preserve() },
  });
  const labbyAuthCleanup = service("labby-auth-cleanup", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    start: "node packages/server/dist/cron/railway-dispatch.js",
    replicas: { "us-east4-eqdc4a": 1 },
    deploy: { cronSchedule: "17 3 * * *", restartPolicyType: "NEVER" },
    env: { LABBY_CRON_JOB: preserve(), LABBY_SERVER_URL: preserve(), SCHEDULER_DISPATCH_API_KEY: preserve() },
  });

  return project("labby", {
    resources: [labbyApi, labbyAuthCleanup],
  });
});
