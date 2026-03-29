/** Data import/export: MsgPack backup, HTML table, CSV via PapaParse. */
import { encode, decode } from '@msgpack/msgpack';
import {
  personsSignal,
  keywordsSignal,
  similarityEdgesSignal,
  configsSignal,
  schedulesSignal,
  unavailabilitiesSignal,
} from '../store/index.js';
import { db, dumpDatabase, restoreDatabase } from '../db/index.js';
import * as s from '../styles/components.css.js';
import { Button } from './ui.js';
import { i18n } from '@/i18n.js';
import { toast } from './ui/Toast.js';

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataPanel() {
  const { t } = i18n;

  async function handleExportBackup() {
    const id = toast.loading(t('computing'));
    try {
      const dump = await dumpDatabase();
      const packed = encode(dump);
      triggerDownload(new Blob([packed], { type: 'application/octet-stream' }), 'labby-backup.labby');
      toast.dismiss(id);
      toast.success(t('exportSuccess'));
    } catch (err) {
      toast.dismiss(id);
      toast.error(String(err));
    }
  }

  async function handleExportJson() {
    const id = toast.loading(t('computing'));
    try {
      const dump = await dumpDatabase();
      const json = JSON.stringify(dump, null, 2);
      triggerDownload(new Blob([json], { type: 'application/json' }), 'labby-backup.json');
      toast.dismiss(id);
      toast.success(t('exportSuccess'));
    } catch (err) {
      toast.dismiss(id);
      toast.error(String(err));
    }
  }

  function handleImportBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.labby,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const id = toast.loading(t('computing'));
      try {
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
        unavailabilitiesSignal.value = await db.unavailabilities.getAll();
        toast.dismiss(id);
        toast.success(t('importSuccess'));
      } catch (err) {
        toast.dismiss(id);
        toast.error(`${t('importError')}: ${String(err)}`);
      }
    };
    input.click();
  }

  return (
    <div>
      <h2 class={`${s.sectionTitle} ${s.mb24}`}>
        {t('dataImportExport')}
      </h2>

      <div class={`${s.card} ${s.mb24}`}>
        <h3 class={`${s.mb12} ${s.text15} ${s.fontMedium}`}>
          {t('databaseBackup')}
        </h3>
        <div class={s.toolbar}>
          <Button variant="primary" onClick={handleExportBackup}>
            {t('exportBackupLabby')}
          </Button>
          <Button variant="secondary" onClick={handleExportJson}>
            {t('exportBackupJson')}
          </Button>
          <Button variant="secondary" onClick={handleImportBackup}>
            {t('importBackup')}
          </Button>
        </div>
      </div>
    </div>
  );
}
