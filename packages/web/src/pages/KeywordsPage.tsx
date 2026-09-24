import { useEffect, useState } from 'preact/hooks';
import { KeywordGraph } from '@/components/KeywordGraph';
import { KeywordList } from '@/components/KeywordList';
import { RankingCard } from '@/components/RankingCard';
import { Button } from '@/components/ui';
import { useDatabase } from '@/db/index';
import { graphReady, graphStream, graphStreamStatus } from '@/lib/graph-sync';
import { i18n } from '@/i18n';
import * as s from '@/styles/components.css';

function GraphTab() {
  const db = useDatabase();
  useEffect(() => graphStream(db).start(), [db]);
  return (
    <>
      <KeywordGraph />
      <div class={s.sectionStack}>
        {graphReady.value && !graphStreamStatus.value.error && <RankingCard />}
      </div>
    </>
  );
}

export function KeywordsPage() {
  const [tab, setTab] = useState<'list' | 'graph'>('list');
  const { t } = i18n;
  return (
    <div>
      <div class={s.toolbar} role="tablist" aria-label={t('navKeywords')}>
        <div class={s.flexGapSm}>
          <Button
            role="tab"
            id="keywords-list-tab"
            aria-controls="keywords-list-panel"
            aria-selected={tab === 'list'}
            variant={tab === 'list' ? 'primary' : 'ghost'}
            onClick={() => setTab('list')}
          >
            {t('navKeywords')}
          </Button>
          <Button
            role="tab"
            id="keywords-graph-tab"
            aria-controls="keywords-graph-panel"
            aria-selected={tab === 'graph'}
            variant={tab === 'graph' ? 'primary' : 'ghost'}
            onClick={() => setTab('graph')}
          >
            {t('navGraph')}
          </Button>
        </div>
      </div>
      {tab === 'list' ? (
        <div role="tabpanel" id="keywords-list-panel" aria-labelledby="keywords-list-tab">
          <KeywordList />
        </div>
      ) : (
        <div role="tabpanel" id="keywords-graph-panel" aria-labelledby="keywords-graph-tab">
          <GraphTab />
        </div>
      )}
    </div>
  );
}
