import 'preact/debug';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, it, expect, vi } from 'vitest';
import type { GraphPage, LabbyDB } from '@labby/core';
import { graphStream } from '../src/lib/graph-sync';
import { KeywordGraph } from '../src/components/KeywordGraph';

const observed = vi.hoisted(() => ({ props: [] as any[], db: {} as LabbyDB }));
vi.mock('@/db/index', () => ({
  useDatabase: () => observed.db,
  readAllPaginated: async (store: { list: () => Promise<{ items: unknown[] }> }) => (await store.list()).items,
}));
vi.mock('../src/components/RankingCard', () => ({ RankingEditor: () => null }));
vi.mock('@deck.gl/core', () => ({
  Deck: class {
    constructor(props: any) {
      props.parent.dataset.graphCanvas = 'true';
    }
    setProps(props: any) {
      observed.props.push(props);
    }
    pickObject() {
      return { object: { id: 'keyword' } };
    }
    finalize() {}
  },
  OrthographicView: class {},
}));
vi.mock('@deck.gl/layers', () => ({
  LineLayer: class {},
  ScatterplotLayer: class {},
  TextLayer: class {},
}));

describe('KeywordGraph incremental renders', () => {
  it('keeps rendering valid pages after repeated invalid responses and unchanged polls', async () => {
    let mode: 'valid' | 'invalid' | 'empty' = 'valid';
    let revision = 0;
    const db = {
      persons: { list: async () => ({ items: [], total: 0 }) },
      graph: {
        list: async (): Promise<GraphPage> => ({
          items:
            mode === 'empty'
              ? []
              : mode === 'invalid'
                ? ([{ id: 'keyword', keyword: 'text payload', vector: null }] as any)
                : [
                    {
                      id: 'keyword',
                      keyword: { id: 'keyword', name: 'Revision ' + revision },
                      vector: {
                        keywordId: 'keyword',
                        embedding: Array(8).fill(0),
                        geometry: { hyperbolicDimensions: 4, euclideanDimensions: 4 },
                        x: revision / 100,
                        y: 0,
                        updatedAt: revision,
                      },
                    },
                  ],
          nextCursor: null,
          checkpoint: 'checkpoint',
          reset: false,
        }),
      },
    } as LabbyDB;
    observed.db = db;
    observed.props = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: any) {}
        observe() {
          this.callback([{ contentRect: { width: 800, height: 400 } }]);
        }
        disconnect() {}
      },
    );
    const stream = graphStream(db);
    const container = document.createElement('div');
    document.body.append(container);
    try {
      await act(() => {
        render(<KeywordGraph />, container);
      });
      await act(async () => {
        await stream.refresh();
      });
      expect(container.textContent).toContain('Nodes: 1');
      const fits = observed.props.filter((props) => props.initialViewState).length;
      expect(fits).toBe(1);
      mode = 'invalid';
      for (let i = 0; i < 30; i++)
        await act(async () => {
          await expect(stream.refresh()).rejects.toThrow('Malformed graph');
        });
      expect(container.textContent).toContain('Nodes: 1');
      mode = 'valid';
      for (let i = 0; i < 30; i++) {
        revision++;
        await act(async () => {
          await stream.refresh();
        });
      }
      mode = 'empty';
      for (let i = 0; i < 30; i++)
        await act(async () => {
          await stream.refresh();
        });
      expect(container.textContent).toContain('Nodes: 1');
      expect(container.querySelector('[title^="Error:"]')).toBeNull();
      expect(observed.props.filter((props) => props.initialViewState)).toHaveLength(fits);
      await act(async () => {
        container
          .querySelector('[data-graph-canvas]')!
          .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 100 }));
      });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect((document.querySelector('[role="dialog"] input') as HTMLInputElement).value).toBe(
        'Revision 30',
      );
    } finally {
      await act(() => render(null, container));
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
