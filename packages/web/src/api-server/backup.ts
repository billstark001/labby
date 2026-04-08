import { apiClient } from '../lib/api';

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
    canManageUsers: boolean;
  };
}

const CAPABILITIES_CACHE_TTL_MS = 30_000;
let cachedCapabilities: SystemCapabilities | null = null;
let cachedAt = 0;
let inflightCapabilitiesRequest: Promise<SystemCapabilities> | null = null;

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export async function fetchSystemCapabilities(options: { force?: boolean } = {}): Promise<SystemCapabilities> {
  const force = options.force === true;
  const now = Date.now();
  if (!force && cachedCapabilities && now - cachedAt <= CAPABILITIES_CACHE_TTL_MS) {
    return cachedCapabilities;
  }
  if (!force && inflightCapabilitiesRequest) {
    return inflightCapabilitiesRequest;
  }
  inflightCapabilitiesRequest = apiClient
    .request<SystemCapabilities>('/system/capabilities', { method: 'GET' })
    .then((result) => {
      cachedCapabilities = result;
      cachedAt = Date.now();
      return result;
    })
    .finally(() => {
      inflightCapabilitiesRequest = null;
    });
  return inflightCapabilitiesRequest;
}

export async function runServerBackup(input: { format?: BackupFormat; target?: BackupTarget; } = {}): Promise<void> {
  await apiClient.request('/system/backup/run', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  cachedCapabilities = null;
  cachedAt = 0;
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

function inferBackupFormat(filename: string): BackupFormat {
  const normalized = filename.trim().toLowerCase();
  if (normalized.endsWith('.sqlite') || normalized.endsWith('.sqlite3')) {
    return 'sqlite';
  }
  return 'msgpack';
}

export async function uploadServerBackup(file: File): Promise<void> {
  const format = inferBackupFormat(file.name);
  await apiClient.request(`/system/backup/restore?format=${encodeURIComponent(format)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: await file.arrayBuffer(),
  });
  cachedCapabilities = null;
  cachedAt = 0;
}