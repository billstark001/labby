/** Schedule configuration form and schedule view. */
import { useEffect, useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import { Calendar, X, Pencil } from 'lucide-preact';
import {
  personsSignal,
  configsSignal,
  schedulesSignal,
  currentScheduleSignal,
  similarityMapSignal,
  isComputingSignal,
  personMapSignal,
  unavailabilitiesSignal,
} from '../store/index.js';
import { fallbackEntityId, displayName } from '@/i18n.js';
import {
  loadAllConfigs,
  loadAllPersons,
  loadAllSchedules,
  loadAllSimilarities,
  loadAllUnavailabilities,
  useDatabase,
} from '../db/index.js';
import { solveFull, solveIncremental } from '@labby/core';
import type { ScheduleConfig, SchedulePlan, PersonUnavailability, Session, Presentation } from '@labby/core';
import * as s from '../styles/components.css.js';
import {
  Button,
  ResponsiveDataField,
  ResponsiveDataView,
  responsiveDataStyles as dataStyles,
} from '../components/ui.js';
import {
  copyScheduleTable,
  copyScheduleHtml,
  copyScheduleCsv,
  downloadScheduleCsv,
  downloadScheduleHtml,
  downloadScheduleIcs,
} from '../lib/scheduleExport.js';
import { Dialog, confirmDialog } from '../components/ui/Dialog.js';
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator } from '../components/ui/Menu.js';
import { toast } from '../components/ui/Toast.js';
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
  const [daysStr, setDaysStr] = useState(initial ? initial.daysOfWeek.join(',') : '5');
  const [startTime, setStartTime] = useState(initial?.timeRange[0] ?? '14:00');
  const [endTime, setEndTime] = useState(initial?.timeRange[1] ?? '16:00');
  const [presenters, setPresenters] = useState(initial?.presentersPerSession ?? 3);
  const [questioners, setQuestioners] = useState(initial?.questionersPerPresenter ?? 2);
  const [radius, setRadius] = useState(initial?.targetSimilarityRadius ?? 0.5);
  const [startDate, setStartDate] = useState(initial?.startDate ?? '');
  const [endDate, setEndDate] = useState(initial?.endDate ?? '');

  function handleSave() {
    if (!startDate || !endDate) return;
    onSave({
      id: initial?.id ?? nanoid(),
      daysOfWeek: daysStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)),
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
        <input class={s.input} value={daysStr} onInput={e => setDaysStr((e.target as HTMLInputElement).value)} />
        <div class={`${s.text12} ${s.textMuted}`}>{DAY_NAMES.map((d, i) => `${i}=${d}`).join(' ')}</div>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configStart')}</label>
        <input class={s.input} type="date" value={startDate} onInput={e => setStartDate((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configEnd')}</label>
        <input class={s.input} type="date" value={endDate} onInput={e => setEndDate((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configTime')}</label>
        <div class={s.flexGapSm}>
          <input class={s.input} type="time" value={startTime} onInput={e => setStartTime((e.target as HTMLInputElement).value)} />
          <span class={s.textMuted}>–</span>
          <input class={s.input} type="time" value={endTime} onInput={e => setEndTime((e.target as HTMLInputElement).value)} />
        </div>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configPresenters')}</label>
        <input class={s.input} type="number" min={1} value={presenters} onInput={e => setPresenters(parseInt((e.target as HTMLInputElement).value, 10))} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configQuestioners')}</label>
        <input class={s.input} type="number" min={1} value={questioners} onInput={e => setQuestioners(parseInt((e.target as HTMLInputElement).value, 10))} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('configRadius')}</label>
        <input class={s.input} type="number" step={0.05} min={0} max={1} value={radius} onInput={e => setRadius(parseFloat((e.target as HTMLInputElement).value))} />
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={handleSave}>{t('save')}</Button>
        <Button variant="secondary" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PersonUnavailability form
// ---------------------------------------------------------------------------

interface UnavailFormProps {
  configId: string;
  onSave: (u: PersonUnavailability) => void;
  onCancel: () => void;
}

function UnavailForm({ configId, onSave, onCancel }: UnavailFormProps) {
  const { t } = i18n;
  const persons = personsSignal.value;
  const [personId, setPersonId] = useState(persons[0]?.id ?? '');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  function handleSave() {
    if (!personId || !startDate || !endDate) return;
    onSave({ id: nanoid(), personId, configId, startDate, endDate });
  }

  return (
    <div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('unavailPerson')}</label>
        <select class={s.input} value={personId} onChange={e => setPersonId((e.target as HTMLSelectElement).value)}>
          {persons.map(p => <option key={p.id} value={p.id}>{displayName(p)}</option>)}
        </select>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('unavailStart')}</label>
        <input class={s.input} type="date" value={startDate} onInput={e => setStartDate((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('unavailEnd')}</label>
        <input class={s.input} type="date" value={endDate} onInput={e => setEndDate((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={handleSave}>{t('save')}</Button>
        <Button variant="secondary" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HistoryNotesDialog
// ---------------------------------------------------------------------------

interface HistoryNotesDialogProps {
  plan: SchedulePlan;
  onSave: (notes: string) => void;
  onClose: () => void;
}

function HistoryNotesDialog({ plan, onSave, onClose }: HistoryNotesDialogProps) {
  const { t } = i18n;
  const [notes, setNotes] = useState(plan.notes ?? '');
  return (
    <Dialog open={true} onClose={onClose} title={t('historyNotes')}>
      <div class={s.formGroup}>
        <textarea
          class={s.input}
          rows={4}
          value={notes}
          onInput={e => setNotes((e.target as HTMLTextAreaElement).value)}
        />
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={() => { onSave(notes); onClose(); }}>{t('save')}</Button>
        <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ManualEditDialog – select replacement presenter or questioner
// ---------------------------------------------------------------------------

interface ManualEditDialogProps {
  mode: 'presenter' | 'questioner';
  sessionDate: string;
  presIndex: number;
  questIndex?: number; // only for questioner mode
  onClose: () => void;
}

function ManualEditDialog({ mode, sessionDate, presIndex, questIndex, onClose }: ManualEditDialogProps) {
  const { t } = i18n;
  const persons = personsSignal.value.filter(p => !p.disabled);
  const current = currentScheduleSignal.value;
  const simMap = similarityMapSignal.value;
  const personMap = personMapSignal.value;
  const db = useDatabase();

  if (!current) return null;

  const session = current.sessions.find(s => s.date === sessionDate);
  if (!session) return null;
  const pres = session.presentations[presIndex];
  if (!pres) return null;

  const currentId = mode === 'presenter' ? pres.presenterId : pres.questionerIds[questIndex ?? 0];

  function similarity(aId: string, bId: string): number {
    if (aId === bId) return 1;
    const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
    return simMap.get(`${a}|${b}`) ?? 0;
  }

  const presenterPerson = personMap.get(pres.presenterId);

  function handleSelect(newId: string) {
    if (!current) return;
    const newSessions: Session[] = current.sessions.map(sess => {
      if (sess.date !== sessionDate) return sess;
      const newPresentations: Presentation[] = sess.presentations.map((p, pi) => {
        if (pi !== presIndex) return p;
        if (mode === 'presenter') {
          return { ...p, presenterId: newId };
        } else {
          const newQIds = [...p.questionerIds];
          newQIds[questIndex ?? 0] = newId;
          return { ...p, questionerIds: newQIds };
        }
      });
      return { ...sess, presentations: newPresentations };
    });
    const updated: SchedulePlan = { ...current, sessions: newSessions };
    db.schedules.put(updated).then(async () => {
      await loadAllSchedules(db);
      currentScheduleSignal.value = updated;
    });
    onClose();
  }

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title={mode === 'presenter' ? t('selectNewPresenter') : t('selectNewQuestioner')}
    >
      <table class={s.table}>
        <thead>
          <tr>
            <th class={s.th}>{t('name')}</th>
            {mode === 'questioner' && presenterPerson && (
              <th class={s.th}>{t('similarity')}</th>
            )}
            <th class={s.th}></th>
          </tr>
        </thead>
        <tbody>
          {persons.map(p => (
            <tr key={p.id} style={{ opacity: p.id === currentId ? 0.4 : 1 }}>
              <td class={s.td}>{displayName(p)}</td>
              {mode === 'questioner' && presenterPerson && (
                <td class={s.td}>{similarity(p.id, pres.presenterId).toFixed(3)}</td>
              )}
              <td class={s.td}>
                <Button
                  variant={p.id === currentId ? 'ghost' : 'primary'}
                  onClick={() => handleSelect(p.id)}
                  disabled={p.id === currentId}
                >
                  {t('confirm')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// SchedulePage
// ---------------------------------------------------------------------------

export function SchedulePage() {
  const { t } = i18n;
  const configs = configsSignal.value;
  const persons = personsSignal.value;
  const schedules = schedulesSignal.value;
  const current = currentScheduleSignal.value;
  const isComputing = isComputingSignal.value;
  const unavailabilities = unavailabilitiesSignal.value;
  const db = useDatabase();

  const [showConfigForm, setShowConfigForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ScheduleConfig | null>(null);
  const [selectedConfigId, setSelectedConfigId] = useState<string>(configs[0]?.id ?? '');
  const [changeDate, setChangeDate] = useState('');
  const [copiedTsv, setCopiedTsv] = useState(false);
  const [copiedHtml, setCopiedHtml] = useState(false);
  const [copiedCsv, setCopiedCsv] = useState(false);
  const [showUnavailForm, setShowUnavailForm] = useState(false);
  const [editingNotes, setEditingNotes] = useState<SchedulePlan | null>(null);
  const [manualEditTarget, setManualEditTarget] = useState<{
    mode: 'presenter' | 'questioner';
    sessionDate: string;
    presIndex: number;
    questIndex?: number;
  } | null>(null);
  const [manualEditMode, setManualEditMode] = useState(false);

  const activePersonCount = persons.filter(p => !p.disabled).length;
  const selectedConfig = configs.find(c => c.id === selectedConfigId);
  const personMap = personMapSignal.value;

  // Unavailabilities scoped to the selected config
  const configUnavails = unavailabilities.filter(u => u.configId === selectedConfigId);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      await Promise.all([
        loadAllPersons(db),
        loadAllConfigs(db),
        loadAllSchedules(db),
        loadAllSimilarities(db),
        loadAllUnavailabilities(db),
      ]);
      if (cancelled) return;
      if (!currentScheduleSignal.value && schedulesSignal.value.length > 0) {
        const latest = schedulesSignal.value.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
        currentScheduleSignal.value = latest;
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [db]);

  async function handleSaveConfig(c: ScheduleConfig) {
    await db.configs.put(c);
    await loadAllConfigs(db);
    setShowConfigForm(false);
    setEditingConfig(null);
    if (!selectedConfigId) setSelectedConfigId(c.id);
  }

  async function handleGenerate() {
    const config = configs.find(c => c.id === selectedConfigId);
    if (!config || activePersonCount === 0) return;
    isComputingSignal.value = true;
    const tid = toast.loading(t('computing'));
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      const plan = solveFull({
        persons,
        similarities: similarityMapSignal.value,
        config,
        unavailabilities,
      });
      await db.schedules.put(plan);
      await loadAllSchedules(db);
      currentScheduleSignal.value = plan;
      toast.dismiss(tid);
      toast.success(t('computeSuccess'));
    } catch (err) {
      toast.dismiss(tid);
      toast.error(`${t('computeError')}: ${String(err)}`);
    } finally {
      isComputingSignal.value = false;
    }
  }

  async function handleIncremental() {
    if (!current || !changeDate) return;
    const config = configs.find(c => c.id === current.configId);
    if (!config) return;
    isComputingSignal.value = true;
    const tid = toast.loading(t('computing'));
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      const plan = solveIncremental({
        persons,
        similarities: similarityMapSignal.value,
        config,
        previousPlan: current,
        changeDate,
        unavailabilities,
      });
      await db.schedules.put(plan);
      await loadAllSchedules(db);
      currentScheduleSignal.value = plan;
      toast.dismiss(tid);
      toast.success(t('computeSuccess'));
    } catch (err) {
      toast.dismiss(tid);
      toast.error(`${t('computeError')}: ${String(err)}`);
    } finally {
      isComputingSignal.value = false;
    }
  }

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
      await loadAllSchedules(db);
      const next = schedulesSignal.value;
      schedulesSignal.value = next;
      if (currentScheduleSignal.value?.id === plan.id) {
        const latest = next.length > 0 ? next.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)) : null;
        currentScheduleSignal.value = latest;
      }
    });
  }

  async function handleSaveHistoryNotes(plan: SchedulePlan, notes: string) {
    const updated = { ...plan, notes };
    await db.schedules.put(updated);
    await loadAllSchedules(db);
    if (currentScheduleSignal.value?.id === plan.id) {
      currentScheduleSignal.value = updated;
    }
  }

  async function handleSaveUnavail(u: PersonUnavailability) {
    await db.unavailabilities.put(u);
    await loadAllUnavailabilities(db);
    setShowUnavailForm(false);
  }

  async function handleDeleteUnavail(id: string) {
    await db.unavailabilities.delete(id);
    await loadAllUnavailabilities(db);
  }

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{t('navSchedule')}</h2>
        <Button
          variant={manualEditMode ? 'primary' : 'ghost'}
          onClick={() => setManualEditMode(m => !m)}
        >
          <Pencil size={14} />
          {manualEditMode ? t('manualEditMode') : t('manualEdit')}
        </Button>
      </div>

      {/* Config section */}
      <div class={`${s.card} ${s.mb24}`}>
        <div class={`${s.flexBetween} ${s.mb12}`}>
          <strong>{t('configTitle')}</strong>
          <div class={s.flexGapSm}>
            {selectedConfig && (
              <Button variant="ghost" onClick={() => { setEditingConfig(selectedConfig); setShowConfigForm(true); }}>
                {t('editConfig')}
              </Button>
            )}
            <Button variant="secondary" onClick={() => { setEditingConfig(null); setShowConfigForm(true); }}>
              + {t('newConfig')}
            </Button>
          </div>
        </div>

        {configs.length === 0 ? (
          <p class={`${s.text14} ${s.textMuted}`}>{t('noConfigYet')}</p>
        ) : (
          <select
            class={s.input}
            value={selectedConfigId}
            onChange={e => setSelectedConfigId((e.target as HTMLSelectElement).value)}
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

      {/* Unavailability section (per config) */}
      {selectedConfigId && (
        <div class={`${s.card} ${s.mb24}`}>
          <div class={`${s.flexBetween} ${s.mb12}`}>
            <strong>{t('unavailability')}</strong>
            <Button variant="secondary" onClick={() => setShowUnavailForm(true)}>
              + {t('addUnavailability')}
            </Button>
          </div>
          {configUnavails.length === 0 ? (
            <p class={`${s.text14} ${s.textMuted}`}>—</p>
          ) : (
            <ResponsiveDataView
              items={configUnavails}
              columns={[
                { header: t('unavailPerson') },
                { header: t('unavailStart') },
                { header: t('unavailEnd') },
              ]}
              getKey={unavail => unavail.id}
              renderDesktopRow={unavail => {
                const person = personMap.get(unavail.personId);
                return (
                  <>
                    <td class={s.td}>{person ? displayName(person) : fallbackEntityId(unavail.personId)}</td>
                    <td class={s.td}>{unavail.startDate}</td>
                    <td class={s.td}>{unavail.endDate}</td>
                  </>
                );
              }}
              renderMobileCard={unavail => {
                const person = personMap.get(unavail.personId);
                return (
                  <>
                    <div class={dataStyles.mobileHeader}>
                      <div class={dataStyles.mobileTitle}>
                        {person ? displayName(person) : fallbackEntityId(unavail.personId)}
                      </div>
                    </div>
                    <div class={dataStyles.mobileFields}>
                      <ResponsiveDataField label={t('unavailStart')}>
                        {unavail.startDate}
                      </ResponsiveDataField>
                      <ResponsiveDataField label={t('unavailEnd')}>
                        {unavail.endDate}
                      </ResponsiveDataField>
                    </div>
                  </>
                );
              }}
              renderActions={unavail => (
                <Button variant="danger" onClick={() => handleDeleteUnavail(unavail.id)}>{t('delete')}</Button>
              )}
            />
          )}
        </div>
      )}

      {showUnavailForm && selectedConfigId && (
        <Dialog open={true} onClose={() => setShowUnavailForm(false)} closeOnOverlayClick={false} title={t('addUnavailability')}>
          <UnavailForm
            configId={selectedConfigId}
            onSave={handleSaveUnavail}
            onCancel={() => setShowUnavailForm(false)}
          />
        </Dialog>
      )}

      {showConfigForm && (
        <Dialog
          open={true}
          onClose={() => { setShowConfigForm(false); setEditingConfig(null); }}
          closeOnOverlayClick={false}
          title={editingConfig ? t('editConfig') : t('newConfig')}
        >
          <ConfigForm
            initial={editingConfig ?? undefined}
            onSave={handleSaveConfig}
            onCancel={() => { setShowConfigForm(false); setEditingConfig(null); }}
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
            <Button variant="ghost" onClick={() => setChangeDate(new Date().toISOString().slice(0, 10))} title={t('today')}>
              {t('today')}
            </Button>
            <input
              class={`${s.input} ${s.autoWidthInput}`}
              type="date"
              value={changeDate}
              onInput={e => setChangeDate((e.target as HTMLInputElement).value)}
            />
            <Button variant="secondary" onClick={handleIncremental} disabled={isComputing || !changeDate}>
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
          <Button variant="secondary" onClick={() => downloadScheduleHtml(current, personMap, displayName)}>{t('exportHtml')}</Button>
          <Button variant="secondary" onClick={() => downloadScheduleCsv(current, personMap, displayName)}>{t('exportCsv')}</Button>
          <Button variant="secondary" onClick={handleExportIcs}>{t('exportIcs')}</Button>
        </div>
      )}

      {/* History */}
      {schedules.length > 0 && (
        <div class={s.mb24}>
          <strong class={s.text14}>{t('historyTitle')}</strong>
          <div class={`${s.flexGapSm} ${s.flexWrap} ${s.mt8}`}>
            {[...schedules]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map(p => (
                <Menu key={p.id} mode="context">
                  <MenuTrigger>
                    <div class={s.historyItem}>
                      <button
                        class={`${s.badgeButton} ${current?.id === p.id ? '' : s.badgeButtonDimmed}`}
                        onClick={() => (currentScheduleSignal.value = p)}
                      >
                        {new Date(p.createdAt).toLocaleString()}
                        {p.notes && <span class={`${s.text12} ${s.textMuted}`}> — {p.notes}</span>}
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
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onSelect={() => {
                      const txt = `${new Date(p.createdAt).toLocaleString()}${p.notes ? ' — ' + p.notes : ''}`;
                      navigator.clipboard?.writeText(txt).then(
                        () => toast.success(t('copyToClipboard')),
                        () => toast.error(t('importError')),
                      );
                    }}>
                      {t('copySchedule')}
                    </MenuItem>
                    <MenuItem onSelect={() => setEditingNotes(p)}>
                      {t('editNotes')}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem onSelect={() => handleDeleteHistory(p)} danger>
                      {t('delete')}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              ))}
          </div>
        </div>
      )}

      {/* Notes edit dialog */}
      {editingNotes && (
        <HistoryNotesDialog
          plan={editingNotes}
          onSave={notes => void handleSaveHistoryNotes(editingNotes, notes)}
          onClose={() => setEditingNotes(null)}
        />
      )}

      {/* Manual edit dialog */}
      {manualEditTarget && (
        <ManualEditDialog
          {...manualEditTarget}
          onClose={() => setManualEditTarget(null)}
        />
      )}

      {/* Schedule tables */}
      {!current ? (
        <div class={s.cardNoScheduke}>{t('noSchedule')}</div>
      ) : (
        current.sessions.map(sess => (
          <div key={sess.date} class={`${s.card} ${s.mb16}`}>
            <h3 class={`${s.mb12} ${s.text16} ${s.fontBold}`}>
              <span class={s.flexGapXs}>
                <Calendar size={16} />
                {sess.date}
              </span>
            </h3>
            <ResponsiveDataView
              items={sess.presentations}
              columns={[
                { header: t('presenter') },
                { header: t('questioners') },
              ]}
              getKey={(_, index) => index}
              colGroup={
                <colgroup>
                  <col style={{ width: '30%' }} />
                  <col style={{ width: '70%' }} />
                </colgroup>
              }
              renderDesktopRow={(pres, pi) => {
                const presenter = personMap.get(pres.presenterId);
                return (
                  <>
                    <td class={s.td}>
                      {manualEditMode ? (
                        <Menu mode="context">
                          <MenuTrigger>
                            <span class={s.editableCell}>
                              {presenter ? displayName(presenter) : fallbackEntityId(pres.presenterId)}
                            </span>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem onSelect={() => setManualEditTarget({ mode: 'presenter', sessionDate: sess.date, presIndex: pi })}>
                              {t('selectNewPresenter')}
                            </MenuItem>
                          </MenuContent>
                        </Menu>
                      ) : (
                        presenter ? displayName(presenter) : fallbackEntityId(pres.presenterId)
                      )}
                    </td>
                    <td class={s.td}>
                      <div class={s.tagList}>
                        {pres.questionerIds.map((qid, qi) => {
                          const questioner = personMap.get(qid);
                          const name = questioner ? displayName(questioner) : fallbackEntityId(qid);
                          return manualEditMode ? (
                            <Menu key={`${qid}-${qi}`} mode="context">
                              <MenuTrigger>
                                <span class={`${s.badge} ${s.editableCell}`}>{name}</span>
                              </MenuTrigger>
                              <MenuContent>
                                <MenuItem onSelect={() => setManualEditTarget({ mode: 'questioner', sessionDate: sess.date, presIndex: pi, questIndex: qi })}>
                                  {t('selectNewQuestioner')}
                                </MenuItem>
                              </MenuContent>
                            </Menu>
                          ) : (
                            <span key={`${qid}-${qi}`} class={s.badge}>{name}</span>
                          );
                        })}
                      </div>
                    </td>
                  </>
                );
              }}
              renderMobileCard={(pres, pi) => {
                const presenter = personMap.get(pres.presenterId);
                return (
                  <>
                    <div class={dataStyles.mobileHeader}>
                      <div>
                        <div class={dataStyles.mobileTitle}>{presenter ? displayName(presenter) : fallbackEntityId(pres.presenterId)}</div>
                        <div class={dataStyles.mobileSubtitle}>{t('presenter')}</div>
                      </div>
                    </div>
                    <div class={dataStyles.mobileFields}>
                      <ResponsiveDataField label={t('questioners')}>
                        <div class={s.tagList}>
                          {pres.questionerIds.map((qid, qi) => {
                            const questioner = personMap.get(qid);
                            const name = questioner ? displayName(questioner) : fallbackEntityId(qid);
                            return manualEditMode ? (
                              <Menu key={`${qid}-${qi}`} mode="context">
                                <MenuTrigger>
                                  <span class={`${s.badge} ${s.editableCell}`}>{name}</span>
                                </MenuTrigger>
                                <MenuContent>
                                  <MenuItem onSelect={() => setManualEditTarget({ mode: 'questioner', sessionDate: sess.date, presIndex: pi, questIndex: qi })}>
                                    {t('selectNewQuestioner')}
                                  </MenuItem>
                                </MenuContent>
                              </Menu>
                            ) : (
                              <span key={`${qid}-${qi}`} class={s.badge}>{name}</span>
                            );
                          })}
                        </div>
                      </ResponsiveDataField>
                    </div>
                    {manualEditMode && (
                      <div class={s.flexGapXs}>
                        <Button
                          variant="ghost"
                          onClick={() => setManualEditTarget({ mode: 'presenter', sessionDate: sess.date, presIndex: pi })}
                        >
                          {t('selectNewPresenter')}
                        </Button>
                      </div>
                    )}
                  </>
                );
              }}
            />
          </div>
        ))
      )}
    </div>
  );
}
