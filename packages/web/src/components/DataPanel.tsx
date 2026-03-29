/** Data import/export: MsgPack backup, HTML table, CSV via PapaParse. */
import { h } from 'preact';
import { encode, decode } from '@msgpack/msgpack';
import Papa from 'papaparse';
import {
  personsSignal,
  keywordsSignal,
  similarityEdgesSignal,
  configsSignal,
  schedulesSignal,
  currentScheduleSignal,
  personMapSignal,
  t,
  displayName,
} from '../store/index.js';
import { db, dumpDatabase, restoreDatabase } from '../db/index.js';
import * as s from '../styles/components.css.js';
import { Button } from './ui.js';

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataPanel() {
  const strings = t.value;
  const current = currentScheduleSignal.value;
  const personMap = personMapSignal.value;

  async function handleExportBackup() {
    const dump = await dumpDatabase();
    const packed = encode(dump);
    triggerDownload(new Blob([packed], { type: 'application/octet-stream' }), 'labby-backup.labby');
  }

  async function handleExportJson() {
    const dump = await dumpDatabase();
    const json = JSON.stringify(dump, null, 2);
    triggerDownload(new Blob([json], { type: 'application/json' }), 'labby-backup.json');
  }

  function handleImportBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.labby,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const buffer = await file.arrayBuffer();
      let dump: Awaited<ReturnType<typeof dumpDatabase>>;
      if (file.name.endsWith('.json')) {
        dump = JSON.parse(new TextDecoder().decode(buffer));
      } else {
        dump = decode(buffer) as typeof dump;
      }
      await restoreDatabase(dump);
      personsSignal.value = await db.persons.getAll();
      keywordsSignal.value = await db.keywords.getAll();
      similarityEdgesSignal.value = await db.similarities.getAll();
      configsSignal.value = await db.configs.getAll();
      schedulesSignal.value = await db.schedules.getAll();
    };
    input.click();
  }

  function handleExportHtml() {
    if (!current) return;
    const rows = current.sessions
      .flatMap(sess =>
        sess.presentations.map(pres => {
          const presenter = personMap.get(pres.presenterId);
          const questioners = pres.questionerIds
            .map(qid => {
              const q = personMap.get(qid);
              return q ? displayName(q) : qid;
            })
            .join(', ');
          return `<tr>
  <td style="padding:8px;border:1px solid #e2e8f0">${sess.date}</td>
  <td style="padding:8px;border:1px solid #e2e8f0">${presenter ? displayName(presenter) : pres.presenterId}</td>
  <td style="padding:8px;border:1px solid #e2e8f0">${questioners}</td>
</tr>`;
        }),
      )
      .join('\n');

    const html = `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
<thead>
<tr>
  <th style="padding:8px;border:1px solid #e2e8f0;background:#f8fafc">Date</th>
  <th style="padding:8px;border:1px solid #e2e8f0;background:#f8fafc">Presenter</th>
  <th style="padding:8px;border:1px solid #e2e8f0;background:#f8fafc">Questioners</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>`;
    triggerDownload(new Blob([html], { type: 'text/html' }), 'schedule.html');
  }

  function handleExportCsv() {
    if (!current) return;
    const rows = current.sessions.flatMap(sess =>
      sess.presentations.map(pres => {
        const presenter = personMap.get(pres.presenterId);
        const questioners = pres.questionerIds
          .map(qid => {
            const q = personMap.get(qid);
            return q ? displayName(q) : qid;
          })
          .join('; ');
        return {
          date: sess.date,
          presenter: presenter ? displayName(presenter) : pres.presenterId,
          questioners,
        };
      }),
    );
    const csv = Papa.unparse(rows);
    triggerDownload(new Blob([csv], { type: 'text/csv' }), 'schedule.csv');
  }

  return (
    <div>
      <h2 class={s.sectionTitle} style={{ marginBottom: '24px' }}>
        Data Import / Export
      </h2>

      <div class={s.card} style={{ marginBottom: '24px' }}>
        <h3 style={{ marginBottom: '12px', fontSize: '15px', fontWeight: 600 }}>
          Database Backup
        </h3>
        <div class={s.toolbar}>
          <Button variant="primary" onClick={handleExportBackup}>
            {strings.exportBackup} (.labby)
          </Button>
          <Button variant="secondary" onClick={handleExportJson}>
            {strings.exportBackup} (.json)
          </Button>
          <Button variant="secondary" onClick={handleImportBackup}>
            {strings.importBackup}
          </Button>
        </div>
      </div>

      {current && (
        <div class={s.card}>
          <h3 style={{ marginBottom: '12px', fontSize: '15px', fontWeight: 600 }}>
            Export Schedule
          </h3>
          <div class={s.toolbar}>
            <Button variant="primary" onClick={handleExportHtml}>
              {strings.exportHtml}
            </Button>
            <Button variant="secondary" onClick={handleExportCsv}>
              {strings.exportCsv}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
