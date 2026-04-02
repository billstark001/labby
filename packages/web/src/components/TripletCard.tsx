/** Triplet comparison Q&A card for building keyword similarity. */
import { useState } from 'preact/hooks';
import {
  keywordsSignal,
  embeddingsSignal,
  similarityEdgesSignal,
} from '../store/index';
import { displayName } from '@/i18n';
import { useDatabase } from '../db/index';
import {
  nextTripletQuery,
  applyTripletStep,
  cloneEmbeddings,
  embeddingsToSimilarities,
} from '@labby/core';
import type { SimilarityEdge, TripletQuery } from '@labby/core';
import * as s from '../styles/components.css';
import { Button } from './ui';
import { i18n } from '@/i18n';

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

  function ensureEmbeddings() {
    const current = embeddingsSignal.value;
    const ids = keywords.map(k => k.id);
    let changed = false;
    const copy = cloneEmbeddings(current);
    for (const id of ids) {
      if (!copy.has(id)) {
        copy.set(id, { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 });
        changed = true;
      }
    }
    if (changed) embeddingsSignal.value = copy;
    return embeddingsSignal.value;
  }

  const embeddings = ensureEmbeddings();
  const ids = keywords.map(k => k.id);
  const recentPairSet = new Set(recentPairs);
  const query = nextTripletQuery(embeddings, ids, recentPairSet);

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

      const updated = cloneEmbeddings(embeddingsSignal.value);
      applyTripletStep(updated, effectiveQuery);
      embeddingsSignal.value = updated;

      // Persist updated similarities
      const simMap = embeddingsToSimilarities(updated);
      await db.similarities.clear();
      const newEdges: SimilarityEdge[] = [];
      for (const [key, weight] of simMap) {
        const [sourceId, targetId] = key.split('|');
        const edge: SimilarityEdge = { sourceId, targetId, weight };
        newEdges.push(edge);
        await db.similarities.put(edge);
      }
      similarityEdgesSignal.value = newEdges;
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
