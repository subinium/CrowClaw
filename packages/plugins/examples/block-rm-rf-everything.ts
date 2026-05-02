import type { Plugin, PluginContext, PreToolCallVeto } from '@crowclaw/core';

const SHELL_TOOLS = new Set(['terminal.exec', 'terminal.background']);
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+(?:\/|~|\$HOME|\.{1,2}(?:\s|$))/,
  /\bfind\s+\/\s+.*\s+-delete\b/,
  /\bchmod\s+-R\s+777\s+(?:\/|~|\$HOME)\b/,
  /\bdd\s+.*\bof=\/dev\/(?:disk|rdisk|sda|nvme)/,
];

function commandFromInput(input: Record<string, unknown>): string {
  const command = input.command ?? input.cmd;
  return typeof command === 'string' ? command : '';
}

export class BlockRmRfEverythingPlugin implements Plugin {
  readonly name = 'block-rm-rf-everything';

  preToolCall(
    payload: { toolName: string; input: Record<string, unknown> },
    _context: PluginContext,
  ): PreToolCallVeto {
    if (!SHELL_TOOLS.has(payload.toolName)) return { veto: false };

    const command = commandFromInput(payload.input);
    if (!command) return { veto: false };

    const blocked = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
    return blocked
      ? { veto: true, reason: 'organization policy blocks broad destructive shell commands' }
      : { veto: false };
  }
}

export function createBlockRmRfEverythingPlugin(): Plugin {
  return new BlockRmRfEverythingPlugin();
}
