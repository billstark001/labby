import { useEffect } from 'preact/hooks';
import { KeywordGraph } from "@/components/KeywordGraph";
import { KeywordList } from "@/components/KeywordList";
import { TripletCard } from "@/components/TripletCard";
import { listKeywordsPage, readKeywordForeignKeys, useDatabase } from '@/db/index';
import { keywordsSignal, keywordVectorsSignal, personsSignal } from '@/store';
import * as s from '@/styles/components.css';

export function KeywordsPage() {
  const db = useDatabase();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const firstPage = await listKeywordsPage(db, { offset: 0, limit: 20 });
      if (cancelled) return;
      keywordsSignal.value = firstPage.items;
      const keywordIds = firstPage.items.map((item) => item.id);
      if (keywordIds.length === 0) {
        personsSignal.value = [];
        keywordVectorsSignal.value = [];
        return;
      }
      const bundle = await readKeywordForeignKeys(db, keywordIds);
      if (cancelled) return;
      personsSignal.value = bundle.persons;
      keywordVectorsSignal.value = bundle.keywordVectors;
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