import { decode, encode } from '@msgpack/msgpack';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import type { CronScheduler } from '../cron/scheduler.js';
import { fetchGoogleAccessToken, loadGoogleOAuthClientFromFile } from '../lib/google.js';
import type { Mailer } from '../lib/mailer.js';
import type { DatabaseBackupSnapshot, SqliteStore } from '../store/sqlite.js';

type BackupFormat = 'sqlite' | 'msgpack';
type BackupTarget = 'email' | 'google-drive' | 'onedrive';

export interface BackupCapabilities {
  scheduleEnabled: boolean;
  scheduleConfigured: boolean;
  configuredTarget: BackupTarget | null;
  configuredFormat: BackupFormat;
  targets: Record<BackupTarget, boolean>;
  formats: BackupFormat[];
}

interface BackupArtifact {
  filename: string;
  contentType: string;
  content: Buffer;
}

interface BackupConfig {
  cronExpression?: string;
  timezone: string;
  format: BackupFormat;
  target: BackupTarget | null;
  filenamePrefix: string;
  emailRecipients: string[];
  googleOAuthJsonPath?: string;
  googleOAuthClientId?: string;
  googleOAuthClientSecret?: string;
  googleOAuthRefreshToken?: string;
  googleDriveFolderId?: string;
  onedriveClientId?: string;
  onedriveClientSecret?: string;
  onedriveRefreshToken?: string;
  onedriveTenantId: string;
  onedriveFolder: string;
}

export interface CreateBackupServiceOptions {
  scheduler: CronScheduler;
  store: SqliteStore;
  mailer: Mailer | null;
}

let activeBackupService: BackupService | null = null;

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function timestampSlug(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/[:.]/g, '-');
}

function ensureBackupFormat(value: string | undefined): BackupFormat {
  return value === 'msgpack' ? 'msgpack' : 'sqlite';
}

function ensureBackupTarget(value: string | undefined): BackupTarget | null {
  if (value === 'email' || value === 'google-drive' || value === 'onedrive') {
    return value;
  }
  return null;
}

function buildMsgpackArtifact(filenamePrefix: string, snapshot: DatabaseBackupSnapshot): BackupArtifact {
  const stamp = timestampSlug(snapshot.createdAt);
  return {
    filename: `${filenamePrefix}-${stamp}.msgpack`,
    contentType: 'application/msgpack',
    content: Buffer.from(encode(snapshot)),
  };
}

async function buildSqliteArtifact(filenamePrefix: string, store: SqliteStore): Promise<BackupArtifact> {
  const stamp = timestampSlug(Date.now());
  const tempPath = path.join(os.tmpdir(), `${filenamePrefix}-${stamp}.sqlite3`);
  await store.backupDatabase(tempPath);

  try {
    return {
      filename: path.basename(tempPath),
      contentType: 'application/vnd.sqlite3',
      content: await fs.readFile(tempPath),
    };
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

function toUint8Array(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer);
}

function isFullSnapshotPayload(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && 'version' in value && 'tables' in value);
}

async function uploadToGoogleDrive(config: BackupConfig, artifact: BackupArtifact): Promise<void> {
  const googleClient = config.googleOAuthJsonPath
    ? loadGoogleOAuthClientFromFile(config.googleOAuthJsonPath)
    : null;
  const clientId = config.googleOAuthClientId ?? googleClient?.clientId;
  const clientSecret = config.googleOAuthClientSecret ?? googleClient?.clientSecret;
  const refreshToken = config.googleOAuthRefreshToken;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google Drive backup requires OAuth client credentials and a refresh token');
  }

  const accessToken = await fetchGoogleAccessToken({
    clientId,
    clientSecret,
    refreshToken,
  });

  const metadata: Record<string, unknown> = { name: artifact.filename };
  if (config.googleDriveFolderId) {
    metadata.parents = [config.googleDriveFolderId];
  }

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([toUint8Array(artifact.content)], { type: artifact.contentType }), artifact.filename);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Google Drive upload failed with status ${response.status}`);
  }
}

async function fetchOneDriveAccessToken(config: BackupConfig): Promise<string> {
  if (!config.onedriveClientId || !config.onedriveClientSecret || !config.onedriveRefreshToken) {
    throw new Error('OneDrive backup requires ONEDRIVE_CLIENT_ID, ONEDRIVE_CLIENT_SECRET, and ONEDRIVE_REFRESH_TOKEN');
  }

  const body = new URLSearchParams({
    client_id: config.onedriveClientId,
    client_secret: config.onedriveClientSecret,
    refresh_token: config.onedriveRefreshToken,
    grant_type: 'refresh_token',
    scope: 'offline_access Files.ReadWrite User.Read',
  });

  const response = await fetch(`https://login.microsoftonline.com/${config.onedriveTenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`OneDrive OAuth token exchange failed with status ${response.status}`);
  }

  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('OneDrive OAuth token exchange did not return an access token');
  }

  return payload.access_token;
}

async function uploadToOneDrive(config: BackupConfig, artifact: BackupArtifact): Promise<void> {
  const accessToken = await fetchOneDriveAccessToken(config);
  const folder = config.onedriveFolder.replace(/\/+$/, '');
  const segments = [...folder.split('/').filter(Boolean), artifact.filename].map(encodeURIComponent);
  const uploadPath = `/${segments.join('/')}`;

  const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:${uploadPath}:/content`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': artifact.contentType,
    },
    body: toUint8Array(artifact.content),
  });

  if (!response.ok) {
    throw new Error(`OneDrive upload failed with status ${response.status}`);
  }
}

export class BackupService {
  readonly targetDescription: string;

  constructor(
    private readonly options: CreateBackupServiceOptions,
    private readonly config: BackupConfig,
  ) {
    this.targetDescription = this.config.target ?? 'manual-only';
  }

  syncJobs(): void {
    this.options.scheduler.unregister('database-backup');
    if (!this.config.cronExpression || !this.config.target) {
      return;
    }

    this.options.scheduler.register({
      name: 'database-backup',
      expression: this.config.cronExpression,
      timezone: this.config.timezone,
      handler: async () => {
        await this.dispatchBackup();
      },
    });
  }

  getCapabilities(): BackupCapabilities {
    const googleClient = this.config.googleOAuthJsonPath
      ? loadGoogleOAuthClientFromFile(this.config.googleOAuthJsonPath)
      : null;

    return {
      scheduleEnabled: Boolean(this.config.cronExpression && this.config.target),
      scheduleConfigured: Boolean(this.config.cronExpression),
      configuredTarget: this.config.target,
      configuredFormat: this.config.format,
      targets: {
        email: this.options.mailer !== null,
        'google-drive': Boolean(
          (this.config.googleOAuthClientId ?? googleClient?.clientId)
          && (this.config.googleOAuthClientSecret ?? googleClient?.clientSecret)
          && this.config.googleOAuthRefreshToken,
        ),
        onedrive: Boolean(
          this.config.onedriveClientId
          && this.config.onedriveClientSecret
          && this.config.onedriveRefreshToken,
        ),
      },
      formats: ['sqlite', 'msgpack'],
    };
  }

  async createDownloadArtifact(format: BackupFormat = this.config.format): Promise<BackupArtifact> {
    return format === 'msgpack'
      ? buildMsgpackArtifact(this.config.filenamePrefix, this.options.store.exportBackupSnapshot())
      : buildSqliteArtifact(this.config.filenamePrefix, this.options.store);
  }

  async restoreBackupArtifact(input: { format: BackupFormat; content: Buffer; }): Promise<void> {
    if (input.content.length === 0) {
      throw new Error('Backup payload is empty');
    }

    if (input.format === 'msgpack') {
      const snapshot = decode(input.content);
      if (isFullSnapshotPayload(snapshot)) {
        this.options.store.restoreBackupSnapshot(snapshot);
      } else {
        this.options.store.restoreEntityDump(snapshot);
      }
      return;
    }

    const stamp = timestampSlug(Date.now());
    const tempPath = path.join(os.tmpdir(), `${this.config.filenamePrefix}-restore-${stamp}.sqlite3`);
    await fs.writeFile(tempPath, input.content);
    try {
      this.options.store.restoreFromSqliteFile(tempPath);
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }

  async dispatchBackup(input?: { format?: BackupFormat; target?: BackupTarget; }): Promise<void> {
    const format = input?.format ?? this.config.format;
    const target = input?.target ?? this.config.target;
    if (!target) {
      throw new Error('No backup target is configured');
    }

    const capabilities = this.getCapabilities();
    if (!capabilities.targets[target]) {
      throw new Error(`Backup target "${target}" is not available`);
    }

    const artifact = await this.createDownloadArtifact(format);

    if (target === 'email') {
      if (!this.options.mailer) {
        throw new Error('Email backup target requires the mail subsystem to be configured');
      }
      if (this.config.emailRecipients.length === 0) {
        throw new Error('Email backup target requires BACKUP_EMAIL_RECIPIENTS or NOTIFY_RECIPIENTS');
      }

      await this.options.mailer.send({
        to: this.config.emailRecipients,
        subject: `[Labby] Database backup ${artifact.filename}`,
        text: `Attached is the scheduled ${format} backup generated at ${new Date().toISOString()}.`,
        attachments: [
          {
            filename: artifact.filename,
            content: artifact.content,
            contentType: artifact.contentType,
          },
        ],
      });
      return;
    }

    if (target === 'google-drive') {
      await uploadToGoogleDrive(this.config, artifact);
      return;
    }

    await uploadToOneDrive(this.config, artifact);
  }
}

export function setActiveBackupService(service: BackupService | null): void {
  activeBackupService = service;
}

export function getActiveBackupService(): BackupService | null {
  return activeBackupService;
}

export function createBackupServiceFromEnv(options: CreateBackupServiceOptions): BackupService | null {
  const target = ensureBackupTarget(process.env.BACKUP_TARGET?.trim());
  if (process.env.BACKUP_TARGET?.trim() && !target) {
    console.warn('[backup] Unsupported BACKUP_TARGET. Expected email, google-drive, or onedrive.');
  }

  return new BackupService(options, {
    cronExpression: process.env.BACKUP_CRON?.trim() || undefined,
    timezone: process.env.BACKUP_TIMEZONE?.trim() || 'UTC',
    format: ensureBackupFormat(process.env.BACKUP_FORMAT?.trim()),
    target,
    filenamePrefix: process.env.BACKUP_FILENAME_PREFIX?.trim() || 'labby-backup',
    emailRecipients: splitCsv(process.env.BACKUP_EMAIL_RECIPIENTS || process.env.NOTIFY_RECIPIENTS),
    googleOAuthJsonPath: process.env.GOOGLE_OAUTH_JSON_PATH?.trim(),
    googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID?.trim(),
    googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim(),
    googleOAuthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim(),
    googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID?.trim(),
    onedriveClientId: process.env.ONEDRIVE_CLIENT_ID?.trim(),
    onedriveClientSecret: process.env.ONEDRIVE_CLIENT_SECRET?.trim(),
    onedriveRefreshToken: process.env.ONEDRIVE_REFRESH_TOKEN?.trim(),
    onedriveTenantId: process.env.ONEDRIVE_TENANT_ID?.trim() || 'common',
    onedriveFolder: process.env.ONEDRIVE_FOLDER?.trim() || '/Apps/Labby',
  });
}