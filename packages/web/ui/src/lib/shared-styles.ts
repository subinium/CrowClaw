/**
 * Shared Lit CSS styles for CrowClaw components.
 * Import and spread into `static styles` arrays.
 */
import { css } from 'lit';

/** Button styles — .btn, .btn-p, .btn-danger */
export const buttonStyles = css`
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-1);
    padding: var(--sp-2) var(--sp-4);
    border: 1px solid var(--glass-border);
    background: var(--glass-bg);
    color: #c8cdd6;
    font-size: var(--text-sm);
    font-weight: 500;
    font-family: 'Inter', 'Noto Sans KR', var(--font-sans);
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease-spring);
    outline: none;
    border-radius: var(--radius-sm);
  }
  .btn:hover {
    background: var(--bg-card-hover);
    border-color: rgba(255, 255, 255, 0.15);
  }
  .btn:active {
    opacity: 0.85;
    transform: scale(0.98);
  }
  .btn-p {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn-p:hover {
    background: var(--accent-hover);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(224, 85, 69, 0.3);
  }
  .btn-danger {
    background: rgba(255, 69, 58, 0.08);
    border-color: var(--error);
    color: var(--error);
  }
  .btn-danger:hover {
    background: rgba(255, 69, 58, 0.15);
  }
`;

/** Card styles */
export const cardStyles = css`
  .card {
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    padding: var(--sp-4) var(--sp-5);
    transition: all var(--duration-normal) var(--ease-spring);
    border-radius: var(--radius-md);
  }
  .card:hover {
    border-color: rgba(255, 255, 255, 0.14);
    background: var(--bg-card-hover);
    transform: translateY(-1px);
    box-shadow: var(--shadow-md);
  }
`;

/** Tag styles */
export const tagStyles = css`
  .tag {
    display: inline-block;
    padding: 2px var(--sp-1);
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    font-size: 9px;
    font-weight: 500;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    letter-spacing: 0.2px;
    border-radius: var(--radius-sm);
  }
  .tag.ok { color: var(--success); background: rgba(48,209,88,.08); border-color: rgba(48,209,88,.2); }
  .tag.er { color: var(--error); background: rgba(255,69,58,.08); border-color: rgba(255,69,58,.2); }
  .tag.wn { color: var(--warning); background: rgba(255,214,10,.08); border-color: rgba(255,214,10,.2); }
  .tag.ac { color: var(--accent); background: var(--accent-soft); border-color: rgba(224,85,69,.2); }
`;

/** Form input styles */
export const formStyles = css`
  .form-group {
    margin-bottom: var(--sp-4);
  }
  .form-label {
    display: block;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: var(--sp-2);
  }
  .form-input {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--glass-border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: 'Inter', 'Noto Sans KR', var(--font-sans);
    outline: none;
    border-radius: var(--radius-sm);
    transition: border-color var(--duration-fast) var(--ease-spring);
  }
  .form-input:focus {
    border-color: var(--accent);
    background: rgba(255, 255, 255, 0.08);
  }
  .form-input::placeholder {
    color: var(--text-muted);
  }
  .form-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-top: var(--sp-1);
  }
  textarea.form-input {
    min-height: 80px;
    resize: vertical;
    line-height: 1.5;
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
    color: #c8cdd6;
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
    margin-bottom: var(--sp-8);
  }
  .section-header {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
    padding: var(--sp-4) 0 var(--sp-3);
    border-bottom: 1px solid var(--glass-border);
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
    border-bottom: 1px solid var(--glass-border);
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
    color: var(--text-secondary);
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
    border-bottom: 1px solid var(--glass-border);
  }
  .kv:last-child { border-bottom: none; }
  .kv-k { color: var(--text-secondary); font-weight: 500; }
  .kv-v { color: var(--text-primary); font-family: var(--font-mono); font-size: var(--text-xs); }
`;

/** Search input */
export const searchStyles = css`
  .srch {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--glass-border);
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-family: 'Inter', 'Noto Sans KR', var(--font-sans);
    outline: none;
    margin-bottom: var(--sp-4);
    border-radius: var(--radius-sm);
    transition: border-color var(--duration-fast) var(--ease-spring);
  }
  .srch:focus { border-color: var(--accent); background: rgba(255,255,255,0.08); }
  .srch::placeholder { color: var(--text-muted); }
`;
