/** Triplet comparison Q&A card for building keyword similarity. */
import { useState } from 'preact/hooks';
import {
  keywordsSignal,
  embeddingsSignal,
  similarityEdgesSignal,
} from '../store/index.js';
import { displayName } from '@/i18n.js';
import { db } from '../db/index.js';
import {
  nextTripletQuery,
  applyTripletStep,
  cloneEmbeddings,
  embeddingsToSimilarities,
} from '@labby/core';
import type { SimilarityEdge, TripletQuery } from '@labby/core';
import * as s from '../styles/components.css.js';
import { Button } from './ui.js';
import { i18n } from '@/i18n.js';

export function TripletCard() {
  const { t } = i18n;
  const keywords = keywordsSignal.value;
  const keywordMap = new Map(keywords.map(k => [k.id, k]));

  const [answered, setAnswered] = useState(0);

  function ensureEmbeddings() {
    const current = embeddingsSignal.value;
    const ids = keywords.map(k => k.id);
    // Add missing embeddings
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
  const query = nextTripletQuery(embeddings, ids);

  async function handleAnswer(isPositive: boolean) {
    if (!query) return;
    const effectiveQuery: TripletQuery = isPositive
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

  const question = t(
    'tripletQuestion',
    displayName(anchor),
    displayName(positive),
    displayName(negative),
  );

  return (
    <div class={`${s.card} ${s.mb24}`}>
      <p class={`${s.mb16} ${s.text16}`}>{question}</p>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={() => handleAnswer(true)}>
          {t('tripletYes')}
        </Button>
        <Button variant="secondary" onClick={() => handleAnswer(false)}>
          {t('tripletNo')}
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
