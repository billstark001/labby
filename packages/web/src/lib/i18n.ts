/**
 * i18n-runtime.ts — Reactive i18n for Preact + @preact/signals.
 *
 * - Language selection is persisted to / restored from localStorage.
 * - Calling `t()` inside a component render automatically subscribes that
 *   component to language changes — no extra wrapper needed.
 *
 * Deps: @preact/signals
 *
 * @example
 * // src/i18n.ts
 * import { en, zhCN } from './generated/translations'
 * import { createI18n } from './i18n-runtime'
 *
 * export const i18n = createI18n({ en, 'zh-CN': zhCN }, 'en')
 *
 * // SomeComponent.tsx
 * import { i18n } from '../i18n'
 * export function Greeting() {
 *   const { t, lang, setLang } = i18n.useTranslation()
 *   return <p lang={lang}>{t('greeting', { name: 'World' })}</p>
 * }
 */

import { computed, effect, signal } from '@preact/signals'
import type { Signal } from '@preact/signals'

// ─── Types ────────────────────────────────────────────────────────────────────

type Dict = Readonly<Record<string, string>>
type TranslationsMap<L extends string> = Record<L, Dict>

type TranslatorFunction = {
  (key: string, ...args: string[]): string
  (key: string, args: Record<string | number, string>): string
}

export interface I18nOptions {
  /**
   * Key used to read/write the language selection in localStorage.
   * @default 'i18n_lang'
   */
  storageKey?: string
}

export interface I18nInstance<L extends string> {
  /** Raw language signal — use directly for computed values or effects. */
  lang: Signal<L>

  /**
   * Translate a key.
   *
   * - `{placeholder}` tokens in the value are replaced by `vars`.
   * - Falls back to the key itself when no translation is found.
   * - Reactive: calling this inside a component render subscribes the component.
   */
  t: TranslatorFunction

  /** Change the active language. No-op for unknown tags. */
  setLang(lang: L): void

  /** All registered language tags. */
  langs: readonly L[]

  /** Hook for use inside Preact functional components. */
  useTranslation(): {
    t: I18nInstance<L>['t']
    /** Current language tag. Reading this in render subscribes the component. */
    lang: L
    setLang: I18nInstance<L>['setLang']
    langs: readonly L[]
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────


/**
 * 
 * @param template 
 * @param args 
 */
export function format(template: string, ...args: string[]): string;

/**
 * 
 * @param template 
 * @param args 
 */
export function format(template: string, args: Record<string | number, string>): string;

export function format(
  template: string,
  ...input: [Record<string | number, string>] | string[]
): string {
  const vars: Record<string, string> = {};
  if (input.length === 1 && typeof input[0] === 'object' && !Array.isArray(input[0])) {
    for (const [key, value] of Object.entries(input[0])) {
      vars[String(key)] = value;
    }
  } else {
    for (let index = 0; index < input.length; index += 1) {
      const value = input[index];
      if (typeof value === 'string') vars[String(index)] = value;
    }
  }

  return template.replace(/\{([^{}]+)\}/g, (_match, key: string) => vars[key] ?? '');
}

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* SSR, private browsing, quota, … */ }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a self-contained i18n instance.
 *
 * Call once per application (or per language namespace) and export the result.
 *
 * @param translations  Map of language tag → flat string dictionary.
 *                      Pass the named exports from the generated file directly.
 * @param defaultLang   Used at startup when localStorage has no valid value,
 *                      and as the fallback for keys missing in the active lang.
 * @param options       Optional runtime settings.
 */
export function createI18n<L extends string>(
  translations: TranslationsMap<L>,
  defaultLang: L,
  options: I18nOptions = {},
): I18nInstance<L> {
  const storageKey = options.storageKey ?? 'i18n_lang'
  const allLangs = Object.keys(translations) as L[]

  if (!allLangs.length) throw new Error('[i18n] translations map is empty')

  // Restore persisted language, validate it, fall back to default
  const stored = safeGet(storageKey) as L | null
  const initial: L = stored && allLangs.includes(stored) ? stored : defaultLang

  /** The source of truth for the active language. */
  const lang = signal<L>(initial)

  // Persist every change to localStorage (runs immediately on creation too)
  effect(() => safeSet(storageKey, lang.value))

  /**
   * Reactive dictionary — recomputed whenever `lang` changes.
   * Any component that calls `t()` during render will subscribe to this.
   */
  const dict = computed<Dict>(() => translations[lang.value] ?? translations[defaultLang])

  const t: TranslatorFunction = (key, ...vars) => {
    const raw = dict.value[key] ?? key
    if (!vars.length) return raw
    if (vars.length === 1 && typeof vars[0] === 'object') {
      return format(raw, vars[0] as Record<string | number, string>)
    }
    return format(raw, ...vars as string[])
  }

  function setLang(next: L): void {
    if (!allLangs.includes(next)) {
      console.warn(`[i18n] Unknown language "${next}". Valid: ${allLangs.join(', ')}`)
      return
    }
    lang.value = next
  }

  /**
   * Reading `lang.value` here (inside a component's call stack) registers
   * the component as a subscriber of the `lang` signal, so it re-renders
   * automatically on every language change without any extra boilerplate.
   */
  function useTranslation() {
    return {
      t,
      lang: lang.value,
      setLang,
      langs: allLangs as readonly L[],
    }
  }

  return { lang, t, setLang, langs: allLangs, useTranslation }
}