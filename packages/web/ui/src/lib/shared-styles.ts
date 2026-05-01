/**
 * Shared Lit CSS styles for CrowClaw components.
 * Import and spread into `static styles` arrays.
 *
 * NOTE (v0.8.1): Button styles (.btn / .btn-p / .btn-danger) and form-input
 * styles have been removed in favour of <crowclaw-button> and <crowclaw-input>.
 * Migrate any remaining call sites to those components.
 */
import { css } from 'lit';

/**
 * v0.8.1: empty back-compat stub. The real `.btn`/`.btn-p`/`.btn-danger` rules
 * were dropped in favour of `<crowclaw-button>`. Files that still spread
 * `buttonStyles` into `static styles` keep working — they just contribute an
 * empty CSS block until they finish migrating to the component. Slated for
 * removal in v0.9.
 */
export const buttonStyles = css``;

/** Card styles */
export const cardStyles = css`
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    padding: var(--sp-4) var(--sp-5);
    transition: all var(--duration-normal) var(--ease-spring);
    border-radius: var(--radius-md);
  }
  .card:hover {
    border-color: var(--border-strong);
    background: var(--surface-2);
    transform: translateY(-1px);
    box-shadow: var(--shadow-md);
  }
`;

/** Tag styles */
export const tagStyles = css`
  .tag {
    display: inline-block;
    padding: 2px var(--sp-1);
    background: var(--surface-1);
    border: 1px solid var(--border);
    font-size: 9px;
    font-weight: 500;
    font-family: var(--font-mono);
    color: var(--text-muted);
    letter-spacing: 0.2px;
    border-radius: var(--radius-sm);
  }
  .tag.ok { color: var(--success); background: rgba(48,209,88,.08); border-color: rgba(48,209,88,.2); }
  .tag.er { color: var(--error); background: rgba(255,69,58,.08); border-color: rgba(255,69,58,.2); }
  .tag.wn { color: var(--warn); background: rgba(255,204,0,.08); border-color: rgba(255,204,0,.2); }
  .tag.ac { color: var(--accent); background: var(--accent-soft); border-color: rgba(91,141,239,.2); }
`;

/** Form layout helpers (form-input itself is now <crowclaw-input>). */
export const formStyles = css`
  .form-group {
    margin-bottom: var(--sp-4);
  }
  .form-label {
    display: block;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: var(--sp-2);
  }
  .form-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-top: var(--sp-1);
  }
`;

/** Empty state */
export const emptyStyles = css`
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--sp-12) 0;
    gap: var(--sp-2);
    opacity: 0.5;
  }
  .empty-title {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text);
  }
  .empty-subtitle {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
`;

/** Grid layout */
export const gridStyles = css`
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
    gap: var(--sp-3);
  }
`;

/** Section styles */
export const sectionStyles = css`
  .section-block {
    margin-bottom: var(--sp-6);
  }
  .section-header {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--text);
    padding: var(--sp-4) 0 var(--sp-3);
    border-bottom: 1px solid var(--border);
    margin-bottom: var(--sp-4);
  }
  .sec-h {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--text-muted);
    margin-bottom: var(--sp-2);
  }
`;

/** Tab styles */
export const tabStyles = css`
  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: var(--sp-4);
  }
  .tab {
    padding: var(--sp-2) var(--sp-4);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all var(--duration-fast) var(--ease-spring);
  }
  .tab:hover {
    color: var(--text);
  }
  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
`;

/** Key-value rows */
export const kvStyles = css`
  .kv {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--sp-2) var(--sp-4);
    font-size: var(--text-sm);
    border-bottom: 1px solid var(--border);
  }
  .kv:last-child { border-bottom: none; }
  .kv-k { color: var(--text-muted); font-weight: 500; }
  .kv-v { color: var(--text); font-family: var(--font-mono); font-size: var(--text-xs); }
`;

/** Search input */
export const searchStyles = css`
  .srch {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border);
    background: var(--surface-1);
    color: var(--text);
    font-size: var(--text-sm);
    font-family: 'Inter', 'Noto Sans KR', var(--font-sans);
    outline: none;
    margin-bottom: var(--sp-4);
    border-radius: var(--radius-sm);
    transition: border-color var(--duration-fast) var(--ease-spring);
  }
  .srch:focus { border-color: var(--accent); background: var(--surface-2); }
  .srch::placeholder { color: var(--text-muted); }
`;
