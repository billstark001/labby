import type { StoreConnectionConfig } from '../store/index.js';

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? '';
}

export function validateHttpUrl(name: string, value: string): string {
  const text = value.trim();
  if (!text) {
    throw new Error(`${name} must not be empty`);
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }

  return text;
}

export function resolvePublicBaseUrl(env: NodeJS.ProcessEnv, port: number): string {
  const explicit = readTrimmed(env, 'PUBLIC_BASE_URL');
  return explicit
    ? validateHttpUrl('PUBLIC_BASE_URL', explicit)
    : `http://localhost:${port}`;
}

export function resolveStoreConnectionConfig(env: NodeJS.ProcessEnv): StoreConnectionConfig {
  const dbDriver = readTrimmed(env, 'DB_DRIVER').toLowerCase();
  const databaseUrl = readTrimmed(env, 'DATABASE_URL');

  if (dbDriver && dbDriver !== 'sqlite' && dbDriver !== 'postgres') {
    throw new Error('DB_DRIVER must be "sqlite" or "postgres"');
  }

  if (databaseUrl && dbDriver !== 'postgres') {
    throw new Error('DATABASE_URL is set but DB_DRIVER=postgres is required to use it');
  }

  if (dbDriver === 'postgres') {
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
    }

    return {
      dialect: 'postgres',
      connectionString: databaseUrl,
      ssl: env.DATABASE_SSL === '1' || env.DATABASE_SSL === 'true',
    };
  }

  return {
    dialect: 'sqlite',
    path: readTrimmed(env, 'DB_PATH') || './run/labby.db',
  };
}
