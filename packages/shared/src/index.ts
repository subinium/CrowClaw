export interface DurableObjectIdLike {
  toString(): string;
}

export interface DurableObjectStateLike {
  id: DurableObjectIdLike;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface D1StatementLike {
  first?<T>(): Promise<T | null>;
  all?<T>(): Promise<{ results: T[] }>;
  run?(): Promise<unknown>;
  bind(...values: unknown[]): {
    first<T>(): Promise<T | null>;
    all?<T>(): Promise<{ results: T[] }>;
    run(): Promise<unknown>;
  };
}

export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
}

export interface R2ObjectLike {
  text(): Promise<string>;
}

export interface R2BucketLike {
  put(key: string, value: string, options?: Record<string, unknown>): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
}

export { writeSecretAtomic, type WriteSecretAtomicOptions } from './atomic-secret-write.js';

// -- v0.9.1 i18n locale resources (#335) BEGIN --
export {
  t,
  useI18n,
  isI18nLocale,
  normalizeI18nLocale,
  setI18nAuditSink,
  getLocaleResource,
  localeCoverage,
  I18N_LOCALES,
  type I18nLocale,
  type LocaleResource,
  type I18nAuditEvent,
  type I18nAuditSink,
  type TranslateOptions,
} from './i18n.js';
// -- v0.9.1 i18n locale resources (#335) END --
