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

export {
  PluginManager,
  MemoryCapturePlugin,
} from '@crowclaw/core';
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
