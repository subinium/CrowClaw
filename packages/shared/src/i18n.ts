// -- v0.9.1 i18n locale resources BEGIN --
//
// #335 (Hermes v0.13 parity): static gateway + CLI messages translate to 9
// locales — English, Korean, Chinese (Simplified), Japanese, German, Spanish,
// French, Ukrainian, Turkish. This module is the canonical message-resource
// layer: one JSON file per locale under `./locales/<locale>.json`, keyed by a
// stable dotted message ID, plus a `t(key, locale)` resolver with English
// fallback and an audit warning whenever a key (or a non-English translation)
// is missing.
//
// The prompt-builder in `@crowclaw/core` keeps its own self-contained directive
// table for prefix-cache stability and to avoid a build-time dependency on this
// package. CLI / gateway / dashboard surfaces are expected to thread `t()`
// here. See integration notes on `#335` for the wiring map.

import de from './locales/de.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };
import es from './locales/es.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };
import ja from './locales/ja.json' with { type: 'json' };
import ko from './locales/ko.json' with { type: 'json' };
import tr from './locales/tr.json' with { type: 'json' };
import uk from './locales/uk.json' with { type: 'json' };
import zh from './locales/zh.json' with { type: 'json' };

/**
 * The 9 locales CrowClaw ships user-facing strings for. Kept in sync with
 * `SupportedLocale` in `@crowclaw/core` (prompt-builder) — the two unions must
 * agree, but are intentionally declared independently so `@crowclaw/core` does
 * not take a build dependency on `@crowclaw/shared`.
 */
export type I18nLocale = 'en' | 'ko' | 'zh' | 'ja' | 'de' | 'es' | 'fr' | 'uk' | 'tr';

/** Ordered list of every supported locale. `en` is first (the fallback). */
export const I18N_LOCALES: readonly I18nLocale[] = [
  'en',
  'ko',
  'zh',
  'ja',
  'de',
  'es',
  'fr',
  'uk',
  'tr',
] as const;

/**
 * A locale's raw resource bundle: message-id -> string, plus a non-string
 * `$meta` block. Values are typed `unknown` so the `$meta` object coexists
 * with string entries without an unsafe cast; `t()` narrows with a runtime
 * `typeof === 'string'` check before returning.
 */
export type LocaleResource = Record<string, unknown>;

// JSON modules resolve to structurally-typed objects under `resolveJsonModule`.
// `Record<string, unknown>` is a safe widening (every JSON object satisfies it),
// so no `as unknown` double-cast is needed. The `$meta` block is retained in
// the raw bundle for tooling but is never returned by `t()`.
const RESOURCES: Record<I18nLocale, LocaleResource> = {
  en,
  ko,
  zh,
  ja,
  de,
  es,
  fr,
  uk,
  tr,
};

const FALLBACK_LOCALE: I18nLocale = 'en';

/** Type guard: is `value` one of the 9 supported locales. */
export const isI18nLocale = (value: unknown): value is I18nLocale =>
  typeof value === 'string' && (I18N_LOCALES as readonly string[]).includes(value);

/**
 * Coerce an arbitrary value (config field, `Accept-Language` header, body
 * field) to a supported locale. Exact matches win; otherwise the leading
 * subtag is matched case-insensitively (`zh-Hans` -> `zh`, `en-US` -> `en`).
 * Returns `fallback` (default `en`) when nothing matches.
 */
export const normalizeI18nLocale = (value: unknown, fallback: I18nLocale = FALLBACK_LOCALE): I18nLocale => {
  if (isI18nLocale(value)) return value;
  if (typeof value === 'string') {
    const subtag = value.toLowerCase().split(/[-_]/)[0];
    if (subtag && isI18nLocale(subtag)) return subtag;
  }
  return fallback;
};

/**
 * Audit event emitted whenever `t()` cannot resolve a key in the requested
 * locale and falls back. `reason` distinguishes a key that is missing in BOTH
 * the requested locale and English (`missing-key`, returns the raw key) from a
 * key that merely lacks a translation in the requested locale (`fallback`,
 * returns the English string).
 */
export interface I18nAuditEvent {
  key: string;
  locale: I18nLocale;
  reason: 'missing-key' | 'fallback';
}

/** Sink invoked for each fallback/missing-key event. */
export type I18nAuditSink = (event: I18nAuditEvent) => void;

const defaultAuditSink: I18nAuditSink = (event) => {
  // Surfaced on stderr with a stable prefix so log scrapers / the runtime
  // audit pipeline can route it. Never throws — translation must not crash a
  // request just because a string is untranslated.
  console.warn(
    `[crowclaw:i18n] ${event.reason} for key "${event.key}" in locale "${event.locale}"` +
      (event.reason === 'missing-key' ? ' (no English fallback; returning raw key)' : ' (using English fallback)'),
  );
};

let auditSink: I18nAuditSink = defaultAuditSink;

/**
 * Replace the audit sink (e.g. route i18n misses into the runtime security
 * audit log instead of stderr). Pass no argument to restore the default
 * stderr-warning sink. Returns the previously installed sink so callers can
 * restore it.
 */
export const setI18nAuditSink = (sink?: I18nAuditSink): I18nAuditSink => {
  const previous = auditSink;
  auditSink = sink ?? defaultAuditSink;
  return previous;
};

const interpolate = (template: string, vars?: Record<string, string | number>): string => {
  if (!vars) return template;
  let out = template;
  for (const [name, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${name}}`, String(value));
  }
  return out;
};

export interface TranslateOptions {
  /** Interpolation variables for `{name}` placeholders in the template. */
  vars?: Record<string, string | number>;
  /**
   * Override the audit sink for this single call. Useful in tests to capture
   * fallback events without mutating global state.
   */
  auditSink?: I18nAuditSink;
}

/**
 * Resolve a message `key` for `locale`. Resolution order:
 *   1. The requested locale's resource.
 *   2. English (`en`) — emits a `fallback` audit event.
 *   3. The raw key — emits a `missing-key` audit event.
 *
 * `locale` is normalized, so callers may pass a raw header/config value. The
 * `$meta` block in each JSON file is ignored — only string-valued keys
 * resolve.
 */
export const t = (
  key: string,
  locale: I18nLocale | string = FALLBACK_LOCALE,
  options?: TranslateOptions,
): string => {
  const resolved = normalizeI18nLocale(locale);
  const sink = options?.auditSink ?? auditSink;

  const direct = RESOURCES[resolved][key];
  if (typeof direct === 'string') {
    return interpolate(direct, options?.vars);
  }

  // Key is missing (or non-string, e.g. the `$meta` block) in the requested
  // locale. Try English. For `resolved === 'en'` this is the same lookup that
  // just failed, so it short-circuits straight to the hard-miss path below.
  if (resolved !== FALLBACK_LOCALE) {
    const english = RESOURCES[FALLBACK_LOCALE][key];
    if (typeof english === 'string') {
      sink({ key, locale: resolved, reason: 'fallback' });
      return interpolate(english, options?.vars);
    }
  }

  // Absent even in English (or a typo / unregistered key) — return the raw key
  // so the miss surfaces in the UI instead of an empty string, and audit it.
  sink({ key, locale: resolved, reason: 'missing-key' });
  return interpolate(key, options?.vars);
};

/**
 * Bind `t()` to a locale once, e.g. `const tr = useI18n(locale)`. Mirrors the
 * dashboard `useT` ergonomics.
 */
export const useI18n = (locale: I18nLocale | string) =>
  (key: string, vars?: Record<string, string | number>): string => t(key, locale, vars ? { vars } : undefined);

/** Read-only access to a locale's full resource map (for coverage tooling/tests). */
export const getLocaleResource = (locale: I18nLocale): LocaleResource => RESOURCES[locale];

/**
 * Per-locale key coverage relative to English. Used by `docs/i18n-coverage.md`
 * generation and the acceptance test that enforces >=80% coverage at ship.
 * `$meta` is excluded from the denominator.
 */
export const localeCoverage = (locale: I18nLocale): { translated: number; total: number; ratio: number } => {
  const englishKeys = Object.keys(RESOURCES[FALLBACK_LOCALE]).filter((k) => k !== '$meta');
  const resource = RESOURCES[locale];
  const translated = englishKeys.filter((k) => typeof resource[k] === 'string').length;
  const total = englishKeys.length;
  return { translated, total, ratio: total === 0 ? 1 : translated / total };
};

// -- v0.9.1 i18n locale resources END --
