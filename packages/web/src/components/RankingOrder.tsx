import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DragDropManager, Draggable, Droppable } from '@dnd-kit/dom';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-preact';
import { moveRanking } from '@/lib/ranking-editor';
import { i18n } from '@/i18n';
import { Button } from './ui/common';
import * as s from '@/styles/components.css';

interface RankingOrderProps {
  candidates: string[];
  ranks: Record<string, number>;
  names: Map<string, string>;
  disabled: boolean;
  onChange: (ranks: Record<string, number>) => void;
}

export function RankingOrder(props: RankingOrderProps) {
  const { t } = i18n;
  const current = useRef(props);
  current.current = props;
  const manager = useMemo(() => new DragDropManager(), []);
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => {
    const unsubscribeOver = manager.monitor.addEventListener('dragover', (event) => {
      setOver(event.operation.target?.data.keywordId ?? null);
    });
    const unsubscribeEnd = manager.monitor.addEventListener('dragend', (event) => {
      setOver(null);
      const { source, target, shape } = event.operation;
      const props = current.current;
      if (event.canceled || props.disabled || !source || !target) return;
      const rect = target.element?.getBoundingClientRect();
      const native = event.nativeEvent;
      const y = native && 'clientY' in native ? Number(native.clientY) : shape?.current?.center.y;
      props.onChange(
        moveRanking(
          props.candidates,
          props.ranks,
          source.data.keywordId,
          target.data.keywordId,
          rect && y !== undefined && y >= rect.top + rect.height / 2 ? 'after' : 'before',
        ),
      );
    });
    return () => {
      unsubscribeOver();
      unsubscribeEnd();
      manager.destroy();
    };
  }, [manager]);
  const ordered = [...props.candidates].sort(
    (a, b) => (props.ranks[a] || Infinity) - (props.ranks[b] || Infinity),
  );
  return (
    <div>
      <p class={s.mutedParagraph}>{t('rankingDragHint')}</p>
      {ordered.map((id, index) => (
        <RankingRow
          key={id}
          id={id}
          name={props.names.get(id) ?? id}
          manager={manager}
          over={over === id}
          rank={props.ranks[id] ?? 0}
          count={ordered.length}
          disabled={props.disabled}
          onRank={(rank) => props.onChange({ ...props.ranks, [id]: rank })}
          onUp={
            index
              ? () =>
                  props.onChange(
                    moveRanking(props.candidates, props.ranks, id, ordered[index - 1]!, 'before'),
                  )
              : undefined
          }
          onDown={
            index < ordered.length - 1
              ? () =>
                  props.onChange(
                    moveRanking(props.candidates, props.ranks, id, ordered[index + 1]!, 'after'),
                  )
              : undefined
          }
        />
      ))}
    </div>
  );
}

function RankingRow({
  id,
  name,
  manager,
  over,
  rank,
  count,
  disabled,
  onRank,
  onUp,
  onDown,
}: {
  id: string;
  name: string;
  manager: DragDropManager;
  over: boolean;
  rank: number;
  count: number;
  disabled: boolean;
  onRank: (rank: number) => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const { t } = i18n;
  const element = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!element.current || !handle.current) return;
    const data = { keywordId: id };
    const draggable = new Draggable(
      { id, type: 'ranking', data, element: element.current, handle: handle.current, disabled },
      manager,
    );
    const droppable = new Droppable(
      { id, accept: 'ranking', data, element: element.current, disabled },
      manager,
    );
    return () => {
      draggable.destroy();
      droppable.destroy();
    };
  }, [manager, id, disabled]);
  return (
    <div
      ref={element}
      class={`${s.formGroup} ${s.rankingRow} ${over ? s.rankingRowOver : ''}`}
    >
      <button
        ref={handle}
        type="button"
        disabled={disabled}
        aria-label={`${t('rankingDragHint')} ${name}`}
        class={s.rankingHandle}
      >
        <GripVertical size={18} />
      </button>
      <span class={s.rankingName}>{name}</span>
      <select
        class={`${s.input} ${s.rankingSelect}`}
        aria-label={`${name} · ${t('rankingNearest')}`}
        value={rank}
        disabled={disabled}
        onChange={(event) => onRank(Number(event.currentTarget.value))}
      >
        <option value={0}>{t('rankingUnknown')}</option>
        {Array.from({ length: count }, (_, i) => (
          <option key={i} value={i + 1}>
            {i + 1}
            {i === 0 ? ` · ${t('rankingNearest')}` : ''}
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        disabled={disabled || !onUp}
        aria-label={`${t('rankingMoveUp')} ${name}`}
        onClick={onUp}
      >
        <ArrowUp size={16} />
      </Button>
      <Button
        variant="ghost"
        disabled={disabled || !onDown}
        aria-label={`${t('rankingMoveDown')} ${name}`}
        onClick={onDown}
      >
        <ArrowDown size={16} />
      </Button>
    </div>
  );
}
