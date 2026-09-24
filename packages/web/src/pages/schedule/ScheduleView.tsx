import { useCallback, useState } from 'preact/hooks';
import { ArrowDown, ArrowUp, Calendar, GripVertical, MoreHorizontal, Plus } from 'lucide-preact';
import { CollisionPriority } from '@dnd-kit/abstract';
import type { Person, SimilarityLookup } from '@labby/core';

import { displayName, fallbackEntityId, i18n } from '@/i18n';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import type { DraftPersonSlot, DraftPresentation, ScheduleDraft } from './schedule-editor';
import { PersonSelectDialog } from './dialogs';
import {
  scheduleDragType,
  type DragDropManager,
  useScheduleDnd,
  useScheduleDraggable,
  useScheduleDroppable,
} from './schedule-dnd';
import * as css from './ScheduleView.css';

interface ScheduleViewProps {
  draft: ScheduleDraft | null;
  personMap: Map<string, Person>;
  similarities: SimilarityLookup;
  manualEditMode: boolean;
  highlightPersonIds: ReadonlySet<string>;
  highlightOnly: boolean;
  onHighlightPerson: (personId: string, mode: 'toggle' | 'only') => void;
  onInsertPresentation: (sessionIndex: number, presentationIndex: number) => void;
  onDeletePresentation: (presentationId: string) => void;
  onReplacePresenter: (presentationId: string, personId: string | null) => void;
  onAddQuestioner: (presentationId: string, personId: string | null) => void;
  onReplaceQuestioner: (presentationId: string, slotId: string, personId: string | null) => void;
  onDeleteQuestioner: (presentationId: string, slotId: string) => void;
  onMoveQuestioner: (sourcePresentationId: string, slotId: string, targetPresentationId: string, targetIndex: number) => void;
  onReorderPresentations: (sourceId: string, targetId: string, placement: 'before' | 'after') => void;
  onMovePresentationTo: (sourceId: string, targetSessionIndex: number, targetPresentationIndex: number) => void;
  onMoveBoundary: (sessionIndex: number, direction: 'up' | 'down') => void;
  onMoveBoundaryTo: (sessionIndex: number, targetSessionIndex: number, targetPresentationIndex: number) => void;
  onShiftSuffix: (sessionIndex: number, direction: 'up' | 'down') => void;
  onInsertSession: (index: number) => void;
  onDeleteSession: (sessionId: string) => void;
  onShowMetricsForSession: (date: string) => void;
}

function slotLabel(slot: DraftPersonSlot, personMap: Map<string, Person>, autoLabel: string): string {
  if (slot.kind === 'auto') return autoLabel;
  const person = personMap.get(slot.personId);
  return person ? displayName(person) : fallbackEntityId(slot.personId);
}

export function ScheduleView({
  draft,
  personMap,
  similarities,
  manualEditMode,
  highlightPersonIds,
  highlightOnly,
  onHighlightPerson,
  onInsertPresentation,
  onDeletePresentation,
  onReplacePresenter,
  onAddQuestioner,
  onReplaceQuestioner,
  onDeleteQuestioner,
  onMoveQuestioner,
  onReorderPresentations,
  onMovePresentationTo,
  onMoveBoundary,
  onMoveBoundaryTo,
  onShiftSuffix,
  onInsertSession,
  onDeleteSession,
  onShowMetricsForSession,
}: ScheduleViewProps) {
  const { t } = i18n;
  const dndManager = useScheduleDnd({
    movePresentation: onReorderPresentations,
    movePresentationTo: onMovePresentationTo,
    moveQuestioner: onMoveQuestioner,
    moveBoundary: onMoveBoundaryTo,
  });
  const [personSelection, setPersonSelection] = useState<
    | { kind: 'presenter'; presentationId: string }
    | { kind: 'questioner-add'; presentationId: string }
    | { kind: 'questioner-replace'; presentationId: string; slotId: string }
    | null
  >(null);

  if (!draft) return <div class={css.empty}>{t('noSchedule')}</div>;
  const people = [...personMap.values()].filter(person => !person.disabled);
  const allPresentations = [
    ...draft.discardedBefore,
    ...draft.sessions.flatMap(session => session.presentations),
    ...draft.discardedAfter,
  ];
  const selectedPresentation = personSelection
    ? allPresentations.find(presentation => presentation.id === personSelection.presentationId)
    : undefined;
  const selectedQuestioner = personSelection?.kind === 'questioner-replace'
    ? selectedPresentation?.questioners.find(slot => slot.id === personSelection.slotId)
    : undefined;
  const excludedPersonIds = new Set<string>();
  if (selectedPresentation) {
    if (personSelection?.kind !== 'presenter' && selectedPresentation.presenter.kind === 'fixed') {
      excludedPersonIds.add(selectedPresentation.presenter.personId);
    }
    for (const slot of selectedPresentation.questioners) {
      if (slot.kind === 'fixed' && slot.id !== selectedQuestioner?.id) excludedPersonIds.add(slot.personId);
    }
  }

  const presenterMenu = (presentation: DraftPresentation) => {
    const presenterPersonId = presentation.presenter.kind === 'fixed' ? presentation.presenter.personId : null;
    return (
    <>
      {presenterPersonId && <>
        <MenuItem onSelect={() => onHighlightPerson(presenterPersonId, 'toggle')}>{t('toggleHighlight')}</MenuItem>
        <MenuItem onSelect={() => onHighlightPerson(presenterPersonId, 'only')}>{t('onlyHighlight')}</MenuItem>
      </>}
      {manualEditMode && <>
      <MenuItem onSelect={() => onReplacePresenter(presentation.id, null)}>{t('setAutoPresenter')}</MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => setPersonSelection({ kind: 'presenter', presentationId: presentation.id })}>
        {t('choosePresenter')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem danger onSelect={() => onDeletePresentation(presentation.id)}>{t('deletePresentation')}</MenuItem>
      </>}
    </>
  );
  };

  const questionerMenu = (presentation: DraftPresentation, slot: DraftPersonSlot) => (
    <>
      {slot.kind === 'fixed' && <>
        <MenuItem onSelect={() => onHighlightPerson(slot.personId, 'toggle')}>{t('toggleHighlight')}</MenuItem>
        <MenuItem onSelect={() => onHighlightPerson(slot.personId, 'only')}>{t('onlyHighlight')}</MenuItem>
      </>}
      {manualEditMode && <>
      <MenuItem onSelect={() => onReplaceQuestioner(presentation.id, slot.id, null)}>{t('autoQuestioner')}</MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => setPersonSelection({ kind: 'questioner-replace', presentationId: presentation.id, slotId: slot.id })}>
        {t('chooseQuestioner')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem danger onSelect={() => onDeleteQuestioner(presentation.id, slot.id)}>{t('deleteQuestioner')}</MenuItem>
      </>}
    </>
  );

  const dateMenu = (sessionIndex: number) => {
    const session = draft.sessions[sessionIndex]!;
    return (
      <>
        <MenuItem onSelect={() => onShowMetricsForSession(session.date)}>{t('viewMetrics')}</MenuItem>
        {manualEditMode && (
          <>
            <MenuSeparator />
            <MenuItem onSelect={() => onInsertSession(sessionIndex)}>{t('insertSessionBefore')}</MenuItem>
            <MenuItem onSelect={() => onInsertSession(sessionIndex + 1)}>{t('insertSessionAfter')}</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => onMoveBoundary(sessionIndex, 'up')}>{t('moveBoundaryUp')}</MenuItem>
            <MenuItem onSelect={() => onMoveBoundary(sessionIndex, 'down')}>{t('moveBoundaryDown')}</MenuItem>
            <MenuItem onSelect={() => onShiftSuffix(sessionIndex, 'up')}>{t('shiftSessionsUp')}</MenuItem>
            <MenuItem onSelect={() => onShiftSuffix(sessionIndex, 'down')}>{t('shiftSessionsDown')}</MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={() => onDeleteSession(session.id)}>{t('deleteSession')}</MenuItem>
          </>
        )}
      </>
    );
  };

  const renderDiscardZone = (position: 'before' | 'after', presentations: DraftPresentation[]) => {
    if (!manualEditMode) return null;
    return (
      <section class={css.discardZone}>
        <div class={css.discardTitle}>
          {position === 'before' ? t('discardBefore') : t('discardAfter')}
          <span>{t('discardCount', String(presentations.length))}</span>
        </div>
        {presentations.length === 0 ? <div class={css.discardEmpty}>{t('discardEmpty')}</div> : presentations.map(presentation => (
          <PresentationRow
            key={presentation.id}
            presentation={presentation}
            personMap={personMap}
            dndManager={dndManager}
            manualEditMode={manualEditMode}
            highlightPersonIds={highlightPersonIds}
            highlightOnly={highlightOnly}
            onHighlightPerson={onHighlightPerson}
            presenterMenu={presenterMenu}
            questionerMenu={questionerMenu}
            onAddQuestioner={onAddQuestioner}
            onRequestQuestionerSelection={() => setPersonSelection({ kind: 'questioner-add', presentationId: presentation.id })}
          />
        ))}
      </section>
    );
  };

  return (
    <div class={css.tape}>
      <div class={css.columnHeader}>
        <span>{t('presenter')}</span>
        <span>{t('questioners')}</span>
      </div>
      {renderDiscardZone('before', draft.discardedBefore)}
      {draft.sessions.map((session, sessionIndex) => (
        <section key={session.id}>
          <div class={css.sessionDivider}>
            <div class={css.dashedLine} />
            <Menu mode="context">
              <MenuTrigger>
                <BoundaryHandle
                  dndManager={dndManager}
                  sessionId={session.id}
                  sessionIndex={sessionIndex}
                  manualEditMode={manualEditMode}
                >
                  {manualEditMode && <GripVertical size={14} />}
                  <Calendar size={15} />
                  <span>{session.date}</span>
                </BoundaryHandle>
              </MenuTrigger>
              <MenuContent>{dateMenu(sessionIndex)}</MenuContent>
            </Menu>
            {manualEditMode && (
              <span class={css.boundaryButtons}>
                <button class={css.boundaryButton} type="button" title={t('moveBoundaryUp')} onClick={() => onMoveBoundary(sessionIndex, 'up')}><ArrowUp size={13} /></button>
                <button class={css.boundaryButton} type="button" title={t('moveBoundaryDown')} onClick={() => onMoveBoundary(sessionIndex, 'down')}><ArrowDown size={13} /></button>
              </span>
            )}
            <Menu>
              <MenuTrigger><button type="button" class={css.moreButton} aria-label={t('scheduleActions')}><MoreHorizontal size={16} /></button></MenuTrigger>
              <MenuContent align="end">{dateMenu(sessionIndex)}</MenuContent>
            </Menu>
          </div>
          {manualEditMode && <InsertRail dndManager={dndManager} sessionIndex={sessionIndex} presentationIndex={0} onInsert={() => onInsertPresentation(sessionIndex, 0)} />}
          {session.presentations.map((presentation, presentationIndex) => (
            <div key={presentation.id}>
              <PresentationRow
                presentation={presentation}
                personMap={personMap}
                dndManager={dndManager}
                manualEditMode={manualEditMode}
                highlightPersonIds={highlightPersonIds}
                highlightOnly={highlightOnly}
                onHighlightPerson={onHighlightPerson}
                presenterMenu={presenterMenu}
                questionerMenu={questionerMenu}
                onAddQuestioner={onAddQuestioner}
                onRequestQuestionerSelection={() => setPersonSelection({ kind: 'questioner-add', presentationId: presentation.id })}
              />
              {manualEditMode && <InsertRail dndManager={dndManager} sessionIndex={sessionIndex} presentationIndex={presentationIndex + 1} onInsert={() => onInsertPresentation(sessionIndex, presentationIndex + 1)} />}
            </div>
          ))}
        </section>
      ))}
      {renderDiscardZone('after', draft.discardedAfter)}
      <PersonSelectDialog
        open={personSelection !== null && Boolean(selectedPresentation)}
        title={personSelection?.kind === 'presenter' ? t('choosePresenter') : t('chooseQuestioner')}
        persons={people}
        currentPersonId={
          personSelection?.kind === 'presenter'
            ? selectedPresentation?.presenter.kind === 'fixed' ? selectedPresentation.presenter.personId : undefined
            : selectedQuestioner?.kind === 'fixed' ? selectedQuestioner.personId : undefined
        }
        excludedPersonIds={excludedPersonIds}
        presenter={personSelection?.kind === 'presenter' ? undefined : selectedPresentation?.presenter.kind === 'fixed' ? personMap.get(selectedPresentation.presenter.personId) : undefined}
        similarities={personSelection?.kind === 'presenter' ? undefined : similarities}
        onSelect={personId => {
          if (!personSelection) return;
          if (personSelection.kind === 'presenter') onReplacePresenter(personSelection.presentationId, personId);
          else if (personSelection.kind === 'questioner-add') onAddQuestioner(personSelection.presentationId, personId);
          else onReplaceQuestioner(personSelection.presentationId, personSelection.slotId, personId);
        }}
        onClose={() => setPersonSelection(null)}
      />
    </div>
  );
}

function BoundaryHandle({ dndManager, sessionId, sessionIndex, manualEditMode, children }: { dndManager: DragDropManager; sessionId: string; sessionIndex: number; manualEditMode: boolean; children: preact.ComponentChildren }) {
  const { elementRef, handleRef } = useScheduleDraggable(dndManager, {
    id: `schedule-boundary:${sessionId}`,
    type: scheduleDragType.boundary,
    data: { kind: 'boundary', sessionIndex },
    disabled: !manualEditMode,
    withHandle: true,
  });
  const setHandleRef = useCallback((element: HTMLElement | null) => {
    elementRef(element);
    handleRef(element);
  }, [elementRef, handleRef]);
  return <div ref={setHandleRef} class={css.dateHandle} style={{ cursor: manualEditMode ? 'grab' : 'default', touchAction: manualEditMode ? 'none' : 'auto' }} tabIndex={0}>{children}</div>;
}

function InsertRail({ dndManager, sessionIndex, presentationIndex, onInsert }: { dndManager: DragDropManager; sessionIndex: number; presentationIndex: number; onInsert: () => void }) {
  const { t } = i18n;
  const dropRef = useScheduleDroppable(dndManager, {
    id: `schedule-boundary-target:${sessionIndex}:${presentationIndex}`,
    accept: scheduleDragType.boundary,
    data: { kind: 'boundary', sessionIndex, presentationIndex },
    disabled: false,
    priority: CollisionPriority.Highest,
  });
  const presentationDropRef = useScheduleDroppable(dndManager, {
    id: `schedule-presentation-position:${sessionIndex}:${presentationIndex}`,
    accept: scheduleDragType.presentation,
    data: { kind: 'presentation-position', sessionIndex, presentationIndex },
    disabled: false,
    priority: CollisionPriority.Highest,
  });
  const setRailRef = useCallback((element: HTMLElement | null) => {
    dropRef(element);
    presentationDropRef(element);
  }, [dropRef, presentationDropRef]);
  return (
    <div ref={setRailRef} class={css.insertRail}>
      <button class={css.insertButton} type="button" onClick={onInsert} aria-label={t('insertPresentationHere')} title={t('insertPresentationHere')}>
        <Plus size={14} />
      </button>
    </div>
  );
}

interface PresentationRowProps {
  presentation: DraftPresentation;
  personMap: Map<string, Person>;
  dndManager: DragDropManager;
  manualEditMode: boolean;
  highlightPersonIds: ReadonlySet<string>;
  highlightOnly: boolean;
  onHighlightPerson: (personId: string, mode: 'toggle' | 'only') => void;
  presenterMenu: (presentation: DraftPresentation) => preact.ComponentChildren;
  questionerMenu: (presentation: DraftPresentation, slot: DraftPersonSlot) => preact.ComponentChildren;
  onAddQuestioner: (presentationId: string, personId: string | null) => void;
  onRequestQuestionerSelection: () => void;
}

function PresentationRow({
  presentation,
  personMap,
  dndManager,
  manualEditMode,
  highlightPersonIds,
  highlightOnly,
  onHighlightPerson,
  presenterMenu,
  questionerMenu,
  onAddQuestioner,
  onRequestQuestionerSelection,
}: PresentationRowProps) {
  const { t } = i18n;
  const presentationDrag = useScheduleDraggable(dndManager, {
    id: `schedule-presentation:${presentation.id}`,
    type: scheduleDragType.presentation,
    data: { kind: 'presentation', presentationId: presentation.id },
    disabled: !manualEditMode,
    withHandle: true,
  });
  const presentationDrop = useScheduleDroppable(dndManager, {
    id: `schedule-presentation-target:${presentation.id}`,
    accept: scheduleDragType.presentation,
    data: { kind: 'presentation', presentationId: presentation.id },
    disabled: !manualEditMode,
  });
  const questionerCellDrop = useScheduleDroppable(dndManager, {
    id: `schedule-questioner-target:${presentation.id}:end`,
    accept: scheduleDragType.questioner,
    data: { kind: 'questioner', presentationId: presentation.id, targetIndex: presentation.questioners.length, placement: 'at' },
    disabled: !manualEditMode,
    priority: CollisionPriority.Low,
  });
  const setRowRef = useCallback((element: HTMLElement | null) => {
    presentationDrag.elementRef(element);
    presentationDrop(element);
  }, [presentationDrag.elementRef, presentationDrop]);
  return (
    <div
      ref={setRowRef}
      class={css.presentationRow}
    >
      <div class={css.presenterCell}>
        {manualEditMode && <span ref={presentationDrag.handleRef} class={css.rowGrip}><GripVertical size={15} /></span>}
        <Menu mode="context">
          <MenuTrigger>
            <span class={presentation.presenter.kind === 'auto' ? css.autoSlot : `${css.personLabel} ${highlightPersonIds.has(presentation.presenter.personId) ? css.highlightedPerson : ''} ${highlightOnly && !highlightPersonIds.has(presentation.presenter.personId) ? css.dimmedPerson : ''}`}
              style={{ cursor: !manualEditMode && presentation.presenter.kind === 'fixed' ? 'pointer' : 'default' }}
              onDblClick={() => { if (!manualEditMode && presentation.presenter.kind === 'fixed') onHighlightPerson(presentation.presenter.personId, 'toggle'); }}>
              {slotLabel(presentation.presenter, personMap, t('autoPresenter'))}
            </span>
          </MenuTrigger>
          <MenuContent>{presenterMenu(presentation)}</MenuContent>
        </Menu>
        {presentation.presenter.kind === 'fixed' && (
          <Menu>
            <MenuTrigger><button type="button" class={css.rowMenuButton} aria-label={`${t('scheduleActions')}: ${slotLabel(presentation.presenter, personMap, t('autoPresenter'))}`}><MoreHorizontal size={14} /></button></MenuTrigger>
            <MenuContent>{presenterMenu(presentation)}</MenuContent>
          </Menu>
        )}
      </div>
      <div ref={questionerCellDrop} class={css.questionerCell}>
        {presentation.questioners.map((slot, index) => (
          <QuestionerToken
            key={slot.id}
            dndManager={dndManager}
            presentation={presentation}
            slot={slot}
            index={index}
            label={slotLabel(slot, personMap, t('autoQuestioner'))}
            manualEditMode={manualEditMode}
            highlighted={slot.kind === 'fixed' && highlightPersonIds.has(slot.personId)}
            dimmed={slot.kind === 'fixed' && highlightOnly && !highlightPersonIds.has(slot.personId)}
            onHighlightPerson={onHighlightPerson}
            menu={questionerMenu(presentation, slot)}
          />
        ))}
        {presentation.questioners.length === 0 && !manualEditMode && <span class={css.muted}>{t('zeroQuestioners')}</span>}
        {manualEditMode && (
          <Menu>
            <MenuTrigger><button type="button" class={css.addQuestionerButton}><Plus size={13} /> {t('addQuestioner')}</button></MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => onAddQuestioner(presentation.id, null)}>{t('autoQuestioner')}</MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={onRequestQuestionerSelection}>
                {t('chooseQuestioner')}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
    </div>
  );
}

function QuestionerToken({ dndManager, presentation, slot, index, label, manualEditMode, highlighted, dimmed, onHighlightPerson, menu }: { dndManager: DragDropManager; presentation: DraftPresentation; slot: DraftPersonSlot; index: number; label: string; manualEditMode: boolean; highlighted: boolean; dimmed: boolean; onHighlightPerson: (personId: string, mode: 'toggle' | 'only') => void; menu: preact.ComponentChildren }) {
  const drag = useScheduleDraggable(dndManager, {
    id: `schedule-questioner:${presentation.id}:${slot.id}`,
    type: scheduleDragType.questioner,
    data: { kind: 'questioner', presentationId: presentation.id, slotId: slot.id },
    disabled: !manualEditMode,
    withHandle: true,
  });
  const drop = useScheduleDroppable(dndManager, {
    id: `schedule-questioner-target:${presentation.id}:${slot.id}`,
    accept: scheduleDragType.questioner,
    data: { kind: 'questioner', presentationId: presentation.id, targetIndex: index, placement: 'around' },
    disabled: !manualEditMode,
    priority: CollisionPriority.High,
  });
  const setTokenRef = useCallback((element: HTMLElement | null) => {
    drag.elementRef(element);
    drag.handleRef(element);
    drop(element);
  }, [drag.elementRef, drag.handleRef, drop]);
  return (
    <span class={css.questionerWithMenu}>
    <Menu mode="context">
      <MenuTrigger>
        <span ref={setTokenRef} class={slot.kind === 'auto' ? css.autoSlot : `${css.questionerToken} ${highlighted ? css.highlightedPerson : ''} ${dimmed ? css.dimmedPerson : ''}`}
          style={{ cursor: manualEditMode ? 'grab' : slot.kind === 'fixed' ? 'pointer' : 'default', touchAction: manualEditMode ? 'none' : 'auto' }}
          onDblClick={() => { if (!manualEditMode && slot.kind === 'fixed') onHighlightPerson(slot.personId, 'toggle'); }}>{label}</span>
      </MenuTrigger>
      <MenuContent>{menu}</MenuContent>
    </Menu>
    {slot.kind === 'fixed' && <Menu>
      <MenuTrigger><button type="button" class={css.rowMenuButton} aria-label={`${i18n.t('scheduleActions')}: ${label}`}><MoreHorizontal size={14} /></button></MenuTrigger>
      <MenuContent>{menu}</MenuContent>
    </Menu>}
    </span>
  );
}
