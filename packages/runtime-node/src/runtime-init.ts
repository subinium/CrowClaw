import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
import {
  buildPersonaPrompt,
  loadPersonaFiles,
  loadSkillsFromDirectory,
  PersonaRegistry,
  type ContextEngineResult,
  type SkillFileSystem,
} from '@crowclaw/core';
import { getBuiltInSkills, SkillRegistry } from '@crowclaw/learning';
import {
  EmbeddingMemoryStore,
  FileFrozenStore,
  FrozenMemory,
  type EmbeddingProvider,
} from '@crowclaw/memory';
import { CredentialPool } from '@crowclaw/providers';
import { InMemorySchedulerStore, FileSchedulerStore } from '@crowclaw/scheduler';
import { InMemoryMemoryStore, InMemoryMessageStore, type MessageStore as MessageStoreInterface } from '@crowclaw/storage';
import { FileWorkspaceStore, InMemoryWorkspaceStore } from '@crowclaw/workspace';
import { RuntimeConfigStore, FileConfigStore } from './config-store.js';
import { ContextEngine } from '@crowclaw/core';
import type { NodeRuntimeOptions } from './runtime-support.js';

export function getRuntimeEnv(): Record<string, string | undefined> {
  return (globalThis as Record<string, unknown>).process
    ? ((globalThis as Record<string, unknown>).process as { env: Record<string, string | undefined> }).env
    : {};
}

export function getRuntimeDataDir(options: NodeRuntimeOptions, runtimeEnv: Record<string, string | undefined>): string {
  return options.dataDir ?? runtimeEnv.CROWCLAW_DATA_DIR ?? joinPath(homedir(), '.crowclaw');
}

export function createRuntimeMemoryStore(options: NodeRuntimeOptions): {
  baseMemoryStore: InMemoryMemoryStore;
  memoryStore: InMemoryMemoryStore | EmbeddingMemoryStore;
} {
  const useEmbeddingMemory = options.useEmbeddingMemory ?? true;
  const baseMemoryStore = options.memoryStore ?? new InMemoryMemoryStore();
  if (!useEmbeddingMemory || options.memoryStore) {
    return { baseMemoryStore, memoryStore: baseMemoryStore };
  }

  const simpleEmbeddingProvider: EmbeddingProvider = {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(text => {
        const words = text.toLowerCase().split(/\s+/);
        const vec = new Array(128).fill(0) as number[];
        for (const word of words) {
          for (let i = 0; i < word.length; i++) {
            const index = (word.charCodeAt(i) * 31 + i) % 128;
            vec[index] = (vec[index] ?? 0) + 1;
          }
        }
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
        return vec.map(v => v / norm);
      });
    },
  };

  return {
    baseMemoryStore,
    memoryStore: new EmbeddingMemoryStore({
      baseStore: baseMemoryStore,
      embeddingProvider: simpleEmbeddingProvider,
      similarityThreshold: 0.3,
    }),
  };
}

export function createRuntimeWorkspaceStore(options: NodeRuntimeOptions) {
  return options.workspaceStore
    ?? (options.workspaceDir
      ? new FileWorkspaceStore(options.workspaceDir)
      : new InMemoryWorkspaceStore());
}

export function createRuntimeSchedulerStore(options: NodeRuntimeOptions, dataDir: string) {
  if (options.schedulerStore) return options.schedulerStore;
  if (options.schedulerStorePath === null) return new InMemorySchedulerStore();
  const schedulerPath = options.schedulerStorePath ?? joinPath(dataDir, 'scheduler-jobs.json');
  return new FileSchedulerStore(schedulerPath);
}

export function createRuntimeConfigStore(options: NodeRuntimeOptions, dataDir: string, isVitest: boolean): RuntimeConfigStore {
  const defaultConfigPath = joinPath(dataDir, 'runtime-config.json');
  const configStore =
    options.configStorePath === null || (isVitest && options.configStorePath === undefined)
      ? new RuntimeConfigStore()
      : new FileConfigStore(options.configStorePath ?? defaultConfigPath);

  if (configStore instanceof FileConfigStore) {
    void configStore.load();
  }
  if ('initialProviderConfig' in options) {
    configStore.setProviderConfig(options.initialProviderConfig ?? null);
  }
  return configStore;
}

export function createFrozenMemoryState(dataDir: string): {
  messageStore: MessageStoreInterface;
  frozenMemory: FrozenMemory;
  frozenUserProfile: FrozenMemory;
  frozenMemoryReady: Promise<unknown[]>;
} {
  const messageStore: MessageStoreInterface = new InMemoryMessageStore();
  const frozenMemoryStore = new FileFrozenStore(joinPath(dataDir, 'memory'));
  const frozenMemory = new FrozenMemory(frozenMemoryStore, 'MEMORY');
  const frozenUserProfile = new FrozenMemory(frozenMemoryStore, 'USER');
  return {
    messageStore,
    frozenMemory,
    frozenUserProfile,
    frozenMemoryReady: Promise.all([
      frozenMemory.load().catch(() => {}),
      frozenUserProfile.load().catch(() => {}),
    ]),
  };
}

export function createContextEngineState(options: NodeRuntimeOptions): {
  contextEngineReady: Promise<void>;
  getContextEngineResult: () => ContextEngineResult | null;
  clearContextRefresh: () => void;
} {
  let contextEngineResult: ContextEngineResult | null = null;
  let contextEngineReady: Promise<void> = Promise.resolve();
  let contextRefresh: ReturnType<typeof setInterval> | null = null;
  const workingDir = (options as Record<string, unknown>).workingDirectory as string | undefined;
  if (workingDir) {
    const engine = new ContextEngine({ workingDirectory: workingDir });
    contextEngineReady = engine.discover().then((result) => {
      contextEngineResult = result;
    }).catch(() => {});
    contextRefresh = setInterval(() => {
      engine.discover().then((result) => {
        contextEngineResult = result;
      }).catch(() => {});
    }, 60_000);
    if (typeof contextRefresh === 'object' && contextRefresh !== null && 'unref' in contextRefresh) {
      (contextRefresh as { unref(): void }).unref();
    }
  }
  return {
    contextEngineReady,
    getContextEngineResult: () => contextEngineResult,
    clearContextRefresh: () => {
      if (contextRefresh) clearInterval(contextRefresh);
      contextRefresh = null;
    },
  };
}

export function loadRuntimeSkills(
  skillRegistry: SkillRegistry,
  options: NodeRuntimeOptions,
  runtimeEnv: Record<string, string | undefined>,
): void {
  skillRegistry.loadBuiltIn(getBuiltInSkills());
  void skillRegistry.refreshLearned();
  const skillDir = options.skillDir ?? runtimeEnv.CROWCLAW_SKILL_DIR;
  if (!skillDir) return;

  const nodeSkillFs: SkillFileSystem = options.skillFs ?? {
    async readDir(dirPath: string) {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries.map((entry: { name: string; isDirectory(): boolean }) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
    },
    async readFile(filePath: string) {
      const { readFile: fsRead } = await import('node:fs/promises');
      return fsRead(filePath, 'utf-8');
    },
    joinPath(...parts: string[]) {
      return parts.join('/').replace(/\/+/g, '/');
    },
  };
  void loadSkillsFromDirectory(skillDir, nodeSkillFs).then(
    (localSkills) => skillRegistry.setLocalSkills(localSkills),
    () => {},
  );
}

export function createPersonaState(
  personaRegistry: PersonaRegistry,
  options: NodeRuntimeOptions,
  runtimeEnv: Record<string, string | undefined>,
): {
  getPersonaPrompt: () => string | undefined;
  setPersonaPrompt: (value: string | undefined) => void;
} {
  let personaPrompt: string | undefined;
  const personaDir = options.personaDir ?? runtimeEnv.CROWCLAW_PERSONA_DIR;
  if (personaDir && options.personaFs) {
    void loadPersonaFiles(personaDir, options.personaFs).then(
      (files) => {
        personaPrompt = buildPersonaPrompt(files) || undefined;
        if (personaPrompt) {
          personaRegistry.register('default', files);
        }
      },
      () => {},
    );
  }
  return {
    getPersonaPrompt: () => personaPrompt,
    setPersonaPrompt: (value) => { personaPrompt = value; },
  };
}

export function collectProviderKeysFromEnv(runtimeEnv: Record<string, string | undefined>, prefix: string): string[] {
  const direct = runtimeEnv[prefix];
  const numbered = Object.entries(runtimeEnv)
    .filter(([key, value]) => key.startsWith(`${prefix}_`) && typeof value === 'string' && value.trim().length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value!.trim());
  return [
    ...(typeof direct === 'string' && direct.trim().length > 0 ? [direct.trim()] : []),
    ...numbered,
  ];
}

export function summarizeProviderPoolFromEnv(runtimeEnv: Record<string, string | undefined>, providerName: string) {
  const normalized = providerName.toLowerCase();
  const prefix = normalized === 'openai'
    ? 'OPENAI_API_KEY'
    : normalized === 'anthropic'
      ? 'ANTHROPIC_API_KEY'
      : 'OPENROUTER_API_KEY';
  const keys = collectProviderKeysFromEnv(runtimeEnv, prefix);
  if (keys.length === 0) {
    return {
      provider: normalized,
      configured: false,
      strategy: 'round-robin',
      total: 0,
      active: 0,
      coolingDown: 0,
      disabled: 0,
      status: [],
    };
  }
  const pool = new CredentialPool({ keys, strategy: 'round-robin' });
  return {
    provider: normalized,
    configured: true,
    ...pool.summary(),
  };
}
