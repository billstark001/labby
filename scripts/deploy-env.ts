import { resolveInjectedEnv } from 'env-lane';

export const SERVER_RUNTIME_ENV_KEYS = [
  'NODE_ENV',
  'DB_DRIVER',
  'DATABASE_URL',
  'DATABASE_SSL',
  'WEB_DIST_DIR',
  'PASETO_SECRET',
  'PASETO_ACCESS_KEY',
  'PASETO_REFRESH_KEY',
  'AUTH_ISSUER',
  'AUTH_AUDIENCE',
  'AUTH_ACCESS_TTL',
  'AUTH_REFRESH_TTL',
  'AUTH_CODE_TTL',
  'ROOT_USERNAME',
  'ROOT_PASSWORD',
  'ROOT_EMAIL',
  'SMTP_PROVIDER',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_FROM',
  'GMAIL_USER',
  'GMAIL_REFRESH_TOKEN',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_JSON_PATH',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
  'GOOGLE_OAUTH_REFRESH_TOKEN_PATH',
  'ENABLE_PUBLIC_EMAIL_TASK_ICS',
  'PUBLIC_BASE_URL',
  'SCHEDULER_MODE',
  'SCHEDULER_DISPATCH_API_KEY',
  'CLOUD_SCHEDULER_PROJECT_ID',
  'CLOUD_SCHEDULER_LOCATION',
  'CLOUD_SCHEDULER_DISPATCH_URL',
  'CLOUD_SCHEDULER_JOB_PREFIX',
  'AUTH_CLEANUP_CRON',
  'AUTH_CLEANUP_TIMEZONE',
  'NOTIFY_RECIPIENTS',
  'BACKUP_CRON',
  'BACKUP_TIMEZONE',
  'BACKUP_FORMAT',
  'BACKUP_TARGET',
  'BACKUP_FILENAME_PREFIX',
  'BACKUP_EMAIL_RECIPIENTS',
  'GOOGLE_DRIVE_FOLDER_ID',
  'ONEDRIVE_CLIENT_ID',
  'ONEDRIVE_CLIENT_SECRET',
  'ONEDRIVE_REFRESH_TOKEN',
  'ONEDRIVE_TENANT_ID',
  'ONEDRIVE_FOLDER',
] as const;

export const RAILWAY_CRON_ENV_KEYS = [
  'LABBY_SERVER_URL',
  'LABBY_CRON_JOB',
  'LABBY_CRON_TIMEOUT_MS',
  'LABBY_CRON_ATTEMPTS',
  'SCHEDULER_DISPATCH_API_KEY',
] as const;

export interface DeploymentEnvArguments {
  sync: boolean;
  build: string;
  deleteKeys: string[];
}

export interface DeploymentEnvPlan {
  build: string;
  files: string[];
  values: Record<string, string>;
  updates: Record<string, string>;
  deletes: string[];
}

export interface DeploymentEnvDiff {
  updates: Array<[string, string]>;
  deletes: string[];
}

function readOptionValue(args: string[], index: number, option: string): { value: string; consumed: number } | null {
  const argument = args[index];
  if (argument === option) {
    const value = args[index + 1];
    if (!value) throw new Error(`${option} requires a value`);
    return { value, consumed: 2 };
  }
  if (argument.startsWith(`${option}=`)) {
    const value = argument.slice(option.length + 1);
    if (!value) throw new Error(`${option} requires a value`);
    return { value, consumed: 1 };
  }
  return null;
}

export function parseDeploymentEnvArguments(
  args: string[],
  defaultBuild: string,
): { env: DeploymentEnvArguments; remaining: string[] } {
  let sync = true;
  let build = defaultBuild;
  const deleteKeys: string[] = [];
  const remaining: string[] = [];

  for (let index = 0; index < args.length;) {
    const argument = args[index];
    if (argument === '--sync-env') {
      sync = true;
      index += 1;
      continue;
    }
    if (argument === '--no-env-sync') {
      sync = false;
      index += 1;
      continue;
    }
    const buildOption = readOptionValue(args, index, '--env-build');
    if (buildOption) {
      build = buildOption.value;
      index += buildOption.consumed;
      continue;
    }
    const deleteOption = readOptionValue(args, index, '--delete-env');
    if (deleteOption) {
      deleteKeys.push(...deleteOption.value.split(',').map((key) => key.trim()).filter(Boolean));
      index += deleteOption.consumed;
      continue;
    }
    remaining.push(argument);
    index += 1;
  }

  const uniqueDeletes = [...new Set(deleteKeys)];
  if (!sync && uniqueDeletes.length > 0) throw new Error('--delete-env cannot be used with --no-env-sync');
  return { env: { sync, build, deleteKeys: uniqueDeletes }, remaining };
}

export async function buildDeploymentEnvPlan(options: {
  root: string;
  build: string;
  allowedKeys: readonly string[];
  deleteKeys?: readonly string[];
  target?: string;
}): Promise<DeploymentEnvPlan> {
  const allowed = new Set(options.allowedKeys);
  const deletes = [...new Set(options.deleteKeys ?? [])];
  for (const key of deletes) {
    if (!allowed.has(key)) throw new Error(`Cannot delete unmanaged environment variable: ${key}`);
  }

  const resolved = await resolveInjectedEnv({
    cwd: options.root,
    target: options.target ?? 'server',
    build: options.build,
    includeProcessEnv: false,
  });
  const files = resolved.files.filter((file) => file.exists).map((file) => file.relativePath);
  if (files.length === 0) {
    throw new Error(`No dotenv file found for deployment build '${options.build}'.`);
  }

  const deleteSet = new Set(deletes);
  const updates = Object.fromEntries(
    Object.entries(resolved.values).filter(([key]) => allowed.has(key) && !deleteSet.has(key)),
  );

  return {
    build: resolved.build,
    files,
    values: resolved.values,
    updates,
    deletes,
  };
}

export function diffDeploymentEnvironment(
  current: Record<string, string>,
  updates: Record<string, string>,
  deletes: readonly string[],
): DeploymentEnvDiff {
  return {
    updates: Object.entries(updates).filter(([key, value]) => current[key] !== value),
    deletes: deletes.filter((key) => Object.hasOwn(current, key)),
  };
}

export function encodeGcloudDictionary(values: Record<string, string>): string | null {
  const entries = Object.entries(values);
  if (entries.length === 0) return null;
  const candidates = ['@', '|', ';', '%', '~', '§'];
  const delimiter = candidates.find((candidate) => entries.every(([key, value]) => !key.includes(candidate) && !value.includes(candidate)));
  if (!delimiter) throw new Error('Cannot encode Cloud Run environment values with a safe gcloud delimiter.');
  return `^${delimiter}^${entries.map(([key, value]) => `${key}=${value}`).join(delimiter)}`;
}
