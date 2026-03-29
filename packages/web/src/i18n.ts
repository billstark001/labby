import { en, jaJP, zhCN } from './generated/translations.js';
import type { TranslationKey } from './generated/translations.js';
import { createI18n } from './lib/i18n.js';

export type Locale = 'en' | 'zh-CN' | 'ja-JP';
export type UIStrings = Record<TranslationKey, string>;

const dictionaries: Record<Locale, UIStrings> = {
  en,
  'zh-CN': zhCN,
  'ja-JP': jaJP,
};

export const i18n = createI18n<Locale>(dictionaries, 'en', { storageKey: 'locale' });
/** Get localized display name for any entity. */

export function displayName(
  entity: { id?: string; name?: string; names?: Record<string, string>; }
): string {
  const locale = i18n.lang.value;
  const languageKey = locale === 'zh-CN' ? 'zh' : locale === 'ja-JP' ? 'ja' : 'en';
  const names = entity.names ?? {};
  const localized = names[languageKey]?.trim();
  if (localized) return localized;

  const english = names.en?.trim() ?? entity.name?.trim();
  if (english) return english;

  const anyLanguage = Object.values(names).map(v => v.trim()).find(Boolean);
  if (anyLanguage) return anyLanguage;

  return fallbackEntityId(entity.id);
}

export function fallbackEntityId(id?: string): string {
  return `ID:${id ?? '<empty>'}`;
}
