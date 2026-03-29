/** Keyword similarity D3 force graph with brush-select interaction. */
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as d3 from 'd3';
import {
  keywordsSignal,
  similarityEdgesSignal,
  embeddingsSignal,
  t,
  displayName,
} from '../store/index.js';
import { db } from '../db/index.js';
import {
  attractKeywords,
  repelKeywords,
  embeddingsToSimilarities,
} from '@labby/core';
import type { SimilarityEdge } from '@labby/core';
import * as s from '../styles/components.css.js';
import { Button } from './ui.js';

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  weight: number;
}

export function KeywordGraph() {
  const svgRef = useRef<SVGSVGElement>(null);
  const strings = t.value;
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
    }));

    const links: GraphLink[] = edges
      .filter(e => e.weight > 0.4)
      .map(e => ({ source: e.sourceId, target: e.targetId, weight: e.weight }));

    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force(
        'link',
        d3
          .forceLink<GraphNode, GraphLink>(links)
          .id(d => d.id)
          .distance(d => (1 - d.weight) * 200),
      )
      .force('charge', d3.forceManyBody().strength(-80))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide(30));

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
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', d => d.weight * 3)
      .attr('stroke-opacity', 0.6);

    const node = g
      .append('g')
      .selectAll<SVGCircleElement, GraphNode>('circle')
      .data(nodes)
      .join('circle')
      .attr('r', 14)
      .attr('fill', d =>
        selected.includes(d.id) ? '#7c3aed' : '#2563eb',
      )
      .attr('stroke', '#fff')
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
      .attr('dy', '0.35em')
      .attr('fill', '#fff')
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

    return () => simulation.stop();
  }, [keywords, edges, selected]);

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

  return (
    <div>
      <div class={s.toolbar}>
        <h2 class={s.sectionTitle}>{strings.navGraph}</h2>
        {selected.length >= 2 && (
          <>
            <Button variant="primary" onClick={() => handleAdjust('attract')}>
              {strings.attractSelected} ({selected.length})
            </Button>
            <Button variant="secondary" onClick={() => handleAdjust('repel')}>
              {strings.repelSelected}
            </Button>
            <Button variant="ghost" onClick={() => setSelected([])}>
              ✕
            </Button>
          </>
        )}
      </div>
      <svg ref={svgRef} class={s.graphCanvas} />
    </div>
  );
}
