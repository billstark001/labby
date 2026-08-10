export const SYSTEM_DEFAULT_TIMEZONE = '__default__';
export const EMAIL_TASK_TIMEZONE_SCHEDULE = '__schedule__';
export const EMAIL_TASK_TIMEZONE_SYSTEM = '__system__';

export interface TimezoneOption {
  value: string;
  label: string;
}

export interface TimezoneOptionGroup {
  label: string;
  options: TimezoneOption[];
}

export interface BuildTimezoneOptionGroupsOptions {
  defaultOption?: TimezoneOption;
  specialOptions?: TimezoneOption[];
  currentValue?: string;
  currentLabel?: string;
  now?: Date;
}

const COMMON_TIMEZONES: TimezoneOption[] = [
  { value: 'UTC', label: 'UTC' },
  { value: 'Etc/GMT+12', label: 'AOE (UTC-12)' },
  { value: 'Etc/GMT-14', label: 'UTC+14' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai' },
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'America/New_York', label: 'America/New_York' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
];

const FALLBACK_TIMEZONES = [
  'UTC',
  'Etc/GMT+12',
  'Etc/GMT-14',
  'Africa/Abidjan',
  'America/Los_Angeles',
  'America/New_York',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Europe/London',
];

function supportedTimeZones(): string[] {
  const intlWithSupportedValues = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[];
  };
  return intlWithSupportedValues.supportedValuesOf?.('timeZone') ?? FALLBACK_TIMEZONES;
}

export function isValidTimeZone(value: string | undefined | null): value is string {
  if (!value || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return isValidTimeZone(trimmed) ? trimmed : undefined;
}

export function getEnvironmentTimeZone(fallback = 'UTC'): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return normalizeTimeZone(resolved) ?? fallback;
}

function parseShortOffset(value: string): number | null {
  const normalized = value.replace(/^UTC/i, 'GMT');
  if (normalized === 'GMT') return 0;
  const match = normalized.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const hour = Number(match[2]);
  const minute = Number(match[3] ?? '0');
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return sign * (hour * 60 + minute);
}

export function getTimeZoneOffsetMinutes(timeZone: string, at: Date = new Date()): number | null {
  if (!isValidTimeZone(timeZone)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(at);
  const offsetPart = parts.find((part) => part.type === 'timeZoneName')?.value;
  return offsetPart ? parseShortOffset(offsetPart) : null;
}

function offsetLabel(offsetHours: number): string {
  if (offsetHours === 0) return 'GMT+0';
  return offsetHours > 0 ? `GMT+${offsetHours}` : `GMT${offsetHours}`;
}

function uniqueValidOptions(options: TimezoneOption[], seen: Set<string>): TimezoneOption[] {
  const out: TimezoneOption[] = [];
  for (const option of options) {
    if (!isValidTimeZone(option.value) || seen.has(option.value)) continue;
    seen.add(option.value);
    out.push(option);
  }
  return out;
}

export function buildTimezoneOptionGroups(options: BuildTimezoneOptionGroupsOptions = {}): TimezoneOptionGroup[] {
  const groups: TimezoneOptionGroup[] = [];
  const seen = new Set<string>();

  if (options.defaultOption || options.specialOptions?.length) {
    const systemOptions = [
      ...(options.defaultOption ? [options.defaultOption] : []),
      ...(options.specialOptions ?? []),
    ].filter((option) => !seen.has(option.value));
    for (const option of systemOptions) seen.add(option.value);
    if (systemOptions.length > 0) {
      groups.push({ label: 'Default', options: systemOptions });
    }
  }

  const common = uniqueValidOptions(COMMON_TIMEZONES, seen);
  if (common.length > 0) {
    groups.push({ label: 'Common', options: common });
  }

  const buckets = new Map<number, TimezoneOption[]>();
  for (let offset = -12; offset <= 12; offset += 1) {
    buckets.set(offset, []);
  }

  for (const value of supportedTimeZones()) {
    if (seen.has(value) || !isValidTimeZone(value)) continue;
    const offsetMinutes = getTimeZoneOffsetMinutes(value, options.now);
    if (offsetMinutes === null) continue;
    if (offsetMinutes % 60 !== 0) continue;
    const offsetHours = offsetMinutes / 60;
    const bucket = buckets.get(offsetHours);
    if (!bucket) continue;
    seen.add(value);
    bucket.push({ value, label: value });
  }

  for (let offset = -12; offset <= 12; offset += 1) {
    const values = buckets.get(offset) ?? [];
    values.sort((left, right) => left.label.localeCompare(right.label));
    if (values.length > 0) {
      groups.push({ label: offsetLabel(offset), options: values });
    }
  }

  const currentValue = options.currentValue?.trim();
  if (currentValue && !seen.has(currentValue)) {
    groups.push({
      label: 'Current',
      options: [{
        value: currentValue,
        label: options.currentLabel ?? currentValue,
      }],
    });
  }

  return groups;
}
