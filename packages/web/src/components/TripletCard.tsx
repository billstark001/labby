/** Triplet comparison Q&A card for building keyword similarity. */
import { useState } from 'preact/hooks';
import {
  keywordsSignal,
  keywordVectorsSignal,
} from '../store/index';
import { displayName } from '@/i18n';
import { useDatabase } from '../db/index';
import {
  nextTripletQueryFromKeywordVectors,
  initKeywordVectors,
} from '@labby/core';
import type { KeywordVector, TripletQuery } from '@labby/core';
import * as s from '../styles/components.css';
import { Button } from './ui/common';
import { i18n } from '@/i18n';
import { applyTripletWithWasm } from '@/lib/embedding-engine';

/** Max number of recently answered pair keys to exclude from next query. */
const RECENT_PAIR_LIMIT = 5;

export function TripletCard() {
  const db = useDatabase();
  const { t } = i18n;
  const keywords = keywordsSignal.value;
  const keywordMap = new Map(keywords.map(k => [k.id, k]));

  const [answered, setAnswered] = useState(0);
  // Track recently asked pair keys to avoid immediate repetition
  const [recentPairs, setRecentPairs] = useState<string[]>([]);

  function ensureKeywordVectors() {
    const current = keywordVectorsSignal.value;
    const ids = keywords.map(k => k.id);
    const copy = [...current];
    const existing = new Set(copy.map(v => v.keywordId));
    let changed = false;
    for (const id of ids) {
      if (!existing.has(id)) {
        const [created] = initKeywordVectors([id]);
        if (!created) continue;
        copy.push(created);
        changed = true;
      }
    }
    if (changed) keywordVectorsSignal.value = copy;
    return keywordVectorsSignal.value;
  }

  const vectors = ensureKeywordVectors();
  const recentPairSet = new Set(recentPairs);
  const query = nextTripletQueryFromKeywordVectors(vectors, recentPairSet);

  /** Record the pair from this query as recently answered. */
  function addRecentPair(q: TripletQuery) {
    const [a, b] = [q.anchorId, q.positiveId].sort();
    const key = `${a}|${b}`;
    setRecentPairs(prev => {
      const next = [key, ...prev.filter(k => k !== key)];
      return next.slice(0, RECENT_PAIR_LIMIT);
    });
  }

  async function handleAnswer(choice: 'positive' | 'negative' | 'equal') {
    if (!query) return;

    if (choice !== 'equal') {
      const effectiveQuery: TripletQuery =
        choice === 'positive'
          ? query
          : { anchorId: query.anchorId, positiveId: query.negativeId, negativeId: query.positiveId };

      const result = await applyTripletWithWasm(keywordVectorsSignal.value, effectiveQuery);

      if (result.updatedVectors?.length) {
        const merged = new Map(keywordVectorsSignal.value.map(v => [v.keywordId, v]));
        for (const vec of result.updatedVectors) {
          merged.set(vec.keywordId, vec);
        }
        await db.keywordVectors.putMany(result.updatedVectors);
        keywordVectorsSignal.value = [...merged.values()];
      }
    }

    addRecentPair(query);
    setAnswered(n => n + 1);
  }

  if (keywords.length < 3) {
    return (
      <div class={`${s.card} ${s.mb24} ${s.textMuted}`}>
        Add at least 3 keywords to start similarity training.
      </div>
    );
  }

  if (!query) return null;

  const anchor = keywordMap.get(query.anchorId);
  const positive = keywordMap.get(query.positiveId);
  const negative = keywordMap.get(query.negativeId);
  if (!anchor || !positive || !negative) return null;

  const question = t('tripletQuestion', displayName(anchor));
  const optA = t('tripletOptionA', displayName(positive));
  const optB = t('tripletOptionB', displayName(negative));

  return (
    <div class={`${s.card} ${s.mb24}`}>
      <p class={`${s.mb16} ${s.text16}`}>{question}</p>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={() => handleAnswer('positive')}>
          {optA}
        </Button>
        <Button variant="secondary" onClick={() => handleAnswer('negative')}>
          {optB}
        </Button>
        <Button variant="ghost" onClick={() => handleAnswer('equal')}>
          {t('tripletOptionEqual')}
        </Button>
      </div>
      {answered > 0 && (
        <p class={`${s.mt16} ${s.text12} ${s.textMuted}`}>
          {answered} comparison{answered > 1 ? 's' : ''} answered this session
        </p>
      )}
    </div>
  );
}
