import { KeywordGraph } from "@/components/KeywordGraph";
import { KeywordList } from "@/components/KeywordList";
import { TripletCard } from "@/components/TripletCard";
import * as s from '@/styles/components.css.js';

export function KeywordsPage() {
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