import { signal, computed } from '@preact/signals';
import type { Person, Keyword, SchedulePlan, ScheduleConfig, SimilarityEdge } from '@labby/core';
import type { Locale } from '../i18n/translations.js';
import { translations } from '../i18n/translations.js';
import type { EmbeddingMap } from '@labby/core';

// ---------------------------------------------------------------------------
// Application state signals
// ---------------------------------------------------------------------------

export const localeSignal = signal<Locale>('en');
export const personsSignal = signal<Person[]>([]);
export const keywordsSignal = signal<Keyword[]>([]);
export const similarityEdgesSignal = signal<SimilarityEdge[]>([]);
export const embeddingsSignal = signal<EmbeddingMap>(new Map());
export const configsSignal = signal<ScheduleConfig[]>([]);
export const schedulesSignal = signal<SchedulePlan[]>([]);
export const currentScheduleSignal = signal<SchedulePlan | null>(null);
export const isComputingSignal = signal(false);

/** Currently active nav section. */
export type NavSection = 'persons' | 'keywords' | 'schedule' | 'graph' | 'settings';
export const navSignal = signal<NavSection>('schedule');

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/** UI string dictionary for the current locale. */
export const t = computed(() => translations[localeSignal.value]);

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

/** Get localised display name for any entity. */
export function displayName(
  entity: { name: string; names: Record<string, string> },
): string {
  return entity.names[localeSignal.value] ?? entity.name;
}
