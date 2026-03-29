/** Schedule configuration form and schedule view. */
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { nanoid } from 'nanoid';
import {
  personsSignal,
  keywordsSignal,
  configsSignal,
  schedulesSignal,
  currentScheduleSignal,
  similarityMapSignal,
  isComputingSignal,
  personMapSignal,
  t,
  displayName,
} from '../store/index.js';
import { db } from '../db/index.js';
import { solveFull, solveIncremental } from '@labby/core';
import type { ScheduleConfig, SchedulePlan } from '@labby/core';
import * as s from '../styles/components.css.js';
import { Button } from './ui.js';

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
  const strings = t.value;
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
        <label class={s.label}>{strings.configDays} (0=Sun…6=Sat, comma-separated)</label>
        <input
          class={s.input}
          value={daysStr}
          onInput={e => setDaysStr((e.target as HTMLInputElement).value)}
        />
        <div style={{ fontSize: '12px', color: '#64748b' }}>
          {DAY_NAMES.map((d, i) => `${i}=${d}`).join(' ')}
        </div>
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{strings.configStart}</label>
        <input
          class={s.input}
          type="date"
          value={startDate}
          onInput={e => setStartDate((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{strings.configEnd}</label>
        <input
          class={s.input}
          type="date"
          value={endDate}
          onInput={e => setEndDate((e.target as HTMLInputElement).value)}
        />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{strings.configPresenters}</label>
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
        <label class={s.label}>{strings.configQuestioners}</label>
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
        <label class={s.label}>{strings.configRadius}</label>
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
      <div style={{ display: 'flex', gap: '8px' }}>
        <Button variant="primary" onClick={handleSave}>
          {strings.save}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {strings.cancel}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SchedulePanel
// ---------------------------------------------------------------------------

export function SchedulePanel() {
  const strings = t.value;
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

  async function handleSaveConfig(c: ScheduleConfig) {
    await db.configs.put(c);
    configsSignal.value = await db.configs.getAll();
    setShowConfigForm(false);
    setEditingConfig(null);
    if (!selectedConfigId) setSelectedConfigId(c.id);
  }

  async function handleGenerate() {
    const config = configs.find(c => c.id === selectedConfigId);
    if (!config || persons.length === 0) return;
    isComputingSignal.value = true;
    try {
      // Run in a microtask to allow UI to update
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

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{strings.navSchedule}</h2>
      </div>

      {/* Config section */}
      <div class={s.card} style={{ marginBottom: '24px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '12px',
          }}
        >
          <strong>{strings.configTitle}</strong>
          <Button variant="secondary" onClick={() => setShowConfigForm(true)}>
            + New Config
          </Button>
        </div>

        {configs.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: '14px' }}>
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
        <div class={s.modalOverlay}>
          <div class={s.modalBox}>
            <h3 style={{ marginBottom: '16px' }}>{strings.configTitle}</h3>
            <ConfigForm
              initial={editingConfig ?? undefined}
              onSave={handleSaveConfig}
              onCancel={() => {
                setShowConfigForm(false);
                setEditingConfig(null);
              }}
            />
          </div>
        </div>
      )}

      {/* Generate / Incremental */}
      <div class={s.toolbar} style={{ marginBottom: '24px' }}>
        <Button
          variant="primary"
          onClick={handleGenerate}
          disabled={isComputing || configs.length === 0 || persons.length === 0}
        >
          {isComputing ? strings.computing : strings.generateSchedule}
        </Button>
        {current && (
          <>
            <input
              class={s.input}
              type="date"
              value={changeDate}
              onInput={e => setChangeDate((e.target as HTMLInputElement).value)}
              style={{ width: 'auto' }}
            />
            <Button
              variant="secondary"
              onClick={handleIncremental}
              disabled={isComputing || !changeDate}
            >
              {strings.incrementalReschedule}
            </Button>
          </>
        )}
      </div>

      {/* History sidebar */}
      {schedules.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <strong style={{ fontSize: '14px' }}>{strings.historyTitle}</strong>
          <div
            style={{
              display: 'flex',
              gap: '8px',
              flexWrap: 'wrap',
              marginTop: '8px',
            }}
          >
            {[...schedules]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map(p => (
                <button
                  key={p.id}
                  class={s.badge}
                  style={{
                    cursor: 'pointer',
                    opacity: current?.id === p.id ? 1 : 0.5,
                  }}
                  onClick={() => (currentScheduleSignal.value = p)}
                >
                  {new Date(p.createdAt).toLocaleString()}
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Schedule table */}
      {!current ? (
        <div class={s.card} style={{ padding: '32px', textAlign: 'center', color: '#64748b' }}>
          {strings.noSchedule}
        </div>
      ) : (
        current.sessions.map(sess => (
          <div key={sess.date} class={s.card} style={{ marginBottom: '16px' }}>
            <h3 style={{ marginBottom: '12px', fontSize: '16px', fontWeight: 700 }}>
              📅 {sess.date}
            </h3>
            <table class={s.table}>
              <thead>
                <tr>
                  <th class={s.th}>{strings.presenter}</th>
                  <th class={s.th}>{strings.questioners}</th>
                </tr>
              </thead>
              <tbody>
                {sess.presentations.map((pres, i) => {
                  const presenter = personMap.get(pres.presenterId);
                  return (
                    <tr key={i}>
                      <td class={s.td}>
                        {presenter ? displayName(presenter) : pres.presenterId}
                      </td>
                      <td class={s.td}>
                        <div class={s.tagList}>
                          {pres.questionerIds.map(qid => {
                            const q = personMap.get(qid);
                            return (
                              <span key={qid} class={s.badge}>
                                {q ? displayName(q) : qid}
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
