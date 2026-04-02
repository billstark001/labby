export type DatabaseMode = 'idb' | 'api' | 'dummy';
export type DeploymentMode = 'frontend-only' | 'server';

export const databaseMode = (import.meta.env.VITE_DB_CONFIG || 'idb') as DatabaseMode;

const configuredDeploymentMode = import.meta.env.VITE_DEPLOYMENT_MODE;

export const deploymentMode: DeploymentMode = configuredDeploymentMode === 'server'
  ? 'server'
  : configuredDeploymentMode === 'frontend-only'
    ? 'frontend-only'
    : databaseMode === 'api'
      ? 'server'
      : 'frontend-only';

export const isServerDeployment = deploymentMode === 'server';
export const isFrontendOnlyDeployment = deploymentMode === 'frontend-only';