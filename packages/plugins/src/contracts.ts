import type { Plugin } from '@crowclaw/core';

export interface MemoryBackendManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  repo?: string;
  defaultConfigSchema?: Record<string, unknown>;
  hooks?: string[];
  tools?: string[];
  memoryBackend: true;
  permissions?: {
    tools?: string[];
    memory?: 'none' | 'read' | 'write' | 'readwrite';
    network?: boolean;
  };
}

export interface MemoryBackendProvider {
  recall(sessionId: string, query: string, limit: number, scope?: string, scopeKey?: string): Promise<unknown[]>;
  store(record: Record<string, unknown>): Promise<unknown>;
  delete(id: string): Promise<boolean>;
  list(sessionId: string, scope?: string, limit?: number): Promise<unknown[]>;
  init?(config?: Record<string, unknown>): Promise<void>;
  prefetch?(sessionId: string, query: string, limit: number): Promise<unknown[]>;
  sync_turn?(sessionId: string, summary: string, metadata?: Record<string, unknown>): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface MemoryBackendPlugin extends Plugin {
  kind: 'memory-backend';
  manifest: MemoryBackendManifest;
  provider: MemoryBackendProvider;
}
