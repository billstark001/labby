import { databaseMode, isServerDeployment } from './runtime';

export interface EmailTaskCapability {
  canAutoSend: boolean;
  reason: string;
}

export function getEmailTaskCapability(): EmailTaskCapability {
  if (isServerDeployment && databaseMode === 'api') {
    return { canAutoSend: true, reason: 'server' };
  }
  return {
    canAutoSend: false,
    reason: 'frontend-only',
  };
}
