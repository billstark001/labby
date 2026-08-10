import { PGlite } from '@electric-sql/pglite';
import { worker } from '@electric-sql/pglite/worker';

void worker({
  init: (options) => PGlite.create({ ...options, dataDir: options.dataDir ?? 'idb://labby' }),
});
