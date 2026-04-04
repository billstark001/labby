/** Keyword similarity graph rendered with deck.gl (WebGL). */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Deck, OrthographicView } from '@deck.gl/core';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { X } from 'lucide-preact';
import {
  keywordsSignal,
  keywordVectorsSignal,
  themeSignal,
} from '../store/index';
import { fallbackEntityId } from '@/i18n';
import { displayName } from '@/i18n';
import * as s from '../styles/components.css';
import { Button } from './ui/common';
import { i18n } from '@/i18n';
import clsx from 'clsx';
import { useDatabase } from '@/db/index';
import { applySupervision } from '@/lib/embedding-engine';
import { isServerDeployment } from '@/lib/runtime';

type GraphNode = {
  id: string;
  label: string;
  x: number;
  y: number;
};

const COLOR_NODE: [number, number, number, number] = [44, 102, 245, 220];
const COLOR_NODE_SELECTED: [number, number, number, number] = [16, 185, 129, 240];
const COLOR_NODE_HALO: [number, number, number, number] = [16, 185, 129, 96];
const POSITION_SCALE = 140;
const POINT_TRANSITION_MS = 280;

function l2Distance64(a: readonly number[], b: readonly number[]): number {
  const dim = Math.min(a.length, b.length, 64);
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

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

export function KeywordGraph() {
  const db = useDatabase();
  const canvasRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<Deck<any> | null>(null);
  const transitionRef = useRef<number | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const { t } = i18n;
  const theme = themeSignal.value;
  const keywords = keywordsSignal.value;
  const vectors = keywordVectorsSignal.value;

  const [selected, setSelected] = useState<string[]>([]);
  const [targetDistanceInput, setTargetDistanceInput] = useState('0.45');
  const [learningRateInput, setLearningRateInput] = useState('0.05');
  const [marginInput, setMarginInput] = useState('0.2');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [supervisionFeedback, setSupervisionFeedback] = useState('');
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

    if (from.size === 0) {
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
      setAnimatedPositions(next);

      if (raw < 1) {
        transitionRef.current = requestAnimationFrame(step);
      } else {
        transitionRef.current = null;
      }
    };

    transitionRef.current = requestAnimationFrame(step);
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
  }, [animatedPositions, keywords, vectors]);

  const vectorById = useMemo(() => new Map(vectors.map((v) => [v.keywordId, v])), [vectors]);
  const selectedPairMetrics = useMemo(() => {
    if (selected.length !== 2) return null;
    const [leftId, rightId] = selected;
    if (!leftId || !rightId) return null;
    const left = vectorById.get(leftId);
    const right = vectorById.get(rightId);
    if (!left || !right) return null;
    const distance = l2Distance64(left.vector64, right.vector64);
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
    const selectionVersion = selected.join('|');
    const textColor: [number, number, number, number] = theme === 'dark'
      ? [241, 245, 249, 235]
      : [15, 23, 42, 220];

    deck.setProps({
      layers: [
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
          getFillColor: (d) => (selectedSet.has(d.id) ? COLOR_NODE_SELECTED : COLOR_NODE),
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
          getColor: (d) => (selectedSet.has(d.id) ? [16, 185, 129, 255] : textColor),
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
  }, [nodes, selected, theme]);

  function clearSelection() {
    setSelected([]);
  }

  async function applyPairSupervision(): Promise<void> {
    if (selected.length !== 2 || isSubmitting) return;
    const [leftId, rightId] = selected;
    if (!leftId || !rightId) return;

    const targetDistance = Number.parseFloat(targetDistanceInput);
    const learningRate = Number.parseFloat(learningRateInput);
    if (!Number.isFinite(targetDistance) || targetDistance < 0) {
      setSupervisionFeedback('Invalid target distance.');
      return;
    }
    if (!Number.isFinite(learningRate) || learningRate <= 0) {
      setSupervisionFeedback('Invalid learning rate.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await applySupervision(keywordVectorsSignal.value, {
        kind: 'pair',
        leftId,
        rightId,
        targetDistance,
        learningRate,
      });

      if (result.updatedVectors.length > 0) {
        const merged = new Map(keywordVectorsSignal.value.map(v => [v.keywordId, v]));
        for (const vec of result.updatedVectors) {
          merged.set(vec.keywordId, vec);
        }
        keywordVectorsSignal.value = [...merged.values()];
        if (!isServerDeployment) {
          await db.keywordVectors.putMany(result.updatedVectors);
        }
      }

      setSupervisionFeedback(
        `Pair supervision applied (${result.updatedVectors.length} vectors updated).`,
      );
    } catch (error) {
      setSupervisionFeedback(error instanceof Error ? error.message : 'Pair supervision failed.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function applyRankedSupervision(): Promise<void> {
    if (selected.length < 3 || isSubmitting) return;
    const [anchorId, ...orderedIds] = selected;
    if (!anchorId || orderedIds.length < 2) {
      setSupervisionFeedback('Select one anchor and at least two ordered nodes.');
      return;
    }

    const learningRate = Number.parseFloat(learningRateInput);
    const margin = Number.parseFloat(marginInput);
    if (!Number.isFinite(learningRate) || learningRate <= 0) {
      setSupervisionFeedback('Invalid learning rate.');
      return;
    }
    if (!Number.isFinite(margin) || margin <= 0) {
      setSupervisionFeedback('Invalid margin.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await applySupervision(keywordVectorsSignal.value, {
        kind: 'ranked',
        anchorId,
        orderedIds,
        margin,
        learningRate,
      });

      if (result.updatedVectors.length > 0) {
        const merged = new Map(keywordVectorsSignal.value.map(v => [v.keywordId, v]));
        for (const vec of result.updatedVectors) {
          merged.set(vec.keywordId, vec);
        }
        keywordVectorsSignal.value = [...merged.values()];
        if (!isServerDeployment) {
          await db.keywordVectors.putMany(result.updatedVectors);
        }
      }

      setSupervisionFeedback(
        `Ranked supervision applied (${result.updatedVectors.length} vectors updated).`,
      );
    } catch (error) {
      setSupervisionFeedback(error instanceof Error ? error.message : 'Ranked supervision failed.');
    } finally {
      setIsSubmitting(false);
    }
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
      <div class={s.graphLayout}>
        <div ref={canvasRef} class={s.graphCanvas} />
        <aside class={s.graphSidebar}>
          <div class={s.card}>
            <h3 class={`${s.mb12} ${s.text16} ${s.fontBold}`}>Projection</h3>
            <p class={s.mutedParagraph}>
              This view renders only projected points from the dimensionality-reduction module.
            </p>
            <p class={`${s.mt8} ${s.text12} ${s.textMuted}`}>
              Nodes: {nodes.length}
            </p>
            {selectedPairMetrics && (
              <p class={`${s.mt8} ${s.text12} ${s.textMuted}`}>
                Current relative distance: {selectedPairMetrics.distance.toFixed(3)} (similarity {selectedPairMetrics.similarity.toFixed(3)})
              </p>
            )}
            <div class={s.formGroup}>
              <label class={s.label} htmlFor="target-distance-input">Target relative distance</label>
              <input
                id="target-distance-input"
                class={s.input}
                value={targetDistanceInput}
                onInput={(event) => setTargetDistanceInput((event.target as HTMLInputElement).value)}
              />
            </div>
            <div class={s.formGroup}>
              <label class={s.label} htmlFor="learning-rate-input">Learning rate</label>
              <input
                id="learning-rate-input"
                class={s.input}
                value={learningRateInput}
                onInput={(event) => setLearningRateInput((event.target as HTMLInputElement).value)}
              />
            </div>
            <div class={s.formGroup}>
              <label class={s.label} htmlFor="margin-input">Margin (ranked)</label>
              <input
                id="margin-input"
                class={s.input}
                value={marginInput}
                onInput={(event) => setMarginInput((event.target as HTMLInputElement).value)}
              />
            </div>
            <div class={s.flexGapSm}>
              <Button
                variant="secondary"
                onClick={() => void applyPairSupervision()}
                disabled={isSubmitting || selected.length !== 2}
              >
                Apply Pair Supervision
              </Button>
              <Button
                variant="primary"
                onClick={() => void applyRankedSupervision()}
                disabled={isSubmitting || selected.length < 3}
              >
                Apply Ranked Supervision
              </Button>
              <Button
                variant="ghost"
                onClick={clearSelection}
                disabled={isSubmitting || selected.length === 0}
              >
                Clear Selection
              </Button>
            </div>
            {selectedLabels.length > 0 && (
              <p class={`${s.mt8} ${s.text12} ${s.textMuted}`}>
                Selected: {selectedLabels.join(' | ')}
              </p>
            )}
            {selected.length >= 3 && (
              <p class={`${s.mt8} ${s.text12} ${s.textMuted}`}>
                Ranked order: {selectedLabels.join(' → ')}
              </p>
            )}
            {supervisionFeedback && (
              <p class={`${s.mt8} ${s.text12} ${s.textMuted}`}>{supervisionFeedback}</p>
            )}
          </div>
          <div class={`${s.card} ${s.graphSidebarCard}`} style={{ maxHeight: `${Math.max(canvasSize.height, 340)}px` }}>
            <h3 class={`${s.mb12} ${s.text16} ${s.fontBold}`}>Selected Keywords</h3>
            <div class={s.metricList}>
              {selectedLabels.length === 0 ? (
                <p class={s.mutedParagraph}>Click points to inspect selected keywords.</p>
              ) : (
                selectedLabels.map((label) => (
                  <div key={label} class={s.metricRow}>
                    <div>
                      <div>{label}</div>
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
