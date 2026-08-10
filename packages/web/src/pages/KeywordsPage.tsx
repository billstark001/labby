import { useEffect } from 'preact/hooks';
import { KeywordGraph } from "@/components/KeywordGraph";
import { KeywordList } from "@/components/KeywordList";
import { TripletCard } from "@/components/TripletCard";
import { useDatabase } from '@/db/index';
import { graphEdgesSignal, keywordsSignal, keywordVectorsSignal, personsSignal } from '@/store';
import * as s from '@/styles/components.css';

export function KeywordsPage() {
  const db = useDatabase();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snapshot = await db.graph.getSnapshot();
      if (cancelled) return;
      keywordsSignal.value = snapshot.keywords;
      keywordVectorsSignal.value = snapshot.keywordVectors;
      graphEdgesSignal.value = snapshot.edges;
      personsSignal.value = [];
    })();
    return () => { cancelled = true; };
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
