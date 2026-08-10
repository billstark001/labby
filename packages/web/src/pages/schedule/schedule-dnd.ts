import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import type { CollisionPriority } from '@dnd-kit/abstract';
import {
  DragDropManager,
  Draggable,
  Droppable,
  type DragEndEvent,
} from '@dnd-kit/dom';

export const scheduleDragType = {
  presentation: 'schedule-presentation',
  questioner: 'schedule-questioner',
  boundary: 'schedule-boundary',
} as const;

export type ScheduleDragData =
  | { kind: 'presentation'; presentationId: string }
  | { kind: 'questioner'; presentationId: string; slotId: string }
  | { kind: 'boundary'; sessionIndex: number };

export type ScheduleDropData =
  | { kind: 'presentation'; presentationId: string }
  | { kind: 'presentation-position'; sessionIndex: number; presentationIndex: number }
  | { kind: 'questioner'; presentationId: string; targetIndex: number; placement: 'at' | 'around' }
  | { kind: 'boundary'; sessionIndex: number; presentationIndex: number };

export interface ScheduleDndActions {
  movePresentation: (sourceId: string, targetId: string, placement: 'before' | 'after') => void;
  movePresentationTo: (sourceId: string, targetSessionIndex: number, targetPresentationIndex: number) => void;
  moveQuestioner: (sourcePresentationId: string, slotId: string, targetPresentationId: string, targetIndex: number) => void;
  moveBoundary: (sourceSessionIndex: number, targetSessionIndex: number, targetPresentationIndex: number) => void;
}

interface DropGeometry {
  position: { x: number; y: number } | null;
  targetRect: Pick<DOMRect, 'top' | 'left' | 'width' | 'height'> | null;
}

export function performScheduleDrop(
  sourceData: ScheduleDragData,
  targetData: ScheduleDropData,
  geometry: DropGeometry,
  actions: ScheduleDndActions,
): void {
  if (sourceData.kind === 'presentation' && targetData.kind === 'presentation') {
    if (sourceData.presentationId === targetData.presentationId) return;
    const { position, targetRect } = geometry;
    const placement = targetRect && position && position.y >= targetRect.top + targetRect.height / 2 ? 'after' : 'before';
    actions.movePresentation(sourceData.presentationId, targetData.presentationId, placement);
    return;
  }

  if (sourceData.kind === 'presentation' && targetData.kind === 'presentation-position') {
    actions.movePresentationTo(sourceData.presentationId, targetData.sessionIndex, targetData.presentationIndex);
    return;
  }

  if (sourceData.kind === 'questioner' && targetData.kind === 'questioner') {
    let targetIndex = targetData.targetIndex;
    const { position, targetRect } = geometry;
    if (targetData.placement === 'around' && targetRect && position && position.x >= targetRect.left + targetRect.width / 2) {
      targetIndex += 1;
    }
    actions.moveQuestioner(sourceData.presentationId, sourceData.slotId, targetData.presentationId, targetIndex);
    return;
  }

  if (sourceData.kind === 'boundary' && targetData.kind === 'boundary') {
    actions.moveBoundary(sourceData.sessionIndex, targetData.sessionIndex, targetData.presentationIndex);
  }
}

function dragCenter(event: DragEndEvent): { x: number; y: number } | null {
  const shape = event.operation.shape?.current;
  return shape ? shape.center : null;
}

function pointerPosition(event: DragEndEvent): { x: number; y: number } | null {
  const nativeEvent = event.nativeEvent;
  if (nativeEvent && 'clientX' in nativeEvent && 'clientY' in nativeEvent) {
    return {
      x: Number((nativeEvent as MouseEvent).clientX),
      y: Number((nativeEvent as MouseEvent).clientY),
    };
  }
  return dragCenter(event);
}

function handleDrop(event: DragEndEvent, actions: ScheduleDndActions): void {
  if (event.canceled) return;
  const source = event.operation.source;
  const target = event.operation.target;
  if (!source || !target) return;
  const sourceData = source.data as ScheduleDragData;
  const targetData = target.data as ScheduleDropData;

  performScheduleDrop(sourceData, targetData, {
    position: pointerPosition(event),
    targetRect: target.element?.getBoundingClientRect() ?? null,
  }, actions);
}

export function useScheduleDnd(actions: ScheduleDndActions): DragDropManager {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const manager = useMemo(() => new DragDropManager(), []);

  useEffect(() => manager.monitor.addEventListener('dragend', event => handleDrop(event, actionsRef.current)), [manager]);
  useEffect(() => () => manager.destroy(), [manager]);
  return manager;
}

type ElementRef = (element: HTMLElement | null) => void;

export function useScheduleDraggable(
  manager: DragDropManager,
  input: {
    id: string;
    type: (typeof scheduleDragType)[keyof typeof scheduleDragType];
    data: ScheduleDragData;
    disabled: boolean;
    withHandle?: boolean;
  },
): { elementRef: ElementRef; handleRef: ElementRef } {
  const element = useRef<HTMLElement | null>(null);
  const handle = useRef<HTMLElement | null>(null);
  const entity = useRef<Draggable<ScheduleDragData> | null>(null);
  const dataRef = useRef(input.data);
  dataRef.current = input.data;
  const elementRef = useCallback((node: HTMLElement | null) => { element.current = node; }, []);
  const handleRef = useCallback((node: HTMLElement | null) => { handle.current = node; }, []);

  useLayoutEffect(() => {
    if (!element.current) return;
    const draggable = new Draggable<ScheduleDragData>({
      id: input.id,
      type: input.type,
      data: dataRef.current,
      element: element.current,
      handle: input.withHandle ? handle.current ?? undefined : undefined,
      disabled: input.disabled,
    }, manager);
    entity.current = draggable;
    return () => {
      entity.current = null;
      draggable.destroy();
    };
  }, [manager, input.id, input.type, input.disabled, input.withHandle]);

  useLayoutEffect(() => {
    if (entity.current) entity.current.data = input.data;
  }, [input.data]);
  return { elementRef, handleRef };
}

export function useScheduleDroppable(
  manager: DragDropManager,
  input: {
    id: string;
    accept: (typeof scheduleDragType)[keyof typeof scheduleDragType];
    data: ScheduleDropData;
    disabled: boolean;
    priority?: CollisionPriority;
  },
): ElementRef {
  const element = useRef<HTMLElement | null>(null);
  const entity = useRef<Droppable<ScheduleDropData> | null>(null);
  const dataRef = useRef(input.data);
  dataRef.current = input.data;
  const elementRef = useCallback((node: HTMLElement | null) => { element.current = node; }, []);

  useLayoutEffect(() => {
    if (!element.current) return;
    const droppable = new Droppable<ScheduleDropData>({
      id: input.id,
      accept: input.accept,
      data: dataRef.current,
      element: element.current,
      disabled: input.disabled,
      collisionPriority: input.priority,
    }, manager);
    entity.current = droppable;
    return () => {
      entity.current = null;
      droppable.destroy();
    };
  }, [manager, input.id, input.accept, input.disabled, input.priority]);

  useLayoutEffect(() => {
    if (entity.current) entity.current.data = input.data;
  }, [input.data]);
  return elementRef;
}

export { type DragDropManager };
