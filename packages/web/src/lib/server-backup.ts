import { apiClient } from './api.js';

export type BackupTarget = 'email' | 'google-drive' | 'onedrive';
export type BackupFormat = 'sqlite' | 'msgpack';

export interface SystemCapabilities {
  deploymentMode: 'server';
  backup: {
    scheduleEnabled: boolean;
    scheduleConfigured: boolean;
    configuredTarget: BackupTarget | null;
    configuredFormat: BackupFormat;
    targets: Record<BackupTarget, boolean>;
    formats: BackupFormat[];
  };
  permissions: {
    canManageBackups: boolean;
  };
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function fetchSystemCapabilities(): Promise<SystemCapabilities> {
  return apiClient.request<SystemCapabilities>('/system/capabilities', { method: 'GET' });
}

export async function runServerBackup(input: { format?: BackupFormat; target?: BackupTarget; } = {}): Promise<void> {
  await apiClient.request('/system/backup/run', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function downloadServerBackup(format: BackupFormat): Promise<void> {
  const response = await apiClient.requestRaw(`/system/backup/download?format=${encodeURIComponent(format)}`, {
    method: 'GET',
  });
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename="?([^";]+)"?/i);
  triggerDownload(blob, match?.[1] ?? `labby-backup.${format === 'sqlite' ? 'sqlite3' : 'msgpack'}`);
}