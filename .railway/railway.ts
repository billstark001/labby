import { defineRailway, preserve, project, service } from "railway/iac";
import { RAILWAY_CRON_ENV_KEYS, SERVER_RUNTIME_ENV_KEYS } from "../scripts/deploy-env.ts";

const preserved = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, preserve()]));

export default defineRailway(() => {
  const labbyApi = service("labby-api", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    start: "pnpm --filter @labby/server start",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    networking: { serviceDomains: { "labby-api-production.up.railway.app": { port: 8080 } } },
    replicas: { "us-east4-eqdc4a": 1 },
    deploy: { restartPolicyMaxRetries: 3, sleepApplication: true },
    env: preserved(SERVER_RUNTIME_ENV_KEYS),
  });
  const labbyAuthCleanup = service("labby-auth-cleanup", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    start: "node packages/server/dist/cron/railway-dispatch.js",
    replicas: { "us-east4-eqdc4a": 1 },
    deploy: { cronSchedule: "17 3 * * *", restartPolicyType: "NEVER" },
    env: preserved(RAILWAY_CRON_ENV_KEYS),
  });

  return project("labby", {
    resources: [labbyApi, labbyAuthCleanup],
  });
});
