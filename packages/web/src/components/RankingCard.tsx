import { useState } from 'preact/hooks';
import type { RankingJudgment, RankingQuery } from '@labby/core';
import { graphData } from '@/lib/graph-sync';
import { RankingOrder } from './RankingOrder';
import { displayName, i18n } from '@/i18n';
import { useDatabase } from '@/db';
import { recommendRanking, trainRanking } from '@/lib/embedding-engine';
import { rankingGroups } from '@/lib/ranking-editor';
import { Button } from './ui/common';
import { ContentSkeleton } from './ui/Skeleton';
import { toast } from './ui/Toast';
import { useAsyncResource } from '@/lib/use-async-resource';
import * as s from '@/styles/components.css';

export function RankingEditor({ query, onSaved }: { query: RankingQuery; onSaved?: () => void }) {
  const db = useDatabase();
  const { t } = i18n;
  const [ranks, setRanks] = useState<Record<string, number>>({});
  const [confidence, setConfidence] = useState(1);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [saved, setSaved] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const [createdAt] = useState(() => Date.now());
  const names = new Map(graphData.value.keywords.map(k => [k.id, `${displayName(k)}${k.disabled ? ` (${t('disabled')})` : ''}`]));
  const groups = rankingGroups(query.candidateIds, ranks);
  const valid = groups.flat().length >= 2;

  async function submit() {
    if (busy || saved || !valid) return;
    setBusy(true); setFeedback('');
    try {
      const result = await trainRanking(db, { id: requestId, anchorId: query.anchorId, groups, confidence, createdAt });
      if (!result.accepted) { setFeedback(t('rankingConflict')); return; }
      setSaved(true); setFeedback(t('rankingSaved')); onSaved?.();
    } catch (error) { setFeedback(error instanceof Error ? error.message : t('rankingFailed')); }
    finally { setBusy(false); }
  }

  return <div aria-busy={busy}>
    <h3 class={s.mb12}>{t('rankingQuestion', names.get(query.anchorId) ?? query.anchorId)}</h3>
    <p class={s.mutedParagraph}>{t('rankingInstructions')}</p>
    <RankingOrder candidates={query.candidateIds} ranks={ranks} names={names} disabled={busy || saved} onChange={setRanks} />
    <label class={s.label} htmlFor={`confidence-${requestId}`}>{t('rankingConfidence')}</label>
    <select id={`confidence-${requestId}`} class={s.input} value={confidence} disabled={busy || saved} onChange={e => setConfidence(Number(e.currentTarget.value))}>
      <option value={1}>{t('rankingConfident')}</option><option value={0.5}>{t('rankingTentative')}</option>
    </select>
    {valid && <p class={s.mutedParagraph}>{groups.map(group => group.map(id => names.get(id) ?? id).join(' = ')).join(' → ')}</p>}
    <Button busy={busy} onClick={() => void submit()} disabled={busy || saved || !valid}>{busy ? t('rankingSaving') : t('rankingSubmit')}</Button>
    {feedback && <p role="status" class={s.mutedParagraph}>{feedback}</p>}
  </div>;
}

export function RankingCard() {
  const db = useDatabase();
  const { t } = i18n;
  const keywords = graphData.value.keywords;
  const keywordKey = keywords.map(k => k.id).sort().join('\n');
  const [excludedKeys, setExcluded] = useState<string[]>([]);
  const [answered, setAnswered] = useState(0);
  const [revision, setRevision] = useState(0);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const resource = useAsyncResource(async () => {
    const [query, history] = await Promise.all([
      recommendRanking(db, excludedKeys, includeDisabled),
      db.similarity.getHistory(),
    ]);
    return { query, history };
  }, [db, keywordKey, excludedKeys, revision, includeDisabled]);
  const query = resource.data?.query ?? null;
  const history: RankingJudgment[] = resource.data?.history ?? [];

  async function forget(id: string) {
    setMutationPending(true);
    try {
      await db.similarity.forgetJudgment(id);
      setExcluded([]);
      setRevision(n => n + 1);
    } catch (error) {
      // Mutation failures are deliberately separate from query state.
      toast.error(error instanceof Error ? error.message : t('rankingFailed'));
    } finally {
      setMutationPending(false);
    }
  }
  function next(saved: boolean) {
    if (!query) return;
    if (saved) setAnswered(n => n + 1);
    setExcluded(previous => [...previous, query.key].slice(-200));
  }
  const errorMessage = resource.error instanceof Error ? resource.error.message : resource.error ? String(resource.error) : '';
  return <div class={`${s.card} ${s.mb24}`} aria-busy={resource.isPending || mutationPending}>
    <label class={s.label}>
      <input type="checkbox" checked={includeDisabled} disabled={resource.isPending} onChange={event => setIncludeDisabled(event.currentTarget.checked)} />
      {' '}{t('rankingIncludeDisabled')}
    </label>
    {resource.isInitialLoading ? <ContentSkeleton rows={3} /> : <>
      {errorMessage && <p role="alert" class={s.textDanger}>{errorMessage} <Button variant="secondary" busy={resource.isPending} onClick={() => void resource.refetch()}>{t('retry')}</Button></p>}
      {resource.data && (query ? <><RankingEditor key={query.key} query={query} onSaved={() => next(true)} />
        <Button variant="ghost" onClick={() => next(false)}>{t('rankingSkip')}</Button></>
      : <p>{keywords.length < 3 ? t('rankingNeedKeywords') : t('rankingNoQuestions')}</p>)}
    </>}
    {answered > 0 && <p class={s.mutedParagraph}>{t('rankingAnswered', String(answered))}</p>}
    <details class={s.mt16}>
      <summary>{t('rankingHistoryCount', String(history.length))}</summary>
      <p class={s.mutedParagraph}>{t('rankingForgetHint')}</p>
      {history.slice().sort((a,b) => b.createdAt-a.createdAt).slice(0,20).map(j => {
        const name = (id: string) => { const k = keywords.find(k => k.id === id); return k ? displayName(k) : id; };
        return <div key={j.id} class={s.formGroup}>
          <p>{name(j.anchorId)}: {j.groups.map(g => g.map(name).join(' = ')).join(' → ')}</p>
          <Button variant="ghost" busy={mutationPending} disabled={resource.isPending || mutationPending} onClick={() => void forget(j.id)}>{t('rankingForget')}</Button>
        </div>;
      })}
    </details>
  </div>;
}
