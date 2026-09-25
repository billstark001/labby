import { batch, signal, computed } from '@preact/signals';
import { keywordVectorsToSimilarityLookup } from '@labby/core';
import type { Person, PersonTag, Keyword, SchedulePlan, ScheduleConfig, ScheduleConstraint, KeywordVector, PersonUnavailability, GraphSnapshotEdge } from '@labby/core';

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

// #region Application state signals

export const themeSignal = signal<'light' | 'dark'>(readPersistedTheme());
export const personsSignal = signal<Person[]>([]);
export const personTagsSignal = signal<PersonTag[]>([]);
export const keywordsSignal = signal<Keyword[]>([]);
export const keywordVectorsSignal = signal<KeywordVector[]>([]);
export const graphEdgesSignal = signal<GraphSnapshotEdge[]>([]);
export const configsSignal = signal<ScheduleConfig[]>([]);
export const constraintsSignal = signal<ScheduleConstraint[]>([]);
export const schedulesSignal = signal<SchedulePlan[]>([]);
export const currentScheduleSignal = signal<SchedulePlan | null>(null);
export const isComputingSignal = signal(false);
export const unavailabilitiesSignal = signal<PersonUnavailability[]>([]);

/** Clear data owned by the previous authenticated session. */
export function resetDataSignals(): void {
  batch(() => {
    personsSignal.value = [];
    personTagsSignal.value = [];
    keywordsSignal.value = [];
    keywordVectorsSignal.value = [];
    graphEdgesSignal.value = [];
    configsSignal.value = [];
    constraintsSignal.value = [];
    schedulesSignal.value = [];
    currentScheduleSignal.value = null;
    unavailabilitiesSignal.value = [];
  });
}

/** Currently active nav section. */
export type NavSection = 'persons' | 'keywords' | 'schedule' | 'graph' | 'settings';
export const navSignal = signal<NavSection>('schedule');

// #endregion

// #region Derived state

/** Person lookup map by ID. */
export const personMapSignal = computed(() => {
  const m = new Map<string, Person>();
  for (const p of personsSignal.value) m.set(p.id, p);
  return m;
});

export const personTagMapSignal = computed(() => {
  const m = new Map<string, PersonTag>();
  for (const tag of personTagsSignal.value) m.set(tag.id, tag);
  return m;
});

/** Keyword lookup map by ID. */
export const keywordMapSignal = computed(() => {
  const m = new Map<string, Keyword>();
  for (const k of keywordsSignal.value) m.set(k.id, k);
  return m;
});

/** Flat similarity lookup: key = `${a}|${b}` (a < b lexicographically). */
export const similarityLookupSignal = computed(() => {
  return keywordVectorsToSimilarityLookup(keywordVectorsSignal.value);
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

// #endregion
