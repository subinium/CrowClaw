/**
 * Global keyboard registration helpers.
 *
 * Owns:
 *   - Cmd+K / Ctrl+K → command palette (#178)
 *   - The full SHORTCUTS table (#248) — every shortcut surfaced in the
 *     keyboard-help dialog and the command-palette "Actions" tab.
 *
 * Lives in `lib/` rather than the component itself so the orchestrator
 * (`app.ts`) can call `registerCommandPalette(this)` and `registerShortcuts()`
 * once at boot without taking a direct dependency on the Lit element module
 * beyond a side-effect import.
 *
 * Shortcut dispatch contract:
 *   - Cmd+K opens the palette directly via the singleton handle.
 *   - All other shortcuts dispatch a window-level CustomEvent named
 *     `crowclaw:cmdk-action` with `detail: { action }` where `action` is the
 *     SHORTCUTS[].action string. `app.ts` (Agent A5) wires the listeners; this
 *     module is intentionally agnostic about what each action does so the
 *     palette and the keyboard system stay in sync via a single string contract.
 */

// Type-only import: command-palette.ts now imports `SHORTCUTS` from this file
// (#248), so a runtime value import here would create an ESM cycle. The
// side-effect import below is bare (no bindings pulled out) — it registers
// the `<crowclaw-command-palette>` custom element via the @customElement
// decorator at module load. ESM resolves the cycle by deferring this side
// effect until command-palette.ts has finished initialising, which is fine
// because `registerCommandPalette` is only called from app.ts at runtime.
import type { CrowClawCommandPalette } from '../components/command-palette.js';
import '../components/command-palette.js';

export interface CommandPaletteHandle {
  /** Programmatically open the palette. */
  open(): void;
  /** Programmatically close the palette. */
  close(): void;
  /** Tear down the global listener and remove the element from the DOM. */
  dispose(): void;
}

// Singleton reference so `registerShortcuts` can drive `Cmd+K` without taking
// a `parent` argument. Set by `registerCommandPalette` and cleared by its
// dispose(). If the palette hasn't been registered yet, the `open-palette`
// action falls back to dispatching a `crowclaw:cmdk-action` event so a
// downstream listener can decide what to do.
let paletteHandle: CommandPaletteHandle | null = null;

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

  const handle: CommandPaletteHandle = {
    open: () => el.show(),
    close: () => el.hide(),
    dispose: () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      el.remove();
      // Drop the singleton so the next registerShortcuts() call (e.g. in tests)
      // doesn't try to drive a removed element.
      paletteHandle = null;
    },
  };
  paletteHandle = handle;
  return handle;
};

// ---------------------------------------------------------------------------
// SHORTCUTS table — single source of truth (#248)
// ---------------------------------------------------------------------------

export interface ShortcutBinding {
  /** Lowercase key combo. `cmd+X` accepts Cmd on macOS or Ctrl elsewhere. */
  key: string;
  /** Human-readable description shown in the keyboard-help dialog. */
  description: string;
  /** Group label used to bucket the help dialog. */
  group: 'Navigation' | 'Chat' | 'Inspector' | 'Power user';
  /**
   * Action string dispatched on `crowclaw:cmdk-action`. Must match the
   * action `id` used by HARDCODED_ACTIONS in command-palette.ts so the
   * palette and the keyboard registry agree on a single set of action names.
   */
  action: string;
}

export const SHORTCUTS: ShortcutBinding[] = [
  { key: 'cmd+k', description: 'Open command palette',     group: 'Power user', action: 'open-palette' },
  { key: '?',     description: 'Show keyboard shortcuts',  group: 'Power user', action: 'open-keyboard-help' },
  { key: 'cmd+n', description: 'New chat session',         group: 'Chat',       action: 'new-chat' },
  { key: 'cmd+.', description: 'Abort active session',     group: 'Chat',       action: 'abort-session' },
  { key: 'cmd+f', description: 'Search current session',   group: 'Chat',       action: 'search-session' },
  { key: 'cmd+b', description: 'Toggle sidebar',           group: 'Navigation', action: 'toggle-sidebar' },
  { key: 'cmd+i', description: 'Toggle inspector rail',    group: 'Inspector',  action: 'toggle-inspector' },
  { key: 'cmd+,', description: 'Open settings',            group: 'Navigation', action: 'open-settings' },
  // Vim-style chord bindings: press `g`, then the second key within 1.5s.
  { key: 'g c', description: 'Go to Chat',     group: 'Navigation', action: 'goto-chat' },
  { key: 'g o', description: 'Go to Connect',  group: 'Navigation', action: 'goto-connect' },
  { key: 'g a', description: 'Go to Automate', group: 'Navigation', action: 'goto-automate' },
  { key: 'g s', description: 'Go to Settings', group: 'Navigation', action: 'goto-settings' },
];

/** Window-event name dispatched for every shortcut firing (except `open-palette`). */
export const SHORTCUT_EVENT = 'crowclaw:cmdk-action' as const;

const CHORD_TIMEOUT_MS = 1500;

const dispatchAction = (action: string): void => {
  window.dispatchEvent(new CustomEvent(SHORTCUT_EVENT, { detail: { action } }));
};

/**
 * Match a keydown event against `cmd+k` / `cmd+,` / `?` style key strings.
 * `cmd+X` matches BOTH Cmd (metaKey) and Ctrl (ctrlKey) so the same binding
 * works on macOS and other platforms.
 *
 * Single-character keys like `?` only match when the modifier set is empty —
 * otherwise `Shift+/` (which is how `?` is typed on US keyboards) would also
 * trigger Cmd+? combinations. We accept Shift here because `?` requires Shift
 * on most layouts, but require no Cmd/Ctrl/Alt.
 */
const matchesKey = (e: KeyboardEvent, spec: string): boolean => {
  // Chord bindings (e.g. "g c") are not matched here — they are handled by
  // the chord state machine in the dispatcher.
  if (spec.includes(' ')) return false;

  const parts = spec.toLowerCase().split('+');
  const target = parts[parts.length - 1];
  const wantMod = parts.slice(0, -1);

  const wantCmdOrCtrl = wantMod.includes('cmd') || wantMod.includes('ctrl') || wantMod.includes('meta');
  const wantShift = wantMod.includes('shift');
  const wantAlt = wantMod.includes('alt') || wantMod.includes('option');

  // Modifier match: cmd+X requires (metaKey || ctrlKey); plain "?" requires no
  // cmd/ctrl/alt.
  if (wantCmdOrCtrl && !(e.metaKey || e.ctrlKey)) return false;
  if (!wantCmdOrCtrl && (e.metaKey || e.ctrlKey || e.altKey)) return false;
  if (wantShift && !e.shiftKey) return false;
  if (wantAlt && !e.altKey) return false;

  // Key match: compare lowercase. For punctuation like `,` `.` `/` `?` the
  // browser's `e.key` is already the literal character.
  return e.key.toLowerCase() === target;
};

/** True when focus is in an editable surface where global shortcuts must NOT fire. */
const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // contenteditable surfaces (e.g. rich-text composers) should also block.
  if (target.isContentEditable) return true;
  return false;
};

// Module-scoped registration latch. `registerShortcuts` is idempotent — calling
// it twice (e.g. during HMR or a unit test setup) must not double-bind the
// keydown listener. The cleanup returned by the *first* call is the one that
// undoes the binding; subsequent calls return a no-op cleanup.
let shortcutsRegistered = false;

/**
 * Attach the global keydown listener that drives the SHORTCUTS table. Returns
 * a cleanup function that removes the listener. Idempotent — repeated calls
 * while a registration is live return a no-op cleanup so callers can't
 * accidentally tear down the original binding.
 */
export const registerShortcuts = (): (() => void) => {
  if (shortcutsRegistered) {
    return () => {};
  }
  shortcutsRegistered = true;

  // Vim-style chord state. `g` arms a chord; the next keypress within
  // CHORD_TIMEOUT_MS resolves it. We track via a setTimeout id so a stale
  // arm doesn't survive past the window.
  let chordArmed = false;
  let chordTimer: ReturnType<typeof setTimeout> | null = null;
  const clearChord = () => {
    chordArmed = false;
    if (chordTimer !== null) {
      clearTimeout(chordTimer);
      chordTimer = null;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    // Esc is the one shortcut we DON'T gate on focus — modal/overlay close
    // must work even when the user is typing in a textarea. Currently no
    // entry in SHORTCUTS uses Esc, but the gate below would block it if added.
    const editable = isEditableTarget(e.target);

    // Chord resolution: if a chord is armed, treat the next keypress as the
    // second half regardless of focus. Cancel on any modifier (chords are
    // unmodified letters) or on a second `g` (which re-arms instead).
    if (chordArmed && !editable) {
      const second = e.key.toLowerCase();
      if (second === 'g') {
        // Re-arm — user pressed `g` again, restart the timer.
        if (chordTimer !== null) clearTimeout(chordTimer);
        chordTimer = setTimeout(clearChord, CHORD_TIMEOUT_MS);
        return;
      }
      // Modifier keypress alone (Shift/Ctrl/Meta/Alt) doesn't resolve the
      // chord — wait for the actual letter.
      if (second === 'shift' || second === 'control' || second === 'meta' || second === 'alt') {
        return;
      }
      const chord = `g ${second}`;
      const match = SHORTCUTS.find((s) => s.key === chord);
      clearChord();
      if (match) {
        e.preventDefault();
        dispatchAction(match.action);
        return;
      }
      // Unrecognised second key — drop the chord and fall through so the
      // key still has a chance to match a non-chord binding (rare, but
      // avoids swallowing legitimate input).
    }

    // Block non-Esc shortcuts while focus is in an editable surface so the
    // chat composer's Enter/Shift+Enter, the search input's typing, etc.
    // keep working. Esc is excluded by the SHORTCUTS table today; if added
    // it would need a separate allowlist branch above this gate.
    if (editable) return;

    // Arm chord on a bare `g`. Must be unmodified — `Cmd+g` is "find next" on
    // some platforms and we don't want to hijack it.
    if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      // Only arm if a `g X` chord exists in the table; otherwise let the key
      // pass through unchanged.
      if (SHORTCUTS.some((s) => s.key.startsWith('g '))) {
        chordArmed = true;
        if (chordTimer !== null) clearTimeout(chordTimer);
        chordTimer = setTimeout(clearChord, CHORD_TIMEOUT_MS);
        e.preventDefault();
        return;
      }
    }

    // Standard key matching. `open-palette` is special-cased so we drive the
    // singleton palette directly when available — the palette listens on its
    // own keydown handler too, but routing through the registry keeps the
    // shortcut visible in the help dialog and lets headless tests trigger it
    // without instantiating a Lit element.
    for (const shortcut of SHORTCUTS) {
      if (!matchesKey(e, shortcut.key)) continue;
      e.preventDefault();
      e.stopPropagation();
      if (shortcut.action === 'open-palette') {
        if (paletteHandle) {
          paletteHandle.open();
        } else {
          dispatchAction(shortcut.action);
        }
        return;
      }
      dispatchAction(shortcut.action);
      return;
    }
  };

  window.addEventListener('keydown', onKey, { capture: true });

  return () => {
    window.removeEventListener('keydown', onKey, { capture: true });
    clearChord();
    shortcutsRegistered = false;
  };
};
