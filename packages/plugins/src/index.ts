/**
 * Backward-compat shim for `@crowclaw/plugins`.
 *
 * Issue #158 moved the canonical plugin contract + `PluginManager` into
 * `@crowclaw/core` to fix the layering inversion (core was depending on
 * plugins). Existing consumers that import from `@crowclaw/plugins` keep
 * working — every symbol below is a re-export from core.
 *
 * New code should prefer `import { PluginManager, ... } from '@crowclaw/core'`.
 */

import type { Plugin, PluginContext, ToolResultTransform, PreToolCallVeto } from '@crowclaw/core';
import type { MemoryBackendPlugin, MemoryBackendProvider } from './contracts.js';

export {
  PluginManager,
  MemoryCapturePlugin,
} from '@crowclaw/core';
export type {
  MemoryBackendManifest,
  MemoryBackendPlugin,
  MemoryBackendProvider,
} from './contracts.js';

export type {
  Plugin,
  PluginContext,
  PluginHookName,
  PluginHookPayloads,
  PluginInvocationName,
  PluginInvocationPayloads,
  PreToolCallVeto,
  ToolResultTransform,
} from '@crowclaw/core';

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  repo?: string;
  defaultConfigSchema?: Record<string, unknown>;
  hooks?: string[];
  tools?: string[];
  memoryBackend?: boolean;
  permissions?: {
    tools?: string[];
    memory?: 'none' | 'read' | 'write' | 'readwrite';
    network?: boolean;
  };
}

export interface PluginCatalogEntry {
  manifest: PluginManifest;
  plugin: Plugin;
}

export interface PluginValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const UNSAFE_PLUGIN_TOOLS = new Set(['terminal.exec', 'terminal.background', 'git.commit', 'git.branch']);

export function validatePluginManifest(manifest: Partial<PluginManifest> | null | undefined): PluginValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest is missing or not an object'], warnings };
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push('name is required');
  } else if (!PLUGIN_NAME_RE.test(manifest.name)) {
    errors.push('name must be a safe plugin slug');
  }
  if (manifest.version !== undefined && typeof manifest.version !== 'string') {
    errors.push('version must be a string');
  }
  const declaredTools = [...(manifest.tools ?? []), ...(manifest.permissions?.tools ?? [])];
  for (const tool of declaredTools) {
    if (typeof tool !== 'string' || tool.trim() === '') {
      errors.push('tools must contain only non-empty strings');
    } else if (UNSAFE_PLUGIN_TOOLS.has(tool)) {
      errors.push(`plugin manifest may not request raw command tool: ${tool}`);
    }
  }
  if (manifest.hooks && !Array.isArray(manifest.hooks)) {
    errors.push('hooks must be an array');
  }
  if (manifest.memoryBackend && manifest.permissions?.memory === 'none') {
    warnings.push('memoryBackend plugins normally require memory read/write permission');
  }
  return { valid: errors.length === 0, errors, warnings };
}

export class PluginCatalog {
  private readonly entries = new Map<string, PluginCatalogEntry>();

  register(manifest: PluginManifest, plugin: Plugin): PluginValidationResult {
    const validation = validatePluginManifest(manifest);
    if (!validation.valid) return validation;
    this.entries.set(manifest.name, { manifest, plugin });
    return validation;
  }

  list(): PluginManifest[] {
    return [...this.entries.values()].map((entry) => entry.manifest);
  }

  get(name: string): PluginCatalogEntry | undefined {
    return this.entries.get(name);
  }
}

export function createMemoryBackendPlugin(options: {
  name: string;
  provider: MemoryBackendProvider;
  version?: string;
  description?: string;
}): MemoryBackendPlugin {
  return {
    name: options.name,
    kind: 'memory-backend',
    provider: options.provider,
    manifest: {
      name: options.name,
      version: options.version,
      description: options.description ?? 'Memory backend provider plugin',
      memoryBackend: true,
      hooks: ['agent:beforeRun', 'agent:afterRun'],
      permissions: { memory: 'readwrite' },
    },
  };
}

export class ReferencePreToolCallPlugin implements Plugin {
  readonly name: string;

  constructor(
    name = 'reference-pre-tool-call',
    private readonly denyTools: string[] = [],
  ) {
    this.name = name;
  }

  preToolCall(payload: { toolName: string }, _context: PluginContext): PreToolCallVeto {
    if (this.denyTools.includes(payload.toolName)) {
      return { veto: true, reason: `tool denied by ${this.name}` };
    }
    return { veto: false };
  }
}

export class ReferenceToolResultPlugin implements Plugin {
  readonly name: string;

  constructor(name = 'reference-tool-result') {
    this.name = name;
  }

  transformToolResult(
    payload: { result: { metadata?: Record<string, unknown> } },
    _context: PluginContext,
  ): ToolResultTransform {
    return {
      metadata: {
        ...(payload.result.metadata ?? {}),
        transformedBy: this.name,
      },
    };
  }
}
