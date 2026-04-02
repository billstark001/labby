/** Keyword similarity D3 force graph with brush-select interaction. */
import { useEffect, useRef, useState } from 'preact/hooks';
import * as d3 from 'd3';
import { X } from 'lucide-preact';
import {
  keywordsSignal,
  similarityEdgesSignal,
  embeddingsSignal,
} from '../store/index';
import { fallbackEntityId } from '@/i18n';
import { displayName } from '@/i18n';
import { useDatabase } from '../db/index';
import {
  attractKeywords,
  repelKeywords,
  embeddingsToSimilarities,
} from '@labby/core';
import type { SimilarityEdge } from '@labby/core';
import * as s from '../styles/components.css';
import { vars } from '../styles/theme.css';
import { Button } from './ui';
import { i18n } from '@/i18n';
import clsx from 'clsx';

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  weight: number;
}

function linkKey(link: GraphLink): string {
  const source = typeof link.source === 'object' ? link.source.id : String(link.source);
  const target = typeof link.target === 'object' ? link.target.id : String(link.target);
  return source < target ? `${source}|${target}` : `${target}|${source}`;
}

export function KeywordGraph() {
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);
  const graphGroupRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const linkLayerRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodeLayerRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const labelLayerRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodeSelectionRef = useRef<d3.Selection<SVGCircleElement, GraphNode, SVGGElement, unknown> | null>(null);
  const linkSelectionRef = useRef<d3.Selection<SVGLineElement, GraphLink, SVGGElement, unknown> | null>(null);
  const labelSelectionRef = useRef<d3.Selection<SVGTextElement, GraphNode, SVGGElement, unknown> | null>(null);
  const nodeMapRef = useRef<Map<string, GraphNode>>(new Map());
  const { t } = i18n;
  const keywords = keywordsSignal.value;
  const edges = similarityEdgesSignal.value;
  const db = useDatabase();

  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const graphGroup = svg.append('g');
    const linkLayer = graphGroup.append('g');
    const nodeLayer = graphGroup.append('g');
    const labelLayer = graphGroup.append('g');

    const simulation = d3
      .forceSimulation<GraphNode>([])
      .force(
        'link',
        d3
          .forceLink<GraphNode, GraphLink>([])
          .id(d => d.id)
          .distance(d => 40 + (1 - d.weight) * 220),
      )
      .force('charge', d3.forceManyBody().strength(-110))
      .force('center', d3.forceCenter(400, 250))
      .force('collision', d3.forceCollide(34));

    simulation.on('tick', () => {
      linkSelectionRef.current
        ?.attr('x1', d => (d.source as GraphNode).x ?? 0)
        .attr('y1', d => (d.source as GraphNode).y ?? 0)
        .attr('x2', d => (d.target as GraphNode).x ?? 0)
        .attr('y2', d => (d.target as GraphNode).y ?? 0);
      nodeSelectionRef.current
        ?.attr('cx', d => d.x ?? 0)
        .attr('cy', d => d.y ?? 0);
      labelSelectionRef.current
        ?.attr('x', d => d.x ?? 0)
        .attr('y', d => d.y ?? 0);
    });

    svg.call(
      d3.zoom<SVGSVGElement, unknown>().on('zoom', event => {
        graphGroup.attr('transform', event.transform);
      }),
    );

    simulationRef.current = simulation;
    graphGroupRef.current = graphGroup;
    linkLayerRef.current = linkLayer;
    nodeLayerRef.current = nodeLayer;
    labelLayerRef.current = labelLayer;

    return () => {
      simulation.stop();
      simulationRef.current = null;
      graphGroupRef.current = null;
      linkLayerRef.current = null;
      nodeLayerRef.current = null;
      labelLayerRef.current = null;
      nodeSelectionRef.current = null;
      linkSelectionRef.current = null;
      labelSelectionRef.current = null;
      nodeMapRef.current = new Map();
    };
  }, []);

  useEffect(() => {
    const validIds = new Set(keywords.map(keyword => keyword.id));
    setSelected(prev => {
      const next = prev.filter(id => validIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [keywords]);

  useEffect(() => {
    if (
      !svgRef.current
      || !simulationRef.current
      || !linkLayerRef.current
      || !nodeLayerRef.current
      || !labelLayerRef.current
    ) {
      return;
    }

    const rect = svgRef.current.getBoundingClientRect();
    const width = rect.width || 800;
    const height = rect.height || 500;
    const embeddings = embeddingsSignal.value;
    const previousNodes = nodeMapRef.current;

    const nodes: GraphNode[] = keywords.map(keyword => {
      const existing = previousNodes.get(keyword.id);
      if (existing) {
        existing.label = displayName(keyword);
        return existing;
      }

      const embedding = embeddings.get(keyword.id);
      return {
        id: keyword.id,
        label: displayName(keyword),
        x: embedding?.x !== undefined ? embedding.x * 120 + width / 2 : width / 2 + (Math.random() - 0.5) * 80,
        y: embedding?.y !== undefined ? embedding.y * 120 + height / 2 : height / 2 + (Math.random() - 0.5) * 80,
      };
    });

    nodeMapRef.current = new Map(nodes.map(node => [node.id, node]));

    const links: GraphLink[] = [];
    for (const edge of edges) {
      if (edge.weight <= 0) continue;
      const source = nodeMapRef.current.get(edge.sourceId);
      const target = nodeMapRef.current.get(edge.targetId);
      if (!source || !target) continue;
      links.push({ source, target, weight: edge.weight });
    }

    const linkSelection = linkLayerRef.current
      .selectAll<SVGLineElement, GraphLink>('line')
      .data(links, link => linkKey(link));
    const mergedLinks = linkSelection
      .join(
        enter => enter.append('line'),
        update => update,
        exit => exit.remove(),
      )
      .attr('stroke', vars.color.border)
      .attr('stroke-width', d => d.weight * 3)
      .attr('stroke-opacity', d => 0.2 + d.weight * 0.5);

    const nodeSelection = nodeLayerRef.current
      .selectAll<SVGCircleElement, GraphNode>('circle')
      .data(nodes, node => node.id);
    const mergedNodes = nodeSelection
      .join(
        enter => enter.append('circle'),
        update => update,
        exit => exit.remove(),
      )
      .attr('r', 14)
      .attr('fill', vars.color.primary)
      .attr('stroke', vars.color.surface)
      .attr('stroke-width', 2)
      .attr('cursor', 'pointer')
      .on('click', (_event, node) => {
        setSelected(prev => (
          prev.includes(node.id) ? prev.filter(id => id !== node.id) : [...prev, node.id]
        ));
      });
    mergedNodes
      .selectAll<SVGTitleElement, GraphNode>('title')
      .data(node => [node])
      .join('title')
      .text(node => node.label);

    const labelSelection = labelLayerRef.current
      .selectAll<SVGTextElement, GraphNode>('text')
      .data(nodes, node => node.id);
    const mergedLabels = labelSelection
      .join(
        enter => enter.append('text'),
        update => update,
        exit => exit.remove(),
      )
      .text(node => node.label)
      .attr('font-size', 11)
      .attr('text-anchor', 'middle')
      .attr('dy', 28)
      .attr('fill', vars.color.text)
      .attr('pointer-events', 'none');

    linkSelectionRef.current = mergedLinks;
    nodeSelectionRef.current = mergedNodes;
    labelSelectionRef.current = mergedLabels;

    const simulation = simulationRef.current;
    const linkForce = simulation.force('link') as d3.ForceLink<GraphNode, GraphLink>;
    simulation.force('center', d3.forceCenter(width / 2, height / 2));
    simulation.nodes(nodes);
    linkForce.links(links);
    simulation.alpha(nodes.length === 0 ? 0 : 0.45).restart();
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
        <svg ref={svgRef} class={s.graphCanvas} />
        <aside class={s.graphSidebar}>
          <div class={`${s.card} ${s.graphSidebarCard}`}>
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
