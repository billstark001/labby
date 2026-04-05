export type DatabaseMode = 'idb' | 'api' | 'dummy';
export type DeploymentMode = 'frontend-only' | 'server';

type RuntimeEnv = {
  VITE_DB_CONFIG?: string;
  VITE_DEPLOYMENT_MODE?: string;
};

const runtimeEnv = ((import.meta as ImportMeta & { env?: RuntimeEnv }).env ?? {}) as RuntimeEnv;

export const databaseMode = (runtimeEnv.VITE_DB_CONFIG || 'idb') as DatabaseMode;

const configuredDeploymentMode = runtimeEnv.VITE_DEPLOYMENT_MODE;

export const deploymentMode: DeploymentMode = configuredDeploymentMode === 'server'
  ? 'server'
  : configuredDeploymentMode === 'frontend-only'
    ? 'frontend-only'
    : databaseMode === 'api'
      ? 'server'
      : 'frontend-only';

export const isServerDeployment = deploymentMode === 'server';
export const isFrontendOnlyDeployment = deploymentMode === 'frontend-only';