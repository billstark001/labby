import type { PersonUnavailability, ScheduleConfig, Person } from '@labby/core';

import { fallbackEntityId, displayName, i18n } from '@/i18n';
import * as s from '@/styles/components.css';
import {
  Button,
  ResponsiveDataField,
  ResponsiveDataView,
  responsiveDataStyles as dataStyles,
} from '@/components/ui/index';
import { Dialog, confirmDialog } from '@/components/ui/Dialog';
import { getScheduleConfigLabel, getScheduleConfigSummary } from '@/lib/scheduleConfigLabel';
import { ConfigForm, UnavailForm } from './forms';

interface ConfigPanelProps {
  configs: ScheduleConfig[];
  selectedConfigId: string;
  selectedConfig: ScheduleConfig | undefined;
  configUnavails: PersonUnavailability[];
  personMap: Map<string, Person>;
  onSelectConfig: (id: string) => void;
  onNewConfig: () => void;
  onEditConfig: (config: ScheduleConfig) => void;
  onDeleteConfig: (config: ScheduleConfig) => void;
  onAddUnavail: () => void;
  onEditUnavail: (u: PersonUnavailability) => void;
  onDeleteUnavail: (id: string) => void;
  showUnavailForm: boolean;
  editingUnavail: PersonUnavailability | null;
  onCloseUnavailForm: () => void;
  onSaveUnavail: (u: PersonUnavailability) => void;
  showConfigForm: boolean;
  onCloseConfigForm: () => void;
  onSaveConfig: (c: ScheduleConfig) => void;
  editingConfig: ScheduleConfig | null;
}

export function ConfigPanel({
  configs,
  selectedConfigId,
  selectedConfig,
  configUnavails,
  personMap,
  onSelectConfig,
  onNewConfig,
  onEditConfig,
  onDeleteConfig,
  onAddUnavail,
  onEditUnavail,
  onDeleteUnavail,
  showUnavailForm,
  editingUnavail,
  onCloseUnavailForm,
  onSaveUnavail,
  showConfigForm,
  onCloseConfigForm,
  onSaveConfig,
  editingConfig,
}: ConfigPanelProps) {
  const { t } = i18n;

  function resolveUnavailabilityNames(unavail: PersonUnavailability): string {
    const personIds = Array.isArray(unavail.personIds) && unavail.personIds.length > 0
      ? unavail.personIds
      : (unavail.personId ? [unavail.personId] : []);
    if (personIds.length === 0) return '—';
    return personIds
      .map((personId) => {
        const person = personMap.get(personId);
        return person ? displayName(person) : fallbackEntityId(personId);
      })
      .join(', ');
  }

  return (
    <>
      {/* Config section */}
      <div class={`${s.card} ${s.mb24}`}>
        <div class={`${s.flexBetween} ${s.mb12}`}>
          <strong>{t('configTitle')}</strong>
          <div class={s.flexGapSm}>
            {selectedConfig && (
              <Button variant="ghost" onClick={() => onEditConfig(selectedConfig)}>
                {t('editConfig')}
              </Button>
            )}
            {selectedConfig && (
              <Button variant="danger" onClick={() => onDeleteConfig(selectedConfig)}>
                {t('deleteConfig')}
              </Button>
            )}
            <Button variant="secondary" onClick={onNewConfig}>
              + {t('newConfig')}
            </Button>
          </div>
        </div>

        {configs.length === 0 ? (
          <p class={`${s.text14} ${s.textMuted}`}>{t('noConfigYet')}</p>
        ) : (
          <select
            class={s.input}
            value={selectedConfigId}
            onChange={e => onSelectConfig((e.target as HTMLSelectElement).value)}
          >
            <option value="">{t('selectConfigFirst')}</option>
            {configs.map(c => (
              <option key={c.id} value={c.id}>
                {getScheduleConfigLabel(c)}
              </option>
            ))}
          </select>
        )}
        {selectedConfig && (
          <div class={`${s.text12} ${s.textMuted} ${s.mt8}`}>
            {getScheduleConfigSummary(selectedConfig)}
          </div>
        )}
      </div>

      {/* Unavailability section (per config) */}
      {selectedConfigId && (
        <div class={`${s.card} ${s.mb24}`}>
          <div class={`${s.flexBetween} ${s.mb12}`}>
            <strong>{t('unavailability')}</strong>
            <Button variant="secondary" onClick={onAddUnavail}>
              + {t('addUnavailability')}
            </Button>
          </div>
          {configUnavails.length === 0 ? (
            <p class={`${s.text14} ${s.textMuted}`}>—</p>
          ) : (
            <ResponsiveDataView
              items={configUnavails}
              columns={[
                { header: t('unavailPerson') },
                { header: t('unavailStart') },
                { header: t('unavailEnd') },
              ]}
              getKey={unavail => unavail.id}
              renderDesktopRow={unavail => {
                return (
                  <>
                    <td class={s.td}>{resolveUnavailabilityNames(unavail)}</td>
                    <td class={s.td}>{unavail.startDate}</td>
                    <td class={s.td}>{unavail.endDate}</td>
                  </>
                );
              }}
              renderMobileCard={unavail => {
                return (
                  <>
                    <div class={dataStyles.mobileHeader}>
                      <div class={dataStyles.mobileTitle}>
                        {resolveUnavailabilityNames(unavail)}
                      </div>
                    </div>
                    <div class={dataStyles.mobileFields}>
                      <ResponsiveDataField label={t('unavailStart')}>
                        {unavail.startDate}
                      </ResponsiveDataField>
                      <ResponsiveDataField label={t('unavailEnd')}>
                        {unavail.endDate}
                      </ResponsiveDataField>
                    </div>
                  </>
                );
              }}
              renderActions={unavail => (
                <>
                  <Button variant="ghost" onClick={() => onEditUnavail(unavail)}>{t('edit')}</Button>
                  <Button variant="danger" onClick={() => onDeleteUnavail(unavail.id)}>{t('delete')}</Button>
                </>
              )}
            />
          )}
        </div>
      )}

      {showUnavailForm && selectedConfigId && (
        <Dialog
          open={true}
          onClose={onCloseUnavailForm}
          closeOnOverlayClick={false}
          title={editingUnavail ? t('edit') : t('addUnavailability')}
        >
          <UnavailForm
            configId={selectedConfigId}
            initial={editingUnavail ?? undefined}
            onSave={onSaveUnavail}
            onCancel={onCloseUnavailForm}
          />
        </Dialog>
      )}

      {showConfigForm && (
        <Dialog
          open={true}
          onClose={onCloseConfigForm}
          closeOnOverlayClick={false}
          title={editingConfig ? t('editConfig') : t('newConfig')}
        >
          <ConfigForm
            initial={editingConfig ?? undefined}
            onSave={onSaveConfig}
            onCancel={onCloseConfigForm}
          />
        </Dialog>
      )}
    </>
  );
}
