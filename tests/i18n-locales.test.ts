// ---------------------------------------------------------------------------
// #335 (Hermes v0.13 parity) — expand SupportedLocale beyond en/ko.
//
// Acceptance criteria covered here:
//   - All 9 locales resolve a key through `t()`.
//   - Missing key falls back to English AND emits an audit warning.
//   - A key absent even in English returns the raw key (hard miss) + warns.
//   - `SupportedLocale` (core) accepts all 9 locales.
//   - prompt-builder en/ko directive output stays byte-identical to v0.9.0.
//   - The 7 new locales emit a localized response-language directive.
//   - Coverage: every locale has >= 80% key coverage vs English.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';

import {
  t,
  useI18n,
  isI18nLocale,
  normalizeI18nLocale,
  setI18nAuditSink,
  getLocaleResource,
  localeCoverage,
  I18N_LOCALES,
  type I18nLocale,
  type I18nAuditEvent,
} from '@crowclaw/shared';
import { buildSystemPrompt, normalizeLocale, type SupportedLocale } from '@crowclaw/core';

const ALL_LOCALES: I18nLocale[] = ['en', 'ko', 'zh', 'ja', 'de', 'es', 'fr', 'uk', 'tr'];

describe('#335 i18n shared resources', () => {
  it('ships exactly the 9 supported locales in declared order', () => {
    expect([...I18N_LOCALES]).toEqual(ALL_LOCALES);
    expect(I18N_LOCALES[0]).toBe('en'); // English is the fallback locale
  });

  it('resolves a known key for every one of the 9 locales', () => {
    const events: I18nAuditEvent[] = [];
    const sink = (event: I18nAuditEvent) => events.push(event);
    for (const locale of ALL_LOCALES) {
      const value = t('gateway.session.notFound', locale, { auditSink: sink });
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
    // Every locale has this key translated, so no fallback should have fired.
    expect(events).toHaveLength(0);
  });

  it('returns the native translation, not the English string, for non-en locales', () => {
    expect(t('gateway.session.notFound', 'en')).toBe('Session not found.');
    expect(t('gateway.session.notFound', 'ko')).toBe('세션을 찾을 수 없습니다.');
    expect(t('gateway.session.notFound', 'ja')).toBe('セッションが見つかりません。');
    expect(t('gateway.session.notFound', 'de')).toBe('Sitzung nicht gefunden.');
    // Each non-en translation must differ from English.
    for (const locale of ALL_LOCALES.filter((l) => l !== 'en')) {
      expect(t('gateway.session.notFound', locale)).not.toBe('Session not found.');
    }
  });

  it('interpolates {var} placeholders', () => {
    const value = t('prompt.responseLanguage.default', 'en', { vars: { language: 'English' } });
    expect(value).toBe('- Respond in English by default.');
  });

  it('prefers the locale translation over English when both exist (no fallback event)', () => {
    const events: I18nAuditEvent[] = [];
    const value = t('gateway.session.notFound', 'ko', { auditSink: (e) => events.push(e) });
    expect(value).toBe('세션을 찾을 수 없습니다.');
    expect(events).toHaveLength(0);
  });

  it('emits a fallback audit event (not a hard miss) for a key present in English but absent in the locale', () => {
    // Inject a key into the live English resource bundle that no other locale
    // has, then resolve it from a non-en locale: the resolver must return the
    // English string and emit a `fallback` event (not `missing-key`).
    const en = getLocaleResource('en');
    const FALLBACK_PROBE = '__test.fallback.probe__';
    (en as Record<string, unknown>)[FALLBACK_PROBE] = 'English-only value';
    try {
      const events: I18nAuditEvent[] = [];
      const value = t(FALLBACK_PROBE, 'de', { auditSink: (e) => events.push(e) });
      expect(value).toBe('English-only value');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ key: FALLBACK_PROBE, locale: 'de', reason: 'fallback' });
    } finally {
      delete (en as Record<string, unknown>)[FALLBACK_PROBE];
    }
  });

  it('returns the raw key and warns (missing-key) when a key is absent in both the locale and English', () => {
    const events: I18nAuditEvent[] = [];
    const value = t('does.not.exist', 'de', { auditSink: (e) => events.push(e) });
    expect(value).toBe('does.not.exist'); // raw key returned on hard miss
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: 'does.not.exist', locale: 'de', reason: 'missing-key' });
  });

  it('returns the raw key and warns when the key is missing even in English', () => {
    const events: I18nAuditEvent[] = [];
    const value = t('totally.unknown.key', 'en', { auditSink: (e) => events.push(e) });
    expect(value).toBe('totally.unknown.key');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: 'totally.unknown.key', locale: 'en', reason: 'missing-key' });
  });

  it('uses the global audit sink (console.warn) by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      t('totally.unknown.key', 'fr');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('[crowclaw:i18n]');
    } finally {
      warn.mockRestore();
    }
  });

  it('allows swapping the global audit sink and restoring it', () => {
    const captured: I18nAuditEvent[] = [];
    const previous = setI18nAuditSink((e) => captured.push(e));
    try {
      t('totally.unknown.key', 'es');
      expect(captured).toHaveLength(1);
      expect(captured[0]?.locale).toBe('es');
    } finally {
      setI18nAuditSink(previous);
    }
  });

  it('normalizes raw header/config values to a supported locale', () => {
    expect(normalizeI18nLocale('zh-Hans')).toBe('zh');
    expect(normalizeI18nLocale('en-US')).toBe('en');
    expect(normalizeI18nLocale('ko_KR')).toBe('ko');
    expect(normalizeI18nLocale('uk')).toBe('uk');
    expect(normalizeI18nLocale('xx')).toBe('en'); // unknown -> fallback
    expect(normalizeI18nLocale(undefined)).toBe('en');
    expect(normalizeI18nLocale(42)).toBe('en');
    expect(normalizeI18nLocale('fr', 'de')).toBe('fr'); // exact wins over custom fallback
    expect(normalizeI18nLocale('zz', 'de')).toBe('de'); // custom fallback honored
  });

  it('isI18nLocale guards correctly', () => {
    expect(isI18nLocale('tr')).toBe(true);
    expect(isI18nLocale('en')).toBe(true);
    expect(isI18nLocale('xx')).toBe(false);
    expect(isI18nLocale(null)).toBe(false);
    expect(isI18nLocale(123)).toBe(false);
  });

  it('t() coerces a raw locale string and a missing locale argument', () => {
    expect(t('cli.welcome', 'ja-JP')).toBe(t('cli.welcome', 'ja'));
    expect(t('cli.welcome')).toBe(t('cli.welcome', 'en')); // default locale = en
    expect(t('cli.welcome', 'zz')).toBe(t('cli.welcome', 'en')); // unknown -> en
  });

  it('every locale has >= 80% key coverage vs English (acceptance criterion)', () => {
    for (const locale of ALL_LOCALES) {
      const { ratio, translated, total } = localeCoverage(locale);
      expect(total).toBeGreaterThan(0);
      expect(ratio, `${locale} coverage ${translated}/${total}`).toBeGreaterThanOrEqual(0.8);
    }
    // The two original locales are fully covered.
    expect(localeCoverage('en').ratio).toBe(1);
    expect(localeCoverage('ko').ratio).toBe(1);
  });

  it('exposes locale metadata and never returns $meta as a translatable key', () => {
    for (const locale of ALL_LOCALES) {
      const resource = getLocaleResource(locale);
      const meta = resource['$meta'];
      expect(meta && typeof meta === 'object').toBe(true);
    }
    // $meta is an object, not a string -> t() treats it as a hard miss and
    // returns the raw key rather than leaking the metadata object.
    const events: I18nAuditEvent[] = [];
    expect(t('$meta', 'en', { auditSink: (e) => events.push(e) })).toBe('$meta');
    expect(events[0]?.reason).toBe('missing-key');
  });

  it('useI18n binds a locale and interpolates', () => {
    const tr = useI18n('en');
    expect(tr('prompt.responseLanguage.default', { language: 'English' })).toBe(
      '- Respond in English by default.',
    );
  });
});

describe('#335 prompt-builder locale directive', () => {
  it('SupportedLocale accepts all 9 locales (compile-time + runtime)', () => {
    const locales: SupportedLocale[] = ['en', 'ko', 'zh', 'ja', 'de', 'es', 'fr', 'uk', 'tr'];
    expect(locales).toHaveLength(9);
    // normalizeLocale returns a SupportedLocale; every shipped locale round-trips.
    for (const locale of locales) {
      const normalized: SupportedLocale = normalizeLocale(locale);
      expect(normalized).toBe(locale);
    }
  });

  it('normalizeLocale stays backward compatible: unknown -> en, header tags resolve', () => {
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('ko')).toBe('ko');
    expect(normalizeLocale(undefined)).toBe('en');
    expect(normalizeLocale('klingon')).toBe('en');
    expect(normalizeLocale('zh-Hans')).toBe('zh');
    expect(normalizeLocale('de-DE')).toBe('de');
  });

  it('keeps en/ko directive output byte-identical to v0.9.0', () => {
    const enPrompt = buildSystemPrompt({ basePrompt: 'You are CrowClaw.', locale: 'en' });
    const koPrompt = buildSystemPrompt({ basePrompt: 'You are CrowClaw.', locale: 'ko' });

    const enDirective = [
      'Response language:',
      '- Respond in English by default.',
      '- Keep code, commands, file paths, identifiers, API names, and quoted source text in their original language.',
      '- If the user explicitly asks for another language, follow the user request for that turn.',
    ].join('\n');
    const koDirective = [
      'Response language:',
      '- Respond in Korean by default.',
      '- Keep code, commands, file paths, identifiers, API names, and quoted source text in their original language.',
      '- If the user explicitly asks for another language, follow the user request for that turn.',
    ].join('\n');

    expect(enPrompt).toContain(enDirective);
    expect(koPrompt).toContain(koDirective);
  });

  it('emits a localized response-language directive for each new locale', () => {
    const expectations: Record<Exclude<SupportedLocale, 'en' | 'ko'>, { heading: string; default: string }> = {
      zh: { heading: '回复语言：', default: '- 默认使用Chinese回复。' },
      ja: { heading: '応答言語:', default: '- 既定ではJapaneseで応答してください。' },
      de: { heading: 'Antwortsprache:', default: '- Antworte standardmäßig auf German.' },
      es: { heading: 'Idioma de respuesta:', default: '- Responde en Spanish de forma predeterminada.' },
      fr: { heading: 'Langue de réponse :', default: '- Réponds en French par défaut.' },
      uk: { heading: 'Мова відповіді:', default: '- За замовчуванням відповідай Ukrainian.' },
      tr: { heading: 'Yanıt dili:', default: '- Varsayılan olarak Turkish yanıt ver.' },
    };

    for (const [locale, expected] of Object.entries(expectations)) {
      const prompt = buildSystemPrompt({ basePrompt: 'You are CrowClaw.', locale: locale as SupportedLocale });
      expect(prompt, `prompt for ${locale}`).toContain(expected.heading);
      expect(prompt, `default line for ${locale}`).toContain(expected.default);
    }
  });

  it('omits the directive entirely when no locale is provided (unchanged)', () => {
    const prompt = buildSystemPrompt({ basePrompt: 'You are CrowClaw.' });
    expect(prompt).not.toContain('Response language:');
  });
});
