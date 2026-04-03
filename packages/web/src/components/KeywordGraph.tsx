/**
 * Keyword similarity graph rendered with PixiJS (WebGL).
 *
 * Node positions come directly from the 2-D embedding projection maintained
 * by the @labby/algorithm engine; there is no force simulation.  Edges are
 * computed from the k-nearest-neighbours of each node so the count is
 * O(N · k) rather than the old O(N²) pairwise approach.
 *
 * The canvas is zoomable and pannable via pointer drag and mouse-wheel.
 * Clicking a node selects or deselects it.
 */

import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import * as PIXI from 'pixi.js';
import { X } from 'lucide-preact';
import {
  keywordsSignal,
  embeddingsSignal,
  positions2dSignal,
  themeSignal,
} from '../store/index';

// ---------------------------------------------------------------------------
// Theme-aware colours (static lookup, avoids CSS-variable resolution issues)
// ---------------------------------------------------------------------------

const COLORS = {
  light: {
    node: 0x2563eb,
    nodeSelected: 0x7c3aed,
    edge: 0xe2e8f0,
    edgeSelected: 0x7c3aed,
    text: '#0f172a',
  },
  dark: {
    node: 0x3b82f6,
    nodeSelected: 0xa78bfa,
    edge: 0x334155,
    edgeSelected: 0xa78bfa,
    text: '#f1f5f9',
  },
} as const;
import { displayName } from '@/i18n';
import { useDatabase } from '../db/index';
import {
  attractKeywords,
  repelKeywords,
  getKNearest,
  computeSimilarity,
} from '@labby/core';
import * as s from '../styles/components.css';
import { Button } from './ui';
import { i18n } from '@/i18n';
import clsx from 'clsx';

/** Maximum number of nearest-neighbour edges shown per node. */
const K_EDGES = 5;

/** Scale factor: embedding [-1,1] → canvas pixels. */
const SCALE = 120;

/** Node visual radius in pixels. */
const NODE_R = 10;
const NODE_R_SEL = 14;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function KeywordGraph() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<PIXI.Application | null>(null);
  const viewportRef = useRef<PIXI.Container | null>(null);
  const nodeContainerRef = useRef<PIXI.Container | null>(null);
  const edgeGfxRef = useRef<PIXI.Graphics | null>(null);
  const labelContainerRef = useRef<PIXI.Container | null>(null);
  // Map keyword id → PIXI.Graphics circle
  const nodeGfxMapRef = useRef<Map<string, PIXI.Graphics>>(new Map());
  // Map keyword id → PIXI.Text label
  const labelMapRef = useRef<Map<string, PIXI.Text>>(new Map());

  const { t } = i18n;
  const keywords = keywordsSignal.value;
  const db = useDatabase();
  const [selected, setSelected] = useState<string[]>([]);

  // ------------------------------------------------------------------
  // Initialize PixiJS application
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!canvasRef.current) return;
    const app = new PIXI.Application();

    (async () => {
      await app.init({
        canvas: canvasRef.current!,
        resizeTo: canvasRef.current!.parentElement ?? canvasRef.current!,
        backgroundColor: 0x000000,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      });

      // Viewport container for pan/zoom
      const viewport = new PIXI.Container();
      app.stage.addChild(viewport);

      // Center initially
      viewport.x = app.screen.width / 2;
      viewport.y = app.screen.height / 2;

      const edgeGfx = new PIXI.Graphics();
      const nodeContainer = new PIXI.Container();
      const labelContainer = new PIXI.Container();
      viewport.addChild(edgeGfx);
      viewport.addChild(nodeContainer);
      viewport.addChild(labelContainer);

      appRef.current = app;
      viewportRef.current = viewport;
      nodeContainerRef.current = nodeContainer;
      edgeGfxRef.current = edgeGfx;
      labelContainerRef.current = labelContainer;

      // Pan / zoom interaction on the stage
      let isPanning = false;
      let panStart = { x: 0, y: 0 };
      let vpStart = { x: 0, y: 0 };

      app.stage.eventMode = 'static';
      app.stage.hitArea = app.screen;

      app.stage.on('pointerdown', (e: PIXI.FederatedPointerEvent) => {
        isPanning = true;
        panStart = { x: e.clientX, y: e.clientY };
        vpStart = { x: viewport.x, y: viewport.y };
      });
      app.stage.on('pointermove', (e: PIXI.FederatedPointerEvent) => {
        if (!isPanning) return;
        viewport.x = vpStart.x + e.clientX - panStart.x;
        viewport.y = vpStart.y + e.clientY - panStart.y;
      });
      app.stage.on('pointerup', () => { isPanning = false; });
      app.stage.on('pointerupoutside', () => { isPanning = false; });

      // Zoom on wheel
      canvasRef.current!.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const rect = canvasRef.current!.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const wx = (mx - viewport.x) / viewport.scale.x;
        const wy = (my - viewport.y) / viewport.scale.y;
        viewport.scale.x *= factor;
        viewport.scale.y *= factor;
        viewport.x = mx - wx * viewport.scale.x;
        viewport.y = my - wy * viewport.scale.y;
      }, { passive: false });
    })();

    return () => {
      app.destroy(false, { children: true });
      appRef.current = null;
      viewportRef.current = null;
      nodeContainerRef.current = null;
      edgeGfxRef.current = null;
      labelContainerRef.current = null;
      nodeGfxMapRef.current.clear();
      labelMapRef.current.clear();
    };
  }, []);

  // ------------------------------------------------------------------
  // Re-render nodes + edges when keywords or positions change
  // ------------------------------------------------------------------
  useEffect(() => {
    const app = appRef.current;
    const nodeContainer = nodeContainerRef.current;
    const edgeGfx = edgeGfxRef.current;
    const labelContainer = labelContainerRef.current;
    if (!app || !nodeContainer || !edgeGfx || !labelContainer) return;

    const positions = positions2dSignal.value;
    const embeddings = embeddingsSignal.value;
    const selectedSet = new Set(selected);
    const theme = themeSignal.value;
    const palette = COLORS[theme];

    const existingIds = new Set(nodeGfxMapRef.current.keys());
    const currentIds = new Set(keywords.map(k => k.id));

    // Remove nodes no longer present
    for (const id of existingIds) {
      if (!currentIds.has(id)) {
        const gfx = nodeGfxMapRef.current.get(id);
        if (gfx) nodeContainer.removeChild(gfx);
        nodeGfxMapRef.current.delete(id);
        const lbl = labelMapRef.current.get(id);
        if (lbl) labelContainer.removeChild(lbl);
        labelMapRef.current.delete(id);
      }
    }

    // Add or update nodes
    for (const kw of keywords) {
      const pos = positions.get(kw.id);
      const nx = (pos?.x ?? 0) * SCALE;
      const ny = (pos?.y ?? 0) * SCALE;
      const isSel = selectedSet.has(kw.id);
      const r = isSel ? NODE_R_SEL : NODE_R;

      let gfx = nodeGfxMapRef.current.get(kw.id);
      if (!gfx) {
        gfx = new PIXI.Graphics();
        gfx.eventMode = 'static';
        gfx.cursor = 'pointer';
        gfx.on('pointerdown', (e: PIXI.FederatedPointerEvent) => {
          e.stopPropagation();
          const id = kw.id;
          setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
        });
        nodeContainer.addChild(gfx);
        nodeGfxMapRef.current.set(kw.id, gfx);
      }
      gfx.clear();
      const col = isSel ? palette.nodeSelected : palette.node;
      gfx.circle(0, 0, r).fill(col);
      gfx.x = nx;
      gfx.y = ny;

      let lbl = labelMapRef.current.get(kw.id);
      if (!lbl) {
        lbl = new PIXI.Text({
          text: displayName(kw),
          style: { fontSize: 10, fill: palette.text, align: 'center' },
        });
        lbl.anchor.set(0.5, 0);
        lbl.eventMode = 'none';
        labelContainer.addChild(lbl);
        labelMapRef.current.set(kw.id, lbl);
      } else {
        lbl.text = displayName(kw);
      }
      lbl.x = nx;
      lbl.y = ny + r + 2;
    }

    // Draw edges (k-NN)
    edgeGfx.clear();
    const drawn = new Set<string>();
    for (const kw of keywords) {
      const vecA = embeddings.get(kw.id);
      if (!vecA) continue;
      const nn = getKNearest(embeddings, kw.id, K_EDGES);
      for (const nbId of nn) {
        const edgeKey = kw.id < nbId ? `${kw.id}|${nbId}` : `${nbId}|${kw.id}`;
        if (drawn.has(edgeKey)) continue;
        drawn.add(edgeKey);
        const vecB = embeddings.get(nbId);
        if (!vecB) continue;
        const sim = computeSimilarity(vecA, vecB);
        const posA = positions.get(kw.id);
        const posB = positions.get(nbId);
        if (!posA || !posB) continue;
        const alpha = 0.15 + sim * 0.5;
        const width = 0.5 + sim * 1.5;
        const bothSel = selectedSet.has(kw.id) && selectedSet.has(nbId);
        const anyOneSel = selectedSet.size > 0 && (selectedSet.has(kw.id) || selectedSet.has(nbId));
        const baseAlpha = selectedSet.size > 0 && !anyOneSel ? alpha * 0.2 : alpha;
        const col = bothSel ? palette.edgeSelected : palette.edge;
        edgeGfx
          .moveTo(posA.x * SCALE, posA.y * SCALE)
          .lineTo(posB.x * SCALE, posB.y * SCALE)
          .stroke({ color: col, alpha: baseAlpha, width });
      }
    }
  }, [keywords, positions2dSignal.value, embeddingsSignal.value, selected, themeSignal.value]);

  // ------------------------------------------------------------------
  // Cleanup selected when keywords change
  // ------------------------------------------------------------------
  useEffect(() => {
    const validIds = new Set(keywords.map(k => k.id));
    setSelected(prev => {
      const next = prev.filter(id => validIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [keywords]);

  // ------------------------------------------------------------------
  // Attract / repel
  // ------------------------------------------------------------------
  const handleAdjust = useCallback(async (mode: 'attract' | 'repel') => {
    if (selected.length < 2) return;
    const { embeddings: newEmb, positions: newPos } =
      mode === 'attract'
        ? attractKeywords(embeddingsSignal.value, positions2dSignal.value, selected)
        : repelKeywords(embeddingsSignal.value, positions2dSignal.value, selected);

    embeddingsSignal.value = newEmb;
    positions2dSignal.value = newPos;

    // Persist updated embeddings to DB (store in keyword metadata)
    for (const id of selected) {
      const kw = keywords.find(k => k.id === id);
      if (!kw) continue;
      const vec = newEmb.get(id);
      const pos = newPos.get(id);
      if (!vec || !pos) continue;
      const updated = {
        ...kw,
        metadata: {
          ...kw.metadata,
          embedding64: Array.from(vec),
          position2d: { x: pos.x, y: pos.y },
        },
      };
      await db.keywords.put(updated);
    }
    setSelected([]);
  }, [selected, keywords, db]);

  // ------------------------------------------------------------------
  // Sidebar: top relationships for selected nodes
  // ------------------------------------------------------------------
  const relationshipRows = (() => {
    const embeddings = embeddingsSignal.value;
    const positions = positions2dSignal.value;
    const selectedSet = new Set(selected);
    const rows: { id: string; label: string; similarity: number; distance: number }[] = [];

    if (keywords.length < 2) return rows;

    const pairs = new Set<string>();
    const candidates = selectedSet.size === 0
      ? keywords.slice(0, 20)
      : keywords.filter(k => selectedSet.has(k.id));

    for (const kw of candidates) {
      const vecA = embeddings.get(kw.id);
      if (!vecA) continue;
      const nn = getKNearest(embeddings, kw.id, K_EDGES);
      for (const nbId of nn) {
        if (selectedSet.size === 2 && (!selectedSet.has(kw.id) || !selectedSet.has(nbId))) continue;
        const pairKey = kw.id < nbId ? `${kw.id}|${nbId}` : `${nbId}|${kw.id}`;
        if (pairs.has(pairKey)) continue;
        pairs.add(pairKey);
        const vecB = embeddings.get(nbId);
        if (!vecB) continue;
        const sim = computeSimilarity(vecA, vecB);
        const kwB = keywords.find(k => k.id === nbId);
        rows.push({
          id: pairKey,
          label: `${displayName(kw)} ↔ ${kwB ? displayName(kwB) : nbId}`,
          similarity: sim,
          distance: 1 - sim,
        });
      }
    }
    rows.sort((a, b) => a.distance - b.distance);
    return rows.slice(0, 12);
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
            <Button variant="primary" onClick={() => handleAdjust('attract')}>
              {t('attractSelected')} ({selected.length})
            </Button>
            <Button variant="secondary" onClick={() => handleAdjust('repel')}>
              {t('repelSelected')}
            </Button>
            <Button variant="ghost" onClick={() => setSelected([])}>
              <X size={14} />
            </Button>
          </>
        )}
      </div>
      <div class={s.graphLayout}>
        <div class={s.graphCanvas} style={{ position: 'relative', overflow: 'hidden' }}>
          <canvas
            ref={canvasRef}
            style={{ display: 'block', width: '100%', height: '100%' }}
          />
        </div>
        <aside class={s.graphSidebar}>
          <div class={`${s.card} ${s.graphSidebarCard}`}>
            <h3 class={`${s.mb12} ${s.text16} ${s.fontBold}`}>{t('distanceSummary')}</h3>
            <div class={s.metricList}>
              {relationshipRows.length === 0 ? (
                <p class={s.mutedParagraph}>{t('noRelationshipData')}</p>
              ) : (
                relationshipRows.map(row => (
                  <div key={row.id} class={s.metricRow}>
                    <div><div>{row.label}</div></div>
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
