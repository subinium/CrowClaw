import { translations, type Locale, type TranslationKey } from '../i18n/translations.js';

const STORAGE_KEY = 'crowclaw:locale';

export type { Locale, TranslationKey };

export const isLocale = (value: unknown): value is Locale =>
  value === 'en' || value === 'ko';

export const normalizeLocale = (value: unknown, fallback: Locale = 'en'): Locale => {
  if (isLocale(value)) return value;
  if (typeof value === 'string' && value.toLowerCase().startsWith('ko')) return 'ko';
  if (typeof value === 'string' && value.toLowerCase().startsWith('en')) return 'en';
  return fallback;
};

export const getStoredLocale = (): Locale => {
  const storage = globalThis.localStorage as Storage | undefined;
  const stored = typeof storage?.getItem === 'function' ? storage.getItem(STORAGE_KEY) : null;
  if (isLocale(stored)) return stored;
  return normalizeLocale(globalThis.navigator?.language, 'en');
};

export const setStoredLocale = (locale: Locale): void => {
  const storage = globalThis.localStorage as Storage | undefined;
  if (typeof storage?.setItem === 'function') {
    storage.setItem(STORAGE_KEY, locale);
  }
  if (globalThis.document?.documentElement) {
    globalThis.document.documentElement.lang = locale;
  }
  globalThis.window?.dispatchEvent(new CustomEvent('crowclaw:locale-change', { detail: { locale } }));
};

export const getCurrentLocale = (): Locale => {
  const docLocale = globalThis.document?.documentElement?.lang;
  return normalizeLocale(docLocale, getStoredLocale());
};

export const translate = (
  locale: Locale,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string => {
  let template = translations[locale][key] ?? translations.en[key] ?? key;
  if (!vars) return template;
  for (const [name, value] of Object.entries(vars)) {
    template = template.replaceAll(`{${name}}`, String(value));
  }
  return template;
};

export const useT = (locale: Locale) =>
  (key: TranslationKey, vars?: Record<string, string | number>): string =>
    translate(locale, key, vars);
