import { signal, computed } from '@preact/signals';
import type { Person, Keyword, SchedulePlan, ScheduleConfig, SimilarityEdge, PersonUnavailability } from '@labby/core';
import type { EmbeddingMap } from '@labby/core';

function readPersistedTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  try {
    const raw = localStorage.getItem('theme');
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    // Ignore storage access errors.
  }
  return 'light';
}

// ---------------------------------------------------------------------------
// Application state signals
// ---------------------------------------------------------------------------

export const themeSignal = signal<'light' | 'dark'>(readPersistedTheme());
export const personsSignal = signal<Person[]>([]);
export const keywordsSignal = signal<Keyword[]>([]);
export const similarityEdgesSignal = signal<SimilarityEdge[]>([]);
export const embeddingsSignal = signal<EmbeddingMap>(new Map());
export const configsSignal = signal<ScheduleConfig[]>([]);
export const schedulesSignal = signal<SchedulePlan[]>([]);
export const currentScheduleSignal = signal<SchedulePlan | null>(null);
export const isComputingSignal = signal(false);
export const unavailabilitiesSignal = signal<PersonUnavailability[]>([]);

/** Currently active nav section. */
export type NavSection = 'persons' | 'keywords' | 'schedule' | 'graph' | 'settings';
export const navSignal = signal<NavSection>('schedule');

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/** Person lookup map by ID. */
export const personMapSignal = computed(() => {
  const m = new Map<string, Person>();
  for (const p of personsSignal.value) m.set(p.id, p);
  return m;
});

/** Keyword lookup map by ID. */
export const keywordMapSignal = computed(() => {
  const m = new Map<string, Keyword>();
  for (const k of keywordsSignal.value) m.set(k.id, k);
  return m;
});

/** Flat similarity lookup: key = `${a}|${b}` (a < b lexicographically). */
export const similarityMapSignal = computed(() => {
  const m = new Map<string, number>();
  for (const e of similarityEdgesSignal.value) {
    const [a, b] =
      e.sourceId < e.targetId
        ? [e.sourceId, e.targetId]
        : [e.targetId, e.sourceId];
    m.set(`${a}|${b}`, e.weight);
  }
  return m;
});

/** Presentation count per person in the current schedule. */
export const presentationCountSignal = computed(() => {
  const counts = new Map<string, number>();
  const plan = currentScheduleSignal.value;
  if (!plan) return counts;
  for (const sess of plan.sessions) {
    for (const pres of sess.presentations) {
      counts.set(pres.presenterId, (counts.get(pres.presenterId) ?? 0) + 1);
    }
  }
  return counts;
});
