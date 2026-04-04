import { useEffect } from 'preact/hooks';
import { KeywordGraph } from "@/components/KeywordGraph";
import { KeywordList } from "@/components/KeywordList";
import { TripletCard } from "@/components/TripletCard";
import { loadAllKeywords, loadAllSimilarities, useDatabase } from '@/db/index';
import * as s from '@/styles/components.css';

export function KeywordsPage() {
  const db = useDatabase();

  useEffect(() => {
    void Promise.all([loadAllKeywords(db), loadAllSimilarities(db)]);
  }, [db]);

  return (
    <div>
      <KeywordList />
      <KeywordGraph />
      <div class={s.sectionStack}>
        <TripletCard />
      </div>
    </div>
  )
}