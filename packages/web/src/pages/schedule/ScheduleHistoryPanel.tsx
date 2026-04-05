import type { SchedulePlan } from '@labby/core';

import { X } from 'lucide-preact';
import { i18n } from '@/i18n';
import * as s from '@/styles/components.css';
import { Button } from '@/components/ui/index';
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { toast } from '@/components/ui/Toast';
import { HistoryNotesDialog } from './forms';

interface ScheduleHistoryPanelProps {
  sortedHistoryPlans: SchedulePlan[];
  selectedHistoryIds: Set<string>;
  currentSchedule: SchedulePlan | null;
  onSelectHistory: (plan: SchedulePlan) => void;
  onToggleHistory: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onInvertSelection: () => void;
  onDeleteHistory: (plan: SchedulePlan) => void;
  onDeleteSelected: () => void;
  onEditNotes: (plan: SchedulePlan) => void;
  onShowMetrics: (plan: SchedulePlan) => void;
  editingNotes: SchedulePlan | null;
  onSaveNotes: (plan: SchedulePlan, notes: string) => void;
  onCloseNotes: () => void;
}

export function ScheduleHistoryPanel({
  sortedHistoryPlans,
  selectedHistoryIds,
  currentSchedule,
  onSelectHistory,
  onToggleHistory,
  onSelectAll,
  onClearSelection,
  onInvertSelection,
  onDeleteHistory,
  onDeleteSelected,
  onEditNotes,
  onShowMetrics,
  editingNotes,
  onSaveNotes,
  onCloseNotes,
}: ScheduleHistoryPanelProps) {
  const { t } = i18n;

  return (
    <>
      <div class={s.mb24}>
        <div class={`${s.flexBetween} ${s.mt8}`}>
          <strong class={s.text14}>{t('historyTitle')}</strong>
          <div class={s.flexGapSm}>
            <Button variant="ghost" onClick={onSelectAll}>{t('selectAll')}</Button>
            <Button variant="ghost" onClick={onClearSelection}>{t('clearSelection')}</Button>
            <Button variant="ghost" onClick={onInvertSelection}>{t('invertSelection')}</Button>
            <Button
              variant="danger"
              disabled={selectedHistoryIds.size === 0}
              onClick={onDeleteSelected}
            >
              {t('deleteSelected')}
            </Button>
          </div>
        </div>
        <div class={`${s.flexGapSm} ${s.flexWrap} ${s.mt8}`}>
          {sortedHistoryPlans.map(p => (
            <div key={p.id} class={s.historyItem}>
              <input
                type="checkbox"
                checked={selectedHistoryIds.has(p.id)}
                onChange={() => onToggleHistory(p.id)}
              />
              <Menu mode="context">
                <MenuTrigger>
                  <button
                    class={`${s.badgeButton} ${currentSchedule?.id === p.id ? '' : s.badgeButtonDimmed}`}
                    onClick={() => onSelectHistory(p)}
                  >
                    {new Date(p.createdAt).toLocaleString()}
                    {p.notes && <span class={`${s.text12} ${s.textMuted}`}> — {p.notes}</span>}
                  </button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => {
                    const txt = `${new Date(p.createdAt).toLocaleString()}${p.notes ? ' — ' + p.notes : ''}`;
                    navigator.clipboard?.writeText(txt).then(
                      () => toast.success(t('copyToClipboard')),
                      () => toast.error(t('importError')),
                    );
                  }}>
                    {t('copySchedule')}
                  </MenuItem>
                  <MenuItem onSelect={() => onEditNotes(p)}>
                    {t('editNotes')}
                  </MenuItem>
                  <MenuItem onSelect={() => onShowMetrics(p)}>
                    {t('viewMetrics')}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onSelect={() => onDeleteHistory(p)} danger>
                    {t('delete')}
                  </MenuItem>
                </MenuContent>
              </Menu>
              <button
                class={s.historyDeleteButton}
                onClick={() => onDeleteHistory(p)}
                title={t('delete')}
                aria-label={t('delete')}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {editingNotes && (
        <HistoryNotesDialog
          plan={editingNotes}
          onSave={notes => onSaveNotes(editingNotes, notes)}
          onClose={onCloseNotes}
        />
      )}
    </>
  );
}
