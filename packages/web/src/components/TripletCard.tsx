/** Triplet comparison Q&A card for building keyword similarity. */
import { useState } from 'preact/hooks';
import {
  keywordsSignal,
  embeddingsSignal,
  positions2dSignal,
} from '../store/index';
import { displayName } from '@/i18n';
import { useDatabase } from '../db/index';
import {
  nextTripletQuery,
  applyTripletStep,
  initEmbeddings,
  initPositions,
} from '@labby/core';
import type { TripletQuery } from '@labby/core';
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
  const [recentPairs, setRecentPairs] = useState<string[]>([]);

  function ensureEmbeddingsAndPositions() {
    const embeddings = embeddingsSignal.value;
    const positions = positions2dSignal.value;
    const ids = keywords.map(k => k.id);
    let embChanged = false;
    let posChanged = false;

    // Clone maps only if something is missing
    let workEmb = embeddings;
    let workPos = positions;
    for (const id of ids) {
      if (!workEmb.has(id)) {
        if (!embChanged) {
          workEmb = new Map(workEmb);
          embChanged = true;
        }
        workEmb.set(id, initEmbeddings([id]).get(id)!);
      }
      if (!workPos.has(id)) {
        if (!posChanged) {
          workPos = new Map(workPos);
          posChanged = true;
        }
        workPos.set(id, initPositions([id]).get(id)!);
      }
    }
    if (embChanged) embeddingsSignal.value = workEmb;
    if (posChanged) positions2dSignal.value = workPos;
    return { embeddings: embeddingsSignal.value, positions: positions2dSignal.value };
  }

  const { embeddings, positions } = ensureEmbeddingsAndPositions();
  const ids = keywords.map(k => k.id);
  const recentPairSet = new Set(recentPairs);
  const query = nextTripletQuery(embeddings, ids, recentPairSet);

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

      const { embeddings: newEmb, positions: newPos } = applyTripletStep(
        embeddingsSignal.value,
        positions2dSignal.value,
        effectiveQuery,
      );
      embeddingsSignal.value = newEmb;
      positions2dSignal.value = newPos;

      // Persist updated 64-D vectors and 2-D positions to DB
      const affectedIds = [effectiveQuery.anchorId, effectiveQuery.positiveId, effectiveQuery.negativeId];
      for (const id of affectedIds) {
        const kw = keywords.find(k => k.id === id);
        if (!kw) continue;
        const vec = newEmb.get(id);
        const pos = newPos.get(id);
        if (!vec || !pos) continue;
        const updated = {
          ...kw,
          metadata: {
            ...kw.metadata,
            embedding64: Array.from(vec),
            position2d: { x: pos.x, y: pos.y },
          },
        };
        await db.keywords.put(updated);
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
