import {
  MemoryCapturePlugin,
  PluginManager,
  ReferencePreToolCallPlugin,
  ReferenceToolResultPlugin,
  type Plugin,
  type PluginManifest,
} from '@crowclaw/plugins';
import { getPluginCatalogEntry } from './runtime-catalogs.js';

export function createDefaultPluginManager(): PluginManager {
  return new PluginManager().register(new MemoryCapturePlugin());
}

export function createRuntimePluginCatalog(plugins: PluginManager): {
  installedPluginConfigs: Map<string, { manifest: PluginManifest; config?: Record<string, unknown>; installedAt: string }>;
  createCatalogPlugin: (slug: string, config?: Record<string, unknown>) => Plugin;
  listInstalledPlugins: () => Array<{ name: string; manifest: PluginManifest | { name: string }; config: Record<string, unknown>; installedAt?: string }>;
} {
  const installedPluginConfigs = new Map<string, { manifest: PluginManifest; config?: Record<string, unknown>; installedAt: string }>();
  for (const plugin of plugins.list()) {
    const catalogEntry = getPluginCatalogEntry(plugin.name);
    installedPluginConfigs.set(plugin.name, {
      manifest: catalogEntry?.manifest ?? { name: plugin.name, hooks: [] },
      installedAt: new Date().toISOString(),
    });
  }

  const createCatalogPlugin = (slug: string, config: Record<string, unknown> = {}): Plugin => {
    if (slug === 'memory-capture') return new MemoryCapturePlugin();
    if (slug === 'reference-pre-tool-call') {
      const denyTools = Array.isArray(config.denyTools)
        ? config.denyTools.filter((tool): tool is string => typeof tool === 'string')
        : [];
      return new ReferencePreToolCallPlugin('reference-pre-tool-call', denyTools);
    }
    if (slug === 'reference-tool-result') return new ReferenceToolResultPlugin('reference-tool-result');
    const entry = getPluginCatalogEntry(slug);
    return { name: entry?.manifest.name ?? slug };
  };

  const listInstalledPlugins = () => plugins.list().map((plugin) => {
    const installed = installedPluginConfigs.get(plugin.name);
    return {
      name: plugin.name,
      manifest: installed?.manifest ?? { name: plugin.name },
      config: installed?.config ?? {},
      installedAt: installed?.installedAt,
    };
  });

  return { installedPluginConfigs, createCatalogPlugin, listInstalledPlugins };
}
