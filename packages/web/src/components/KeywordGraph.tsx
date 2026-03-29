/** Keyword similarity D3 force graph with brush-select interaction. */
import { useEffect, useRef, useState } from 'preact/hooks';
import * as d3 from 'd3';
import { X } from 'lucide-preact';
import {
  keywordsSignal,
  similarityEdgesSignal,
  embeddingsSignal,
} from '../store/index.js';
import { fallbackEntityId } from '@/i18n.js';
import { displayName } from '@/i18n.js';
import { db } from '../db/index.js';
import {
  attractKeywords,
  repelKeywords,
  embeddingsToSimilarities,
} from '@labby/core';
import type { SimilarityEdge } from '@labby/core';
import * as s from '../styles/components.css.js';
import { vars } from '../styles/theme.css.js';
import { Button } from './ui.js';
import { i18n } from '@/i18n.js';

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  weight: number;
}

export function KeywordGraph() {
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);
  const nodeSelectionRef = useRef<d3.Selection<any, GraphNode, SVGGElement, unknown> | null>(null);
  const linkSelectionRef = useRef<d3.Selection<any, GraphLink, SVGGElement, unknown> | null>(null);
  const labelSelectionRef = useRef<d3.Selection<any, GraphNode, SVGGElement, unknown> | null>(null);
  const { t } = i18n;
  const keywords = keywordsSignal.value;
  const edges = similarityEdgesSignal.value;
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const rect = svgRef.current.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 500;

    const nodes: GraphNode[] = keywords.map(kw => ({
      id: kw.id,
      label: displayName(kw),
      x: embeddingsSignal.value.get(kw.id)?.x !== undefined
        ? embeddingsSignal.value.get(kw.id)!.x * 120 + width / 2
        : undefined,
      y: embeddingsSignal.value.get(kw.id)?.y !== undefined
        ? embeddingsSignal.value.get(kw.id)!.y * 120 + height / 2
        : undefined,
    }));

    const links: GraphLink[] = edges
      .filter(e => e.weight > 0)
      .map(e => ({ source: e.sourceId, target: e.targetId, weight: e.weight }));

    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force(
        'link',
        d3
          .forceLink<GraphNode, GraphLink>(links)
          .id(d => d.id)
            .distance(d => 40 + (1 - d.weight) * 220),
      )
          .force('charge', d3.forceManyBody().strength(-110))
      .force('center', d3.forceCenter(width / 2, height / 2))
          .force('collision', d3.forceCollide(34));

    const g = svg.append('g');

    // Zoom
    svg.call(
      d3.zoom<SVGSVGElement, unknown>().on('zoom', e => {
        g.attr('transform', e.transform);
      }),
    );

    const link = g
      .append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', vars.color.border)
      .attr('stroke-width', d => d.weight * 3)
      .attr('stroke-opacity', d => 0.2 + d.weight * 0.5);

    const node = g
      .append('g')
      .selectAll<SVGCircleElement, GraphNode>('circle')
      .data(nodes)
      .join('circle')
      .attr('r', 14)
      .attr('fill', vars.color.primary)
      .attr('stroke', vars.color.surface)
      .attr('stroke-width', 2)
      .attr('cursor', 'pointer')
      .on('click', (_evt, d) => {
        setSelected(prev =>
          prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id],
        );
      });

    const label = g
      .append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .text(d => d.label)
      .attr('font-size', 11)
      .attr('text-anchor', 'middle')
      .attr('dy', 28)
      .attr('fill', vars.color.text)
      .attr('pointer-events', 'none');

    simulation.on('tick', () => {
      link
        .attr('x1', d => (d.source as GraphNode).x ?? 0)
        .attr('y1', d => (d.source as GraphNode).y ?? 0)
        .attr('x2', d => (d.target as GraphNode).x ?? 0)
        .attr('y2', d => (d.target as GraphNode).y ?? 0);
      node.attr('cx', d => d.x ?? 0).attr('cy', d => d.y ?? 0);
      label.attr('x', d => d.x ?? 0).attr('y', d => d.y ?? 0);
    });

    simulationRef.current = simulation;
    nodeSelectionRef.current = node;
    linkSelectionRef.current = link;
    labelSelectionRef.current = label;

    return () => simulation.stop();
  }, [keywords, edges, t('navGraph')]);

  useEffect(() => {
    const selectedSet = new Set(selected);
    nodeSelectionRef.current
      ?.attr('fill', (d: GraphNode) => (selectedSet.has(d.id) ? vars.color.accent : vars.color.primary))
      .attr('r', (d: GraphNode) => (selectedSet.has(d.id) ? 17 : 14));

    linkSelectionRef.current?.attr('stroke', (d: GraphLink) => {
      const source = typeof d.source === 'object' ? d.source.id : String(d.source);
      const target = typeof d.target === 'object' ? d.target.id : String(d.target);
      return selectedSet.size > 0 && selectedSet.has(source) && selectedSet.has(target)
        ? vars.color.accent
        : vars.color.border;
    });
  }, [selected]);

  async function handleAdjust(mode: 'attract' | 'repel') {
    if (selected.length < 2) return;
    const current = embeddingsSignal.value;
    const updated =
      mode === 'attract'
        ? attractKeywords(current, selected)
        : repelKeywords(current, selected);
    embeddingsSignal.value = updated;

    // Rebuild similarity edges from updated embeddings
    const simMap = embeddingsToSimilarities(updated);
    const newEdges: SimilarityEdge[] = [];
    await db.similarities.clear();
    for (const [key, weight] of simMap) {
      const [sourceId, targetId] = key.split('|');
      const edge: SimilarityEdge = { sourceId, targetId, weight };
      newEdges.push(edge);
      await db.similarities.put(edge);
    }
    similarityEdgesSignal.value = newEdges;
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
          <h2 class={s.sectionTitle}>{t('navGraph')}</h2>
          <p class={s.mutedParagraph}>
            {selected.length > 0
              ? `${selected.length} selected. Links and side metrics now reflect actual similarity distance.`
              : 'Select keywords to inspect pairwise distance and adjust the embedding without rebuilding the graph.'}
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
        <svg ref={svgRef} class={s.graphCanvas} />
        <aside class={s.graphSidebar}>
          <div class={`${s.card} ${s.graphSidebarCard}`}>
            <h3 class={`${s.mb12} ${s.text16} ${s.fontBold}`}>Distance Summary</h3>
            <div class={s.metricList}>
              {relationshipRows.length === 0 ? (
                <p class={s.mutedParagraph}>No relationship data yet.</p>
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
