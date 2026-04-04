/** Triplet comparison Q&A card for building keyword similarity. */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  keywordsSignal,
  keywordVectorsSignal,
} from '../store/index';
import { displayName } from '@/i18n';
import { useDatabase } from '../db/index';
import {
  initKeywordVectors,
} from '@labby/core';
import type { KeywordVector, TripletQuery } from '@labby/core';
import * as s from '../styles/components.css';
import { Button } from './ui/common';
import { i18n } from '@/i18n';
import { applyTripletWithWasm, recommendTripletWithWasm } from '@/lib/embedding-engine';
import { isServerDeployment } from '@/lib/runtime';

/** Max number of recently answered pair keys to exclude from next query. */
const RECENT_PAIR_LIMIT = 32;
const PERSIST_DEBOUNCE_MS = 800;

export function TripletCard() {
  const db = useDatabase();
  const { t } = i18n;
  const keywords = keywordsSignal.value;
  const keywordMap = new Map(keywords.map(k => [k.id, k]));

  const [answered, setAnswered] = useState(0);
  // Track recently asked pair keys to avoid immediate repetition
  const [recentPairs, setRecentPairs] = useState<string[]>([]);
  const [query, setQuery] = useState<TripletQuery | null>(null);
  const [feedback, setFeedback] = useState<string>('');
  const pendingPersistRef = useRef<Map<string, KeywordVector>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recommendSeqRef = useRef(0);

  async function flushPendingPersist(): Promise<void> {
    if (isServerDeployment) {
      pendingPersistRef.current.clear();
      return;
    }
    if (pendingPersistRef.current.size === 0) return;
    const values = [...pendingPersistRef.current.values()];
    pendingPersistRef.current.clear();
    await db.keywordVectors.putMany(values);
  }

  function schedulePersist(): void {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
    }
    flushTimerRef.current = setTimeout(() => {
      void flushPendingPersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
      void flushPendingPersist();
    };
  }, []);

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

  useEffect(() => {
    if (vectors.length < 3) {
      setQuery(null);
      return;
    }

    recommendSeqRef.current += 1;
    const seq = recommendSeqRef.current;

    void recommendTripletWithWasm(vectors, recentPairs)
      .then((next) => {
        if (recommendSeqRef.current !== seq) return;
        setQuery(next);
      })
      .catch(() => {
        if (recommendSeqRef.current !== seq) return;
        setQuery(null);
      });
  }, [vectors, recentPairs]);

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

    let answeredQuery = query;

    if (choice !== 'equal') {
      try {
        const effectiveQuery: TripletQuery =
          choice === 'positive'
            ? query
            : { anchorId: query.anchorId, positiveId: query.negativeId, negativeId: query.positiveId };
        answeredQuery = effectiveQuery;

        const result = await applyTripletWithWasm(keywordVectorsSignal.value, effectiveQuery);

        if (result.updatedVectors?.length) {
          const merged = new Map(keywordVectorsSignal.value.map(v => [v.keywordId, v]));
          for (const vec of result.updatedVectors) {
            merged.set(vec.keywordId, vec);
            if (!isServerDeployment) {
              pendingPersistRef.current.set(vec.keywordId, vec);
            }
          }
          if (!isServerDeployment) {
            schedulePersist();
          }
          keywordVectorsSignal.value = [...merged.values()];
        }
        setFeedback(`Supervision applied. Updated ${result.updatedVectors.length} vectors.`);
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : 'Supervision failed.');
      }
    } else {
      setFeedback('Equal selected. No vector update applied.');
    }

    addRecentPair(answeredQuery);
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
      {feedback && (
        <p class={`${s.mt8} ${s.text12} ${s.textMuted}`}>{feedback}</p>
      )}
    </div>
  );
}
