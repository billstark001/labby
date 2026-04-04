/** Keyword similarity graph rendered with deck.gl (WebGL). */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Deck, OrthographicView } from '@deck.gl/core';
import { LineLayer, ScatterplotLayer } from '@deck.gl/layers';
import { X } from 'lucide-preact';
import {
  keywordsSignal,
  keywordVectorsSignal,
} from '../store/index';
import { fallbackEntityId } from '@/i18n';
import { displayName } from '@/i18n';
import {
  keywordVectorsToSimilarityEdges,
} from '@labby/core';
import * as s from '../styles/components.css';
import { Button } from './ui/common';
import { i18n } from '@/i18n';
import clsx from 'clsx';

type GraphNode = {
  id: string;
  label: string;
  x: number;
  y: number;
};

type GraphEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  weight: number;
  source: [number, number, number];
  target: [number, number, number];
};

const COLOR_NODE: [number, number, number, number] = [44, 102, 245, 220];
const COLOR_NODE_SELECTED: [number, number, number, number] = [16, 185, 129, 240];
const COLOR_EDGE: [number, number, number, number] = [148, 163, 184, 120];
const COLOR_EDGE_SELECTED: [number, number, number, number] = [16, 185, 129, 200];
const POSITION_SCALE = 140;
const MAX_RENDER_EDGES = 8_000;

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function KeywordGraph() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<Deck<any> | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const { t } = i18n;
  const keywords = keywordsSignal.value;
  const vectors = keywordVectorsSignal.value;
  const edges = keywordVectorsToSimilarityEdges(vectors);

  const [selected, setSelected] = useState<string[]>([]);

  const nodes = useMemo<GraphNode[]>(() => {
    const vectorById = new Map(vectors.map((v) => [v.keywordId, v]));
    return keywords.map((keyword, index) => {
      const embedding = vectorById.get(keyword.id);
      if (embedding) {
        return {
          id: keyword.id,
          label: displayName(keyword),
          x: embedding.x * POSITION_SCALE,
          y: embedding.y * POSITION_SCALE,
        };
      }

      const angle = (index / Math.max(keywords.length, 1)) * Math.PI * 2;
      return {
        id: keyword.id,
        label: displayName(keyword),
        x: Math.cos(angle) * POSITION_SCALE * 0.2,
        y: Math.sin(angle) * POSITION_SCALE * 0.2,
      };
    });
  }, [keywords, vectors]);

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

  const graphEdges = useMemo<GraphEdge[]>(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const out: GraphEdge[] = [];
    for (const edge of edges) {
      if (edge.weight <= 0) continue;
      const sourceNode = nodeById.get(edge.sourceId);
      const targetNode = nodeById.get(edge.targetId);
      if (!sourceNode || !targetNode) continue;
      out.push({
        id: edgeKey(edge.sourceId, edge.targetId),
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        weight: edge.weight,
        source: [sourceNode.x, sourceNode.y, 0],
        target: [targetNode.x, targetNode.y, 0],
      });
    }
    if (out.length > MAX_RENDER_EDGES) {
      out.sort((a, b) => b.weight - a.weight);
      out.length = MAX_RENDER_EDGES;
    }
    return out;
  }, [edges, nodes]);

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
      controller: true,
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
      initialViewState: autoViewState as any,
    });
  }, [autoViewState, canvasSize.height, canvasSize.width]);

  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;

    const selectedSet = new Set(selected);
    const edgeIsSelected = (edge: GraphEdge): boolean => {
      if (selectedSet.size === 0) return false;
      return selectedSet.has(edge.sourceId) && selectedSet.has(edge.targetId);
    };

    deck.setProps({
      layers: [
        new LineLayer<GraphEdge>({
          id: 'keyword-edges',
          data: graphEdges,
          pickable: false,
          getSourcePosition: (d) => d.source,
          getTargetPosition: (d) => d.target,
          getColor: (d) => (edgeIsSelected(d) ? COLOR_EDGE_SELECTED : COLOR_EDGE),
          getWidth: (d) => Math.max(1, d.weight * 3),
          widthMinPixels: 1,
          widthMaxPixels: 4,
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
          getLineColor: [255, 255, 255, 220],
          getPosition: (d) => [d.x, d.y, 0],
          getRadius: (d) => (selectedSet.has(d.id) ? 11 : 8),
          getFillColor: (d) => (selectedSet.has(d.id) ? COLOR_NODE_SELECTED : COLOR_NODE),
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
      ],
    });
  }, [graphEdges, nodes, selected]);

  function clearSelection() {
    setSelected([]);
  }

  const relationshipRows = (() => {
    const selectedSet = new Set(selected);
    const rows = edges
      .map(edge => ({
        ...edge,
        distance: 1 - edge.weight,
      }))
      .filter(edge => {
        if (selectedSet.size === 0) return true;
        if (selectedSet.size === 1) {
          return selectedSet.has(edge.sourceId) || selectedSet.has(edge.targetId);
        }
        return selectedSet.has(edge.sourceId) && selectedSet.has(edge.targetId);
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 12)
      .map(edge => {
        const source = keywords.find(keyword => keyword.id === edge.sourceId);
        const target = keywords.find(keyword => keyword.id === edge.targetId);
        return {
          id: `${edge.sourceId}-${edge.targetId}`,
          label: `${source ? displayName(source) : fallbackEntityId(edge.sourceId)} ↔ ${target ? displayName(target) : fallbackEntityId(edge.targetId)}`,
          similarity: edge.weight,
          distance: edge.distance,
        };
      });

    return rows;
  })();

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
        {selected.length >= 2 && (
          <>
            <Button variant="ghost" onClick={clearSelection}>
              <X size={14} />
            </Button>
          </>
        )}
      </div>
      <div class={s.graphLayout}>
        <div ref={canvasRef} class={s.graphCanvas} />
        <aside class={s.graphSidebar}>
          <div class={`${s.card} ${s.graphSidebarCard}`} style={{ maxHeight: `${Math.max(canvasSize.height, 340)}px` }}>
            <h3 class={`${s.mb12} ${s.text16} ${s.fontBold}`}>{t('distanceSummary')}</h3>
            <div class={s.metricList}>
              {relationshipRows.length === 0 ? (
                <p class={s.mutedParagraph}>{t('noRelationshipData')}</p>
              ) : (
                relationshipRows.map(row => (
                  <div key={row.id} class={s.metricRow}>
                    <div>
                      <div>{row.label}</div>
                    </div>
                    <div class={s.metricValue}>
                      d={row.distance.toFixed(3)} / s={row.similarity.toFixed(3)}
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
