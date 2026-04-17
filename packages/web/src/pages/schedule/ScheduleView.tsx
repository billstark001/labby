import type { SchedulePlan, Session, Person } from '@labby/core';

import { Calendar } from 'lucide-preact';
import { fallbackEntityId, displayName, i18n } from '@/i18n';
import * as s from '@/styles/components.css';
import {
  Button,
  ResponsiveDataField,
  ResponsiveDataView,
  responsiveDataStyles as dataStyles,
} from '@/components/ui/index';
import { Menu, MenuTrigger, MenuContent, MenuItem } from '@/components/ui/Menu';

interface ScheduleViewProps {
  current: SchedulePlan | null;
  selectedConfigId: string;
  personMap: Map<string, Person>;
  manualEditMode: boolean;
  onManualEdit: (target: {
    mode: 'presenter' | 'questioner';
    action?: 'replace' | 'add';
    sessionDate: string;
    presIndex: number;
    questIndex?: number;
  }) => void;
  onDeleteQuestioner: (target: { sessionDate: string; presIndex: number; questIndex: number }) => void;
  onShowMetricsForSession: (plan: SchedulePlan, date: string) => void;
  onOpenSessionMutation: (mode: 'insert' | 'delete', date: string) => void;
  onOpenPresentationMutation: (sessionDate: string, presentationIndex: number) => void;
}

export function ScheduleView({
  current,
  selectedConfigId,
  personMap,
  manualEditMode,
  onManualEdit,
  onDeleteQuestioner,
  onShowMetricsForSession,
  onOpenSessionMutation,
  onOpenPresentationMutation,
}: ScheduleViewProps) {
  const { t } = i18n;

  if (!selectedConfigId || !current || current.configId !== selectedConfigId) {
    return <div class={s.cardNoScheduke}>{t('noSchedule')}</div>;
  }

  return (
    <>
      {current.sessions.map((sess: Session) => {
        const dateMeta = current.sessionDateMeta?.[sess.date]
          ?? (current.sessionMutations ?? []).find(record => record.action === 'insert' && record.date === sess.date);
        return (
          <div key={sess.date} class={`${s.card} ${s.mb16}`}>
            <h3 class={`${s.mb12} ${s.text16} ${s.fontBold}`}>
              {manualEditMode ? (
                <Menu mode="context">
                  <MenuTrigger>
                    <span class={s.flexGapXs}>
                      <Calendar size={16} />
                      {sess.date}
                      {dateMeta ? <span class={s.badge} title="Mutated session">M</span> : null}
                    </span>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onSelect={() => onOpenSessionMutation('insert', sess.date)}>
                      {t('mutationInsert')}
                    </MenuItem>
                    <MenuItem onSelect={() => onOpenSessionMutation('delete', sess.date)}>
                      {t('mutationDelete')}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              ) : (
                <span class={s.flexGapXs}>
                  <Calendar size={16} />
                  {sess.date}
                  {dateMeta ? <span class={s.badge} title="Mutated session">M</span> : null}
                </span>
              )}
              <div class={s.flexGapXs}>
                <Button variant="ghost" onClick={() => onShowMetricsForSession(current, sess.date)}>
                  {t('viewMetrics')}
                </Button>
              </div>
            </h3>
            <ResponsiveDataView
              items={sess.presentations}
              columns={[
                { header: t('presenter') },
                { header: t('questioners') },
              ]}
              getKey={(_, index) => index}
              colGroup={
                <colgroup>
                  <col style={{ width: '30%' }} />
                  <col style={{ width: '70%' }} />
                </colgroup>
              }
              renderDesktopRow={(pres, pi) => {
                const presenter = personMap.get(pres.presenterId);
                return (
                  <>
                    <td class={s.td}>
                      {manualEditMode ? (
                        <Menu mode="context">
                          <MenuTrigger>
                            <span class={s.editableCell}>
                              {presenter ? displayName(presenter) : fallbackEntityId(pres.presenterId)}
                            </span>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem onSelect={() => onManualEdit({ mode: 'presenter', sessionDate: sess.date, presIndex: pi })}>
                              {t('selectNewPresenter')}
                            </MenuItem>
                            <MenuItem onSelect={() => onOpenPresentationMutation(sess.date, pi)}>
                              Edit Presentation Mutation
                            </MenuItem>
                          </MenuContent>
                        </Menu>
                      ) : (
                        presenter ? displayName(presenter) : fallbackEntityId(pres.presenterId)
                      )}
                    </td>
                    <td class={s.td}>
                      <div class={s.tagList}>
                        {pres.questionerIds.map((qid, qi) => {
                          const questioner = personMap.get(qid);
                          const name = questioner ? displayName(questioner) : fallbackEntityId(qid);
                          return manualEditMode ? (
                            <Menu key={`${qid}-${qi}`} mode="context">
                              <MenuTrigger>
                                <span class={`${s.badge} ${s.editableCell}`}>{name}</span>
                              </MenuTrigger>
                              <MenuContent>
                                <MenuItem onSelect={() => onManualEdit({ mode: 'questioner', sessionDate: sess.date, presIndex: pi, questIndex: qi })}>
                                  {t('selectNewQuestioner')}
                                </MenuItem>
                                <MenuItem onSelect={() => onDeleteQuestioner({ sessionDate: sess.date, presIndex: pi, questIndex: qi })}>
                                  {t('delete')}
                                </MenuItem>
                              </MenuContent>
                            </Menu>
                          ) : (
                            <span key={`${qid}-${qi}`} class={s.badge}>{name}</span>
                          );
                        })}
                        {manualEditMode && (
                          <button
                            type="button"
                            class={`${s.badgeButton} ${s.editableCell}`}
                            onClick={() => onManualEdit({ mode: 'questioner', action: 'add', sessionDate: sess.date, presIndex: pi })}
                          >
                            +
                          </button>
                        )}
                      </div>
                    </td>
                  </>
                );
              }}
              renderMobileCard={(pres, pi) => {
                const presenter = personMap.get(pres.presenterId);
                return (
                  <>
                    <div class={dataStyles.mobileHeader}>
                      <div>
                        <div class={dataStyles.mobileTitle}>{presenter ? displayName(presenter) : fallbackEntityId(pres.presenterId)}</div>
                        <div class={dataStyles.mobileSubtitle}>{t('presenter')}</div>
                      </div>
                    </div>
                    <div class={dataStyles.mobileFields}>
                      <ResponsiveDataField label={t('questioners')}>
                        <div class={s.tagList}>
                          {pres.questionerIds.map((qid, qi) => {
                            const questioner = personMap.get(qid);
                            const name = questioner ? displayName(questioner) : fallbackEntityId(qid);
                            return manualEditMode ? (
                              <Menu key={`${qid}-${qi}`} mode="context">
                                <MenuTrigger>
                                  <span class={`${s.badge} ${s.editableCell}`}>{name}</span>
                                </MenuTrigger>
                                <MenuContent>
                                  <MenuItem onSelect={() => onManualEdit({ mode: 'questioner', sessionDate: sess.date, presIndex: pi, questIndex: qi })}>
                                    {t('selectNewQuestioner')}
                                  </MenuItem>
                                  <MenuItem onSelect={() => onDeleteQuestioner({ sessionDate: sess.date, presIndex: pi, questIndex: qi })}>
                                    {t('delete')}
                                  </MenuItem>
                                </MenuContent>
                              </Menu>
                            ) : (
                              <span key={`${qid}-${qi}`} class={s.badge}>{name}</span>
                            );
                          })}
                          {manualEditMode && (
                            <button
                              type="button"
                              class={`${s.badgeButton} ${s.editableCell}`}
                              onClick={() => onManualEdit({ mode: 'questioner', action: 'add', sessionDate: sess.date, presIndex: pi })}
                            >
                              +
                            </button>
                          )}
                        </div>
                      </ResponsiveDataField>
                    </div>
                    {manualEditMode && (
                      <div class={s.flexGapXs}>
                        <Button
                          variant="ghost"
                          onClick={() => onManualEdit({ mode: 'presenter', sessionDate: sess.date, presIndex: pi })}
                        >
                          {t('selectNewPresenter')}
                        </Button>
                      </div>
                    )}
                  </>
                );
              }}
            />
          </div>
        );
      })}
    </>
  );
}
