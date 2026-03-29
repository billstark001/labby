/** Schedule configuration form and schedule view. */
import { useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import { Calendar, X } from 'lucide-preact';
import {
  personsSignal,
  configsSignal,
  schedulesSignal,
  currentScheduleSignal,
  similarityMapSignal,
  isComputingSignal,
  personMapSignal,
} from '../store/index.js';
import { fallbackEntityId } from '@/i18n.js';
import { displayName } from '@/i18n.js';
import { db } from '../db/index.js';
import { solveFull, solveIncremental } from '@labby/core';
import type { ScheduleConfig, SchedulePlan } from '@labby/core';
import * as s from '../styles/components.css.js';
import { Button } from '../components/ui.js';
import {
  copyScheduleTable,
  copyScheduleHtml,
  copyScheduleCsv,
  downloadScheduleCsv,
  downloadScheduleHtml,
  downloadScheduleIcs,
} from '../lib/scheduleExport.js';
import { Dialog, confirmDialog } from '../components/ui/Dialog.js';
import { i18n } from '@/i18n.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------------------
// Config form
// ---------------------------------------------------------------------------

interface ConfigFormProps {
  initial?: ScheduleConfig;
  onSave: (c: ScheduleConfig) => void;
  onCancel: () => void;
}

function ConfigForm({ initial, onSave, onCancel }: ConfigFormProps) {
  const { t } = i18n;
  const [daysStr, setDaysStr] = useState(
    initial ? initial.daysOfWeek.join(',') : '5',
  );
  const [startTime, setStartTime] = useState(initial?.timeRange[0] ?? '14:00');
  const [endTime, setEndTime] = useState(initial?.timeRange[1] ?? '16:00');
  const [presenters, setPresenters] = useState(initial?.presentersPerSession ?? 3);
  const [questioners, setQuestioners] = useState(
    initial?.questionersPerPresenter ?? 2,
  );
  const [radius, setRadius] = useState(initial?.targetSimilarityRadius ?? 0.5);
  const [startDate, setStartDate] = useState(initial?.startDate ?? '');
  const [endDate, setEndDate] = useState(initial?.endDate ?? '');

  function handleSave() {
    if (!startDate || !endDate) return;
    onSave({
      id: initial?.id ?? nanoid(),
      daysOfWeek: daysStr
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n)),
      timeRange: [startTime, endTime],
      presentersPerSession: presenters,
      questionersPerPresenter: questioners,
      targetSimilarityRadius: radius,
      startDate,
      endDate,
    });
  }

  return (
    <div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configDays')} (0=Sun…6=Sat, comma-separated)</label>
        <input
          class={s.input}
          value={daysStr}
          onInput={e => setDaysStr((e.target as HTMLInputElement).value)}
        />
        <div class={`${s.text12} ${s.textMuted}`}>
          {DAY_NAMES.map((d, i) => `${i}=${d}`).join(' ')}
        </div>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configStart')}</label>
        <input
          class={s.input}
          type="date"
          value={startDate}
          onInput={e => setStartDate((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configEnd')}</label>
        <input
          class={s.input}
          type="date"
          value={endDate}
          onInput={e => setEndDate((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configPresenters')}</label>
        <input
          class={s.input}
          type="number"
          min={1}
          value={presenters}
          onInput={e =>
            setPresenters(parseInt((e.target as HTMLInputElement).value, 10))
          }
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configQuestioners')}</label>
        <input
          class={s.input}
          type="number"
          min={1}
          value={questioners}
          onInput={e =>
            setQuestioners(parseInt((e.target as HTMLInputElement).value, 10))
          }
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configRadius')}</label>
        <input
          class={s.input}
          type="number"
          step={0.05}
          min={0}
          max={1}
          value={radius}
          onInput={e =>
            setRadius(parseFloat((e.target as HTMLInputElement).value))
          }
        />
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={handleSave}>
          {t('save')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SchedulePanel
// ---------------------------------------------------------------------------

export function SchedulePage() {
  const { t } = i18n;
  const configs = configsSignal.value;
  const persons = personsSignal.value;
  const schedules = schedulesSignal.value;
  const current = currentScheduleSignal.value;
  const isComputing = isComputingSignal.value;

  const [showConfigForm, setShowConfigForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ScheduleConfig | null>(null);
  const [selectedConfigId, setSelectedConfigId] = useState<string>(
    configs[0]?.id ?? '',
  );
  const [changeDate, setChangeDate] = useState('');
  const [copiedTsv, setCopiedTsv] = useState(false);
  const [copiedHtml, setCopiedHtml] = useState(false);
  const [copiedCsv, setCopiedCsv] = useState(false);

  const activePersonCount = persons.filter(p => !p.disabled).length;

  async function handleSaveConfig(c: ScheduleConfig) {
    await db.configs.put(c);
    configsSignal.value = await db.configs.getAll();
    setShowConfigForm(false);
    setEditingConfig(null);
    if (!selectedConfigId) setSelectedConfigId(c.id);
  }

  async function handleGenerate() {
    const config = configs.find(c => c.id === selectedConfigId);
    if (!config || activePersonCount === 0) return;
    isComputingSignal.value = true;
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      const plan = solveFull({
        persons,
        similarities: similarityMapSignal.value,
        config,
      });
      await db.schedules.put(plan);
      schedulesSignal.value = await db.schedules.getAll();
      currentScheduleSignal.value = plan;
    } finally {
      isComputingSignal.value = false;
    }
  }

  async function handleIncremental() {
    if (!current || !changeDate) return;
    const config = configs.find(c => c.id === current.configId);
    if (!config) return;
    isComputingSignal.value = true;
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      const plan = solveIncremental({
        persons,
        similarities: similarityMapSignal.value,
        config,
        previousPlan: current,
        changeDate,
      });
      await db.schedules.put(plan);
      schedulesSignal.value = await db.schedules.getAll();
      currentScheduleSignal.value = plan;
    } finally {
      isComputingSignal.value = false;
    }
  }

  const personMap = personMapSignal.value;

  async function handleCopyTsv() {
    if (!current) return;
    await copyScheduleTable(current, personMap, displayName);
    setCopiedTsv(true);
    window.setTimeout(() => setCopiedTsv(false), 1500);
  }

  async function handleCopyHtml() {
    if (!current) return;
    await copyScheduleHtml(current, personMap, displayName);
    setCopiedHtml(true);
    window.setTimeout(() => setCopiedHtml(false), 1500);
  }

  async function handleCopyCsv() {
    if (!current) return;
    await copyScheduleCsv(current, personMap, displayName);
    setCopiedCsv(true);
    window.setTimeout(() => setCopiedCsv(false), 1500);
  }

  function handleExportIcs() {
    if (!current) return;
    const config = configs.find(c => c.id === current.configId);
    downloadScheduleIcs(current, personMap, displayName, config, {
      presenter: t('presenter'),
      questioners: t('questioners'),
    });
  }

  async function handleDeleteHistory(plan: SchedulePlan) {
    confirmDialog(t('confirmDelete'), t('deleteHistory'), async () => {
      await db.schedules.delete(plan.id);
      const next = await db.schedules.getAll();
      schedulesSignal.value = next;
      if (currentScheduleSignal.value?.id === plan.id) {
        const latest = next.length > 0
          ? next.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
          : null;
        currentScheduleSignal.value = latest;
      }
    });
  }

  const selectedConfig = configs.find(c => c.id === selectedConfigId);

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navSchedule')}</h2>
      </div>

      {/* Config section */}
      <div class={`${s.card} ${s.mb24}`}>
        <div class={`${s.flexBetween} ${s.mb12}`}>
          <strong>{t('configTitle')}</strong>
          <div class={s.flexGapSm}>
            {selectedConfig && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingConfig(selectedConfig);
                  setShowConfigForm(true);
                }}
              >
                {t('editConfig')}
              </Button>
            )}
            <Button variant="secondary" onClick={() => { setEditingConfig(null); setShowConfigForm(true); }}>
              + {t('newConfig')}
            </Button>
          </div>
        </div>

        {configs.length === 0 ? (
          <p class={`${s.text14} ${s.textMuted}`}>
            No configuration yet. Create one to get started.
          </p>
        ) : (
          <select
            class={s.input}
            value={selectedConfigId}
            onChange={e =>
              setSelectedConfigId((e.target as HTMLSelectElement).value)
            }
          >
            {configs.map(c => (
              <option key={c.id} value={c.id}>
                {c.startDate} → {c.endDate} | {c.daysOfWeek.map(d => DAY_NAMES[d]).join(',')} |
                {c.presentersPerSession}×{c.questionersPerPresenter}
              </option>
            ))}
          </select>
        )}
      </div>

      {showConfigForm && (
        <Dialog
          open={true}
          onClose={() => {
            setShowConfigForm(false);
            setEditingConfig(null);
          }}
          closeOnOverlayClick={false}
          title={editingConfig ? t('editConfig') : t('newConfig')}
        >
          <ConfigForm
            initial={editingConfig ?? undefined}
            onSave={handleSaveConfig}
            onCancel={() => {
              setShowConfigForm(false);
              setEditingConfig(null);
            }}
          />
        </Dialog>
      )}

      {/* Generate / Incremental row */}
      <div class={`${s.toolbar} ${s.mb8}`}>
        <Button
          variant="primary"
          onClick={handleGenerate}
          disabled={isComputing || configs.length === 0 || activePersonCount === 0}
          title={activePersonCount === 0 ? t('notEnoughPersons') : undefined}
        >
          {isComputing ? t('computing') : t('generateSchedule')}
        </Button>
        {activePersonCount === 0 && persons.length > 0 && (
          <span class={`${s.text12} ${s.textDanger}`}>{t('notEnoughPersons')}</span>
        )}
        {current && (
          <>
            <Button
              variant="ghost"
              onClick={() => setChangeDate(new Date().toISOString().slice(0, 10))}
              title={t('today')}
            >
              {t('today')}
            </Button>
            <input
              class={`${s.input} ${s.autoWidthInput}`}
              type="date"
              value={changeDate}
              onInput={e => setChangeDate((e.target as HTMLInputElement).value)}
            />
            <Button
              variant="secondary"
              onClick={handleIncremental}
              disabled={isComputing || !changeDate}
            >
              {t('incrementalReschedule')}
            </Button>
          </>
        )}
      </div>

      {/* Copy / Export row */}
      {current && (
        <div class={`${s.toolbar} ${s.mb24}`}>
          <Button variant="secondary" onClick={handleCopyTsv}>
            {copiedTsv ? `✓ ${t('copyToClipboard')}` : t('copyToClipboard')}
          </Button>
          <Button variant="secondary" onClick={handleCopyHtml}>
            {copiedHtml ? `✓ ${t('copyAsHtml')}` : t('copyAsHtml')}
          </Button>
          <Button variant="secondary" onClick={handleCopyCsv}>
            {copiedCsv ? `✓ ${t('copyAsCsv')}` : t('copyAsCsv')}
          </Button>
          <Button variant="secondary" onClick={() => downloadScheduleHtml(current, personMap, displayName)}>
            {t('exportHtml')}
          </Button>
          <Button variant="secondary" onClick={() => downloadScheduleCsv(current, personMap, displayName)}>
            {t('exportCsv')}
          </Button>
          <Button variant="secondary" onClick={handleExportIcs}>
            {t('exportIcs')}
          </Button>
        </div>
      )}

      {/* History sidebar */}
      {schedules.length > 0 && (
        <div class={s.mb24}>
          <strong class={s.text14}>{t('historyTitle')}</strong>
          <div class={`${s.flexGapSm} ${s.flexWrap} ${s.mt8}`}>
            {[...schedules]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map(p => (
                <div key={p.id} class={s.historyItem}>
                  <button
                    class={`${s.badgeButton} ${current?.id === p.id ? '' : s.badgeButtonDimmed}`}
                    onClick={() => (currentScheduleSignal.value = p)}
                  >
                    {new Date(p.createdAt).toLocaleString()}
                  </button>
                  <button
                    class={s.historyDeleteButton}
                    onClick={() => void handleDeleteHistory(p)}
                    title={t('delete')}
                    aria-label={t('delete')}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Schedule table */}
      {!current ? (
        <div class={s.cardNoScheduke}>
          {t('noSchedule')}
        </div>
      ) : (
        current.sessions.map(sess => (
          <div key={sess.date} class={`${s.card} ${s.mb16}`}>
            <h3 class={`${s.mb12} ${s.text16} ${s.fontBold}`}>
              <span class={s.flexGapXs}>
                <Calendar size={16} />
                {sess.date}
              </span>
            </h3>
            <table class={s.table}>
              <colgroup>
                <col style={{ width: '30%' }} />
                <col style={{ width: '70%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th class={s.th}>{t('presenter')}</th>
                  <th class={s.th}>{t('questioners')}</th>
                </tr>
              </thead>
              <tbody>
                {sess.presentations.map((pres, i) => {
                  const presenter = personMap.get(pres.presenterId);
                  return (
                    <tr key={i}>
                      <td class={s.td}>
                        {presenter ? displayName(presenter) : fallbackEntityId(pres.presenterId)}
                      </td>
                      <td class={s.td}>
                        <div class={s.tagList}>
                          {pres.questionerIds.map(qid => {
                            const q = personMap.get(qid);
                            return (
                              <span key={qid} class={s.badge}>
                                {q ? displayName(q) : fallbackEntityId(qid)}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}
