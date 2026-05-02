import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';

export interface SecretSource {
  name: string;
  load(key: string): Promise<string | undefined>;
}

export interface SecretReferenceSource extends SecretSource {
  loadReference?(ref: string, key: string): Promise<string | undefined>;
}

export interface SecretChainOptions {
  env?: Record<string, string | undefined>;
}

const SECRET_REF_PREFIX = 'CROWCLAW_SECRET_REF_';

function runtimeEnv(): Record<string, string | undefined> {
  return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

function trimSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isSecretReference(value: string): boolean {
  return /^(op|sops|file|env|systemd):/i.test(value);
}

function safeJoinFile(dir: string, key: string): string | null {
  if (!/^[A-Z0-9_][A-Z0-9_.-]*$/i.test(key)) return null;
  const base = resolve(dir);
  const path = resolve(base, key);
  if (path !== base && path.startsWith(base + sep)) return path;
  return null;
}

export function envSource(env: Record<string, string | undefined> = runtimeEnv()): SecretSource {
  return {
    name: 'env',
    async load(key: string): Promise<string | undefined> {
      return trimSecret(env[`${SECRET_REF_PREFIX}${key}`] ?? env[key]);
    },
  };
}

export function filesSource(dir: string): SecretSource {
  return {
    name: 'files',
    async load(key: string): Promise<string | undefined> {
      const path = safeJoinFile(dir, key);
      if (!path) return undefined;
      try {
        return trimSecret(await readFile(path, 'utf-8'));
      } catch {
        return undefined;
      }
    },
  };
}

export function systemdCredsSource(env: Record<string, string | undefined> = runtimeEnv()): SecretSource {
  const dir = env.CREDENTIALS_DIRECTORY;
  return {
    name: 'systemd-creds',
    async load(key: string): Promise<string | undefined> {
      if (!dir) return undefined;
      return filesSource(dir).load(key);
    },
  };
}

export interface OnePasswordSourceOptions {
  readRef?: (ref: string) => Promise<string | undefined>;
}

export interface SopsSourceOptions {
  decrypt?: (file: string, extract?: string) => Promise<string | undefined>;
}

export function onePasswordSource(options: OnePasswordSourceOptions = {}): SecretReferenceSource {
  return {
    name: '1password',
    async load(): Promise<string | undefined> {
      return undefined;
    },
    async loadReference(ref: string): Promise<string | undefined> {
      if (!ref.startsWith('op://')) return undefined;
      if (options.readRef) {
        return trimSecret(await options.readRef(ref));
      }
      const result = spawnSync('op', ['read', ref], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.error) {
        throw new Error(`Unable to read 1Password secret reference ${ref}: ${result.error.message}`);
      }
      if (result.status !== 0) {
        const detail = trimSecret(result.stderr) ?? `exit ${result.status ?? 'unknown'}`;
        throw new Error(`Unable to read 1Password secret reference ${ref}: ${detail}`);
      }
      return trimSecret(result.stdout);
    },
  };
}

function parseSopsReference(ref: string): { file: string; extract?: string } {
  const spec = ref.slice('sops:'.length).trim();
  if (!spec) throw new Error('SOPS secret reference is missing a file path');
  const [filePart, selectorPart] = spec.split('#', 2);
  const file = filePart?.trim();
  if (!file) throw new Error('SOPS secret reference is missing a file path');
  const selector = selectorPart?.trim();
  if (!selector) return { file };
  if (selector.startsWith('[')) return { file, extract: selector };
  const path = selector
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  if (path.length === 0) return { file };
  return { file, extract: JSON.stringify(path) };
}

export function sopsSource(options: SopsSourceOptions = {}): SecretReferenceSource {
  return {
    name: 'sops',
    async load(): Promise<string | undefined> {
      return undefined;
    },
    async loadReference(ref: string): Promise<string | undefined> {
      if (!ref.startsWith('sops:')) return undefined;
      const { file, extract } = parseSopsReference(ref);
      if (options.decrypt) {
        return trimSecret(await options.decrypt(file, extract));
      }
      const args = ['-d'];
      if (extract) args.push('--extract', extract);
      args.push(file);
      const result = spawnSync('sops', args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.error) {
        throw new Error(`Unable to read SOPS secret reference ${ref}: ${result.error.message}`);
      }
      if (result.status !== 0) {
        const detail = trimSecret(result.stderr) ?? `exit ${result.status ?? 'unknown'}`;
        throw new Error(`Unable to read SOPS secret reference ${ref}: ${detail}`);
      }
      return trimSecret(result.stdout);
    },
  };
}

export class SecretChain {
  constructor(private readonly sources: SecretReferenceSource[]) {}

  async resolve(key: string): Promise<string | undefined> {
    for (const source of this.sources) {
      const loaded = await source.load(key);
      if (!loaded) continue;
      return this.resolveValue(loaded, key);
    }
    return undefined;
  }

  async resolveValue(value: string, key = 'secret'): Promise<string> {
    const trimmed = trimSecret(value);
    if (!trimmed) return '';
    if (!isSecretReference(trimmed)) return trimmed;

    if (trimmed.startsWith('env:')) {
      const envKey = trimmed.slice('env:'.length);
      const valueFromEnv = trimSecret(runtimeEnv()[envKey]);
      if (!valueFromEnv) throw new Error(`Secret reference ${trimmed} for ${key} was not set`);
      return valueFromEnv;
    }

    if (trimmed.startsWith('file:')) {
      const path = trimmed.slice('file:'.length);
      const fileValue = trimSecret(await readFile(path, 'utf-8'));
      if (!fileValue) throw new Error(`Secret reference ${trimmed} for ${key} was empty`);
      return fileValue;
    }

    if (trimmed.startsWith('systemd:')) {
      const credentialName = trimmed.slice('systemd:'.length);
      const dir = runtimeEnv().CREDENTIALS_DIRECTORY;
      if (!dir) throw new Error(`Secret reference ${trimmed} for ${key} requires CREDENTIALS_DIRECTORY`);
      const path = safeJoinFile(dir, credentialName);
      if (!path) throw new Error(`Invalid systemd credential name: ${credentialName}`);
      const valueFromFile = trimSecret(await readFile(path, 'utf-8'));
      if (!valueFromFile) throw new Error(`Secret reference ${trimmed} for ${key} was empty`);
      return valueFromFile;
    }

    for (const source of this.sources) {
      const resolved = await source.loadReference?.(trimmed, key);
      if (resolved) return resolved;
    }
    throw new Error(`Unsupported secret reference for ${key}: ${trimmed}`);
  }
}

export function createDefaultSecretChain(env: Record<string, string | undefined> = runtimeEnv()): SecretChain {
  const sources: SecretReferenceSource[] = [envSource(env) as SecretReferenceSource];
  if (env.CROWCLAW_SECRETS_DIR) {
    sources.push(filesSource(env.CROWCLAW_SECRETS_DIR) as SecretReferenceSource);
  }
  if (env.CREDENTIALS_DIRECTORY) {
    sources.push(systemdCredsSource(env) as SecretReferenceSource);
  }
  sources.push(sopsSource());
  sources.push(onePasswordSource());
  return new SecretChain(sources);
}

export async function resolveSecret(key: string, options: SecretChainOptions = {}): Promise<string | undefined> {
  return createDefaultSecretChain(options.env).resolve(key);
}

export async function resolveSecretFileRef(dir: string, key: string): Promise<string | undefined> {
  return filesSource(join(dir)).load(key);
}
