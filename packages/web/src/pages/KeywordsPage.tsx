import { useEffect } from 'preact/hooks';
import { KeywordGraph } from '@/components/KeywordGraph';
import { KeywordList } from '@/components/KeywordList';
import { RankingCard } from '@/components/RankingCard';
import { useDatabase } from '@/db/index';
import { graphStream } from '@/lib/graph-sync';
import * as s from '@/styles/components.css';
export function KeywordsPage() {
  const db = useDatabase();
  useEffect(() => graphStream(db).start(), [db]);
  return <div><KeywordList /><KeywordGraph /><div class={s.sectionStack}><RankingCard /></div></div>;
}
