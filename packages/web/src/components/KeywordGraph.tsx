import { graphData, graphReady, graphStreamStatus, syncGraph } from '@/lib/graph-sync';
import type { Keyword } from '@labby/core';
import { KeywordForm } from './KeywordForm';
import { Dialog } from './ui/Dialog';
import { toast } from './ui/Toast';
import { useDatabase } from '@/db/index';
/** Keyword similarity graph rendered with deck.gl (WebGL). */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Deck, OrthographicView } from '@deck.gl/core';
import { LineLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { X } from 'lucide-preact';
import {
  themeSignal,
} from '../store/index';
import { fallbackEntityId } from '@/i18n';
import { displayName } from '@/i18n';
import * as s from '../styles/components.css';
import { Button } from './ui/common';
import { i18n } from '@/i18n';
import clsx from 'clsx';
import { productDistance, rankingQueryKey } from '@labby/core';
import { RankingEditor } from './RankingCard';

type GraphNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  disabled: boolean;
};

type GraphLine = { source: GraphNode; target: GraphNode; weight: number };

const COLOR_NODE: [number, number, number, number] = [44, 102, 245, 220];
const COLOR_NODE_SELECTED: [number, number, number, number] = [16, 185, 129, 240];
const COLOR_NODE_DISABLED: [number, number, number, number] = [148, 163, 184, 180];
const COLOR_NODE_HALO: [number, number, number, number] = [16, 185, 129, 96];
const POSITION_SCALE = 140;
const POINT_TRANSITION_MS = 280;

function stableHash01(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
}

function spreadPoint(x: number, y: number, medianRadius: number, p90Radius: number): [number, number] {
  const r = Math.hypot(x, y);
  if (r < 1e-6) return [x, y];
  const inner = Math.max(8, medianRadius * 0.65);
  const outer = Math.max(inner + 16, p90Radius * 1.8);
  const targetR = r < inner
    ? inner * Math.pow(r / inner, 0.75)
    : r > outer
      ? outer + (r - outer) * 0.35
      : r;
  const factor = targetR / r;
  return [x * factor, y * factor];
}

function GraphLoadingStatus() {
  const db = useDatabase();
  const streamStatus = graphStreamStatus.value;
  const [refreshing, setRefreshing] = useState(false);
  const { t } = i18n;
  return <div style={{minHeight:'3em'}}>
    <p role="status" aria-live="polite" class={s.mutedParagraph}>
      {streamStatus.loading ? t('graphLoading', String(streamStatus.count)) : refreshing ? t('graphSyncing') : t('graphUpToDate')}
    </p>
    {streamStatus.error && <Button variant="secondary" title={streamStatus.error} busy={refreshing} onClick={() => { setRefreshing(true); void syncGraph(db).catch(() => {}).finally(() => setRefreshing(false)); }}>{t('graphLoadFailed')}</Button>}
    <Button variant="ghost" busy={refreshing} disabled={refreshing || streamStatus.loading} onClick={async () => {
      setRefreshing(true);
      try { await syncGraph(db); } catch { /* Stream status exposes the error. */ }
      finally { setRefreshing(false); }
    }}>{t('graphRefresh')}</Button>
  </div>;
}

export function KeywordGraph() {
  const db = useDatabase();
  const ready = graphReady.value;
  const fitted = useRef(false);
  const [editing, setEditing] = useState<Keyword | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<Deck<any> | null>(null);
  const transitionRef = useRef<number | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const { t } = i18n;
  const theme = themeSignal.value;
  const { keywords, vectors, edges: graphEdges } = graphData.value;
  const locale = i18n.lang.value;

  const [selected, setSelected] = useState<string[]>([]);
  const [animatedPositions, setAnimatedPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const animatedPositionsRef = useRef(animatedPositions);

  useEffect(() => {
    animatedPositionsRef.current = animatedPositions;
  }, [animatedPositions]);

  useEffect(() => {
    const target = new Map(vectors.map((v) => [v.keywordId, { x: v.x, y: v.y }]));
    const from = animatedPositionsRef.current;

    if (transitionRef.current !== null) {
      cancelAnimationFrame(transitionRef.current);
      transitionRef.current = null;
    }

    if (from.size === target.size && [...target].every(([id, point]) => {
      const previous = from.get(id);
      return previous?.x === point.x && previous?.y === point.y;
    })) return;

    if (from.size === 0) {
      animatedPositionsRef.current = target;
      setAnimatedPositions(target);
      return;
    }

    const start = performance.now();
    const ease = (t0: number) => 1 - Math.pow(1 - t0, 3);

    const step = (now: number) => {
      const raw = Math.min(1, (now - start) / POINT_TRANSITION_MS);
      const t0 = ease(raw);
      const next = new Map<string, { x: number; y: number }>();
      for (const [id, to] of target) {
        const src = from.get(id) ?? to;
        next.set(id, {
          x: src.x + (to.x - src.x) * t0,
          y: src.y + (to.y - src.y) * t0,
        });
      }
      animatedPositionsRef.current = next;
      setAnimatedPositions(next);

      if (raw < 1) {
        transitionRef.current = requestAnimationFrame(step);
      } else {
        transitionRef.current = null;
      }
    };

    transitionRef.current = requestAnimationFrame(step);
    return () => {
      if (transitionRef.current !== null) cancelAnimationFrame(transitionRef.current);
      transitionRef.current = null;
    };
  }, [vectors]);

  useEffect(() => {
    return () => {
      if (transitionRef.current !== null) {
        cancelAnimationFrame(transitionRef.current);
      }
    };
  }, []);

  const nodes = useMemo<GraphNode[]>(() => {
    const vectorById = new Map(vectors.map((v) => [v.keywordId, v]));
    const raw = keywords.map((keyword, index) => {
      const embedding = vectorById.get(keyword.id);
      const animated = animatedPositions.get(keyword.id);
      if (embedding) {
        const x = (animated?.x ?? embedding.x) * POSITION_SCALE;
        const y = (animated?.y ?? embedding.y) * POSITION_SCALE;
        return {
          id: keyword.id,
          label: displayName(keyword),
          x,
          y,
          disabled: Boolean(keyword.disabled),
        };
      }

      const angle = (index / Math.max(keywords.length, 1)) * Math.PI * 2;
      return {
        id: keyword.id,
        label: displayName(keyword),
        x: Math.cos(angle) * POSITION_SCALE * 0.2,
        y: Math.sin(angle) * POSITION_SCALE * 0.2,
        disabled: Boolean(keyword.disabled),
      };
    });

    const radii = raw.map((item) => Math.hypot(item.x, item.y)).sort((a, b) => a - b);
    if (radii.length === 0) return raw;
    const median = radii[Math.floor(radii.length / 2)] ?? 0;
    const p90 = radii[Math.floor(radii.length * 0.9)] ?? median;

    return raw.map((item) => {
      const [sx, sy] = spreadPoint(item.x, item.y, median, p90);
      const jitter = (stableHash01(item.id) - 0.5) * 4;
      return {
        ...item,
        x: sx + jitter,
        y: sy - jitter * 0.6,
      };
    });
  }, [animatedPositions, keywords, vectors, locale]);

  const lines = useMemo<GraphLine[]>(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return graphEdges.flatMap((edge) => {
      const source = nodeById.get(edge.sourceId);
      const target = nodeById.get(edge.targetId);
      return source && target ? [{ source, target, weight: edge.weight }] : [];
    });
  }, [graphEdges, nodes]);

  const vectorById = useMemo(() => new Map(vectors.map((v) => [v.keywordId, v])), [vectors]);
  const selectedPairMetrics = useMemo(() => {
    if (selected.length !== 2) return null;
    const [leftId, rightId] = selected;
    if (!leftId || !rightId) return null;
    const left = vectorById.get(leftId);
    const right = vectorById.get(rightId);
    if (!left || !right) return null;
    const distance = productDistance(left, right);
    const similarity = 1 / (1 + distance);
    return { distance, similarity, leftId, rightId };
  }, [selected, vectorById]);

  const autoViewState = useMemo(() => {
    const width = Math.max(1, canvasSize.width);
    const height = Math.max(1, canvasSize.height);
    if (nodes.length === 0) {
      return { target: [0, 0, 0], zoom: 0 };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      if (node.x < minX) minX = node.x;
      if (node.y < minY) minY = node.y;
      if (node.x > maxX) maxX = node.x;
      if (node.y > maxY) maxY = node.y;
    }

    const pad = 48;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const scaleX = Math.max(0.05, (width - pad * 2) / spanX);
    const scaleY = Math.max(0.05, (height - pad * 2) / spanY);
    const zoom = Math.max(-6, Math.min(6, Math.log2(Math.min(scaleX, scaleY))));

    return {
      target: [(minX + maxX) / 2, (minY + maxY) / 2, 0] as [number, number, number],
      zoom,
    };
  }, [canvasSize.height, canvasSize.width, nodes]);

  useEffect(() => {
    const validIds = new Set(keywords.map(keyword => keyword.id));
    setSelected(prev => {
      const next = prev.filter(id => validIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [keywords]);

  useEffect(() => {
    if (!canvasRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextWidth = Math.round(entry.contentRect.width);
      const nextHeight = Math.round(entry.contentRect.height);
      setCanvasSize((prev) => (
        prev.width === nextWidth && prev.height === nextHeight
          ? prev
          : { width: nextWidth, height: nextHeight }
      ));
    });
    observer.observe(canvasRef.current);

    const deck = new Deck<any>({
      parent: canvasRef.current,
      views: [new OrthographicView({ id: 'graph-view' })],
      initialViewState: autoViewState as any,
      controller: { doubleClickZoom: false },
      getCursor: ({ isDragging }) => (isDragging ? 'grabbing' : 'grab'),
    });

    deckRef.current = deck;
    return () => {
      observer.disconnect();
      deck.finalize();
      deckRef.current = null;
    };
  }, []);

  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;

    deck.setProps({
      width: canvasSize.width || 1,
      height: canvasSize.height || 1,
    });
  }, [canvasSize.height, canvasSize.width]);

  useEffect(() => {
    if (fitted.current || !ready || !nodes.length || !canvasSize.width || !canvasSize.height) return;
    fitted.current = true;
    deckRef.current?.setProps({ initialViewState: autoViewState as any });
  }, [ready, nodes.length, canvasSize.width, canvasSize.height, autoViewState]);

  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;

    const selectedSet = new Set(selected);
    const selectionVersion = selected.join('|');
    const textColor: [number, number, number, number] = theme === 'dark'
      ? [241, 245, 249, 235]
      : [15, 23, 42, 220];

    deck.setProps({
      layers: [
        new LineLayer<GraphLine>({
          id: 'keyword-edges',
          data: lines,
          pickable: false,
          getSourcePosition: (edge) => [edge.source.x, edge.source.y, 0],
          getTargetPosition: (edge) => [edge.target.x, edge.target.y, 0],
          getColor: theme === 'dark' ? [100, 116, 139, 90] : [71, 85, 105, 75],
          getWidth: (edge) => 0.5 + edge.weight * 1.5,
          widthUnits: 'pixels',
        }),
        new ScatterplotLayer<GraphNode>({
          id: 'keyword-node-halo',
          data: nodes.filter((node) => selectedSet.has(node.id)),
          pickable: false,
          radiusUnits: 'pixels',
          stroked: true,
          filled: true,
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 2,
          getLineColor: [16, 185, 129, 200],
          getPosition: (d) => [d.x, d.y, 0],
          getRadius: 18,
          getFillColor: COLOR_NODE_HALO,
        }),
        new ScatterplotLayer<GraphNode>({
          id: 'keyword-nodes',
          data: nodes,
          pickable: true,
          radiusUnits: 'pixels',
          stroked: true,
          filled: true,
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1,
          getLineColor: (d) => (selectedSet.has(d.id) ? [16, 185, 129, 255] : [255, 255, 255, 210]),
          getPosition: (d) => [d.x, d.y, 0],
          getRadius: (d) => (selectedSet.has(d.id) ? 13 : 7),
          getFillColor: (d) => (d.disabled ? COLOR_NODE_DISABLED : selectedSet.has(d.id) ? COLOR_NODE_SELECTED : COLOR_NODE),
          updateTriggers: {
            getLineColor: selectionVersion,
            getRadius: selectionVersion,
            getFillColor: selectionVersion,
          },
          onClick: (info) => {
            const picked = info.object as GraphNode | undefined;
            if (!picked) return;
            setSelected((prev) => (
              prev.includes(picked.id)
                ? prev.filter((id) => id !== picked.id)
                : [...prev, picked.id]
            ));
          },
        }),
        new TextLayer<GraphNode>({
          id: 'keyword-labels',
          data: nodes,
          pickable: false,
          getText: (d) => d.label,
          getPosition: (d) => [d.x, d.y, 0],
          getSize: (d) => (selectedSet.has(d.id) ? 15 : 13),
          getColor: (d) => (d.disabled ? [148, 163, 184, 210] : selectedSet.has(d.id) ? [16, 185, 129, 255] : textColor),
          updateTriggers: {
            getColor: `${theme}|${selectionVersion}`,
            getSize: selectionVersion,
          },
          getPixelOffset: [0, 10],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          sizeUnits: 'pixels',
          sizeMinPixels: 12,
          sizeMaxPixels: 18,
          characterSet: 'auto',
          fontFamily: 'Noto Sans CJK SC, Noto Sans CJK JP, PingFang SC, Hiragino Sans GB, Hiragino Sans, Microsoft YaHei, sans-serif',
          fontSettings: {
            sdf: false,
            fontSize: 64,
            buffer: 6,
            radius: 12,
          },
        }),
      ],
    });
  }, [lines, nodes, selected, theme]);

  function clearSelection() {
    setSelected([]);
  }

  const selectedLabels = selected
    .map((id) => {
      const keyword = keywords.find((item) => item.id === id);
      return keyword ? displayName(keyword) : fallbackEntityId(id);
    });

  return (
    <div>
      <div class={s.toolbar}>
        <div class={s.toolbarTitleGroup}>
          <h2 class={clsx(s.sectionTitle, s.mt16)}>{t('navGraph')}</h2>
          <p class={s.mutedParagraph}>
            {selected.length > 0
              ? t('graphSelected', String(selected.length))
              : t('graphHint')}
          </p>
        </div>
        {selected.length > 0 && (
          <>
            <Button variant="ghost" onClick={clearSelection}>
              <X size={14} />
            </Button>
          </>
        )}
      </div>
      {editing && <Dialog open onClose={() => setEditing(null)} title={t('edit')} closeOnOverlayClick={false}>
        <KeywordForm initial={editing} onCancel={() => setEditing(null)} onSave={async keyword => {
          try {
            await db.keywords.put(keyword);
            setEditing(null);
            await syncGraph(db);
          } catch (error) { toast.error(String(error)); throw error; }
        }} />
      </Dialog>}
      <div class={s.graphLayout}>
        <div ref={canvasRef} class={s.graphCanvas} onDblClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          const picked = deckRef.current?.pickObject({x:event.clientX-rect.left,y:event.clientY-rect.top,radius:6});
          const keyword = keywords.find(keyword => keyword.id === picked?.object?.id);
          if (keyword) setEditing(keyword);
        }} />
        <aside class={s.graphSidebar}>
          <div class={s.card}>
            <GraphLoadingStatus />
            <Button variant="ghost" onClick={() => deckRef.current?.setProps({initialViewState:autoViewState as any})}>{t('graphFitView')}</Button>
            <h3 class={`${s.mb12} ${s.text16} ${s.fontBold}`}>Projection</h3>
            <p class={s.mutedParagraph}>
              {t('rankingProjectionHint')}
            </p>
            <p class={`${s.mt8} ${s.text12} ${s.textMuted}`}>
              Nodes: {nodes.length}
            </p>
            {selectedPairMetrics && (
              <p class={`${s.mt8} ${s.text12} ${s.textMuted}`}>
                Current relative distance: {selectedPairMetrics.distance.toFixed(3)} (similarity {selectedPairMetrics.similarity.toFixed(3)})
              </p>
            )}
            {selected.length >= 3 && selected.length <= 13 && <RankingEditor
              key={selected.join('|')}
              query={{anchorId: selected[0]!, candidateIds: selected.slice(1), key: rankingQueryKey(selected[0]!,selected.slice(1))}}
            />}
            <p class={s.mutedParagraph}>{t('rankingGraphHint')}</p>
          </div>
          <div class={`${s.card} ${s.graphSidebarCard}`} style={{ maxHeight: `${Math.max(canvasSize.height, 340)}px` }}>
            <h3 class={`${s.mb12} ${s.text16} ${s.fontBold}`}>Selected Keywords</h3>
            <div class={s.metricList}>
              {selectedLabels.length === 0 ? (
                <p class={s.mutedParagraph}>Click points to inspect selected keywords.</p>
              ) : (
                selectedLabels.map((label, index) => (
                  <div key={selected[index]} class={s.metricRow}>
                    <div>
                      <div>{label}</div>
                      <Button variant="ghost" onClick={() => setEditing(keywords.find(keyword => keyword.id === selected[index]) ?? null)}>{t('edit')}</Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
