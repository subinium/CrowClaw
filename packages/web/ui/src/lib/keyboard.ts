/**
 * Global keyboard registration helpers.
 *
 * Currently only owns Cmd+K / Ctrl+K → command palette (#178). Lives in
 * `lib/` rather than the component itself so the orchestrator (`app.ts`)
 * can call `registerCommandPalette(this)` once at boot without taking
 * a direct dependency on the Lit element module beyond a side-effect
 * import.
 */

import { CrowClawCommandPalette } from '../components/command-palette.js';

export interface CommandPaletteHandle {
  /** Programmatically open the palette. */
  open(): void;
  /** Programmatically close the palette. */
  close(): void;
  /** Tear down the global listener and remove the element from the DOM. */
  dispose(): void;
}

const isPaletteShortcut = (e: KeyboardEvent): boolean => {
  if (e.key !== 'k' && e.key !== 'K') return false;
  // Cmd+K on macOS, Ctrl+K elsewhere. Either is accepted on either platform
  // so muscle memory carries over.
  return e.metaKey || e.ctrlKey;
};

/**
 * Mount a `<crowclaw-command-palette>` under `parent` and register a global
 * keydown listener that opens it. Returns a handle for explicit teardown
 * (used in tests; the dashboard runs as a singleton so dispose is rarely
 * called in production).
 */
export const registerCommandPalette = (parent: HTMLElement): CommandPaletteHandle => {
  const el = document.createElement('crowclaw-command-palette') as CrowClawCommandPalette;
  parent.appendChild(el);

  const onKey = (e: KeyboardEvent) => {
    if (!isPaletteShortcut(e)) return;
    // Block the browser's native bookmarks-quicksearch / search-bar focus.
    e.preventDefault();
    e.stopPropagation();
    if (el.open) {
      el.hide();
    } else {
      el.show();
    }
  };

  window.addEventListener('keydown', onKey, { capture: true });

  return {
    open: () => el.show(),
    close: () => el.hide(),
    dispose: () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      el.remove();
    },
  };
};
