import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { initializePostgresSchema } from '../../src/store/initialize.js';
import { LabbyStore } from '../../src/store/index.js';
import { createApp } from '../../src/app.js';

/** Stable UUIDs keep fixtures readable while exercising the production UUID contract. */
export function testUuid(label: string): string {
  const digest = createHash('sha256').update(`labby:test:${label}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function prepare(config: { dialect: 'pglite'; dataDir: string }) {
  const temporary =
    config.dataDir === 'memory://'
      ? await mkdtemp(path.join(os.tmpdir(), 'labby-explicit-test-'))
      : null;
  const target = temporary ? { ...config, dataDir: path.join(temporary, 'db') } : config;
  const db = new PGlite({ dataDir: target.dataDir });
  try {
    const exists = (
      await db.query<{ name: string | null }>("SELECT to_regclass('schema_migrations') AS name")
    ).rows[0]?.name;
    if (!exists) await initializePostgresSchema(db);
  } finally {
    await db.close();
  }
  return { target, temporary };
}

export async function createTestStore(config: {
  dialect: 'pglite';
  dataDir: string;
}): Promise<LabbyStore> {
  const { target, temporary } = await prepare(config);
  const store = new LabbyStore(target);
  const close = store.close.bind(store);
  store.close = async () => {
    try {
      await close();
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  };
  return store;
}

export async function createTestApp(options: Parameters<typeof createApp>[0]) {
  if (!options.db || options.db.dialect !== 'pglite')
    throw new Error('Tests require an explicit PGlite target');
  const { target } = await prepare(options.db);
  return createApp({ ...options, db: target });
}
