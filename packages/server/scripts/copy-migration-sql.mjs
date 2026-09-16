import { readdir, mkdir, copyFile } from 'node:fs/promises';
const source = new URL('../src/store/migrate/', import.meta.url);
const target = new URL('../dist/store/migrate/', import.meta.url);
await mkdir(target, { recursive: true });
for (const file of await readdir(source)) {
  if (file.endsWith('.sql')) await copyFile(new URL(file, source), new URL(file, target));
}

await copyFile(new URL('../src/store/current-schema.sql', import.meta.url), new URL('../dist/store/current-schema.sql', import.meta.url));
