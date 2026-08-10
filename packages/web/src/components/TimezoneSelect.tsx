import {
  SYSTEM_DEFAULT_TIMEZONE,
  buildTimezoneOptionGroups,
  type TimezoneOption,
} from '@labby/core';

import * as s from '@/styles/components.css';

interface TimezoneSelectProps {
  value: string | undefined;
  onChange: (value: string) => void;
  defaultLabel: string;
  specialOptions?: TimezoneOption[];
  disabled?: boolean;
}

export function TimezoneSelect({
  value,
  onChange,
  defaultLabel,
  specialOptions,
  disabled,
}: TimezoneSelectProps) {
  const selectedValue = value || SYSTEM_DEFAULT_TIMEZONE;
  const groups = buildTimezoneOptionGroups({
    defaultOption: {
      value: SYSTEM_DEFAULT_TIMEZONE,
      label: defaultLabel,
    },
    specialOptions,
    currentValue: selectedValue,
  });

  return (
    <select
      class={s.input}
      value={selectedValue}
      disabled={disabled}
      onChange={(event) => onChange((event.target as HTMLSelectElement).value)}
    >
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
