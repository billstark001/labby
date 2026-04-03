import { useEffect } from 'preact/hooks';
import { KeywordGraph } from "@/components/KeywordGraph";
import { KeywordList } from "@/components/KeywordList";
import { TripletCard } from "@/components/TripletCard";
import { loadAllKeywords, useDatabase } from '@/db/index';
import { embeddingsSignal, positions2dSignal, keywordsSignal } from '@/store/index';
import * as s from '@/styles/components.css';
import type { EmbeddingVector } from '@labby/core';
import { DIMS } from '@labby/core';

export function KeywordsPage() {
  const db = useDatabase();

  useEffect(() => {
    void loadAllKeywords(db).then(() => {
      const keywords = keywordsSignal.value;
      // Load 64-D embeddings and 2-D positions stored in keyword metadata.
      // Fall back to random initialisation for keywords that have no saved data.
      const newEmbeddings = new Map(embeddingsSignal.value);
      const newPositions = new Map(positions2dSignal.value);

      for (const kw of keywords) {
        const raw64 = kw.metadata?.embedding64;
        if (Array.isArray(raw64) && raw64.length === DIMS) {
          newEmbeddings.set(kw.id, new Float32Array(raw64 as number[]) as EmbeddingVector);
        } else if (!newEmbeddings.has(kw.id)) {
          // Random unit vector in DIMS-D space
          const v = new Float32Array(DIMS);
          let normSq = 0;
          for (let i = 0; i < DIMS; i++) {
            const x = Math.random() * 2 - 1;
            v[i] = x; normSq += x * x;
          }
          const norm = Math.sqrt(normSq) || 1e-8;
          for (let i = 0; i < DIMS; i++) v[i] /= norm;
          newEmbeddings.set(kw.id, v as EmbeddingVector);
        }

        const raw2d = kw.metadata?.position2d as { x?: number; y?: number } | undefined;
        if (raw2d && typeof raw2d.x === 'number' && typeof raw2d.y === 'number') {
          newPositions.set(kw.id, { x: raw2d.x, y: raw2d.y });
        } else if (!newPositions.has(kw.id)) {
          newPositions.set(kw.id, { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1 });
        }
      }

      embeddingsSignal.value = newEmbeddings;
      positions2dSignal.value = newPositions;
    });
  }, [db]);

  return (
    <div>
      <KeywordList />
      <KeywordGraph />
      <div class={s.sectionStack}>
        <TripletCard />
      </div>
    </div>
  );
}
