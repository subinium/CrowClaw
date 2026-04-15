import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { api } from '../lib/api.js';
import { streamMessage, type StreamCallbacks } from '../lib/sse.js';
import { renderMarkdown, highlightCodeBlocks, attachCopyHandlers } from '../lib/markdown.js';
import { buttonStyles } from '../lib/shared-styles.js';
import { showToast } from '../components/toast.js';

interface SessionInfo {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  updatedAt: string;
  contextPct?: number;
}

interface ActiveSessionInfo {
  sessionId: string;
  status: string;
  startedAt: string;
}

interface CheckpointInfo {
  id: string;
  label?: string;
  createdAt: string;
  messageCount?: number;
}

interface SearchResult {
  messageIndex: number;
  role: string;
  content: string;
  score?: number;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'iteration';
  content: string;
  name?: string;
  createdAt?: string;
}

interface ToolStep {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'done' | 'error';
  input?: Record<string, unknown>;
  output?: string;
  elapsed?: number;
}

interface TraceToolEntry {
  toolName: string;
  status: 'running' | 'done' | 'error';
  elapsed?: number;
}

const escapeHtml = (text: string): string => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

const timeAgo = (date: string): string => {
  if (!date) return '--';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

const truncateId = (id: string, len = 12): string => {
  if (id.length <= len) return id;
  return id.slice(0, len) + '...';
};

@customElement('crowclaw-chat-view')
export class ChatView extends LitElement {
  static styles = [
    buttonStyles,
    css`
      :host { display: flex; width: 100%; height: 100%; }

      /* Chat Layout */
      .chat-area { display: flex; width: 100%; height: 100%; }

      /* Session Sidebar */
      .sess-sb {
        width: 280px;
        border-right: 1px solid var(--glass-border);
        display: flex;
        flex-direction: column;
        background: var(--bg-secondary);
        flex-shrink: 0;
      }

      .sess-hdr {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: var(--sp-3);
        border-bottom: 1px solid var(--glass-border);
      }

      .sess-hdr input {
        flex: 1;
        padding: var(--sp-2) var(--sp-3);
        border: 1px solid var(--glass-border);
        background: var(--bg-input);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-family: inherit;
        outline: none;
        border-radius: var(--radius-sm);
      }

      .sess-hdr input:focus { border-color: var(--accent); }
      .sess-hdr input::placeholder { color: var(--text-muted); }

      .sess-list { flex: 1; overflow-y: auto; }

      .sess-item {
        padding: var(--sp-3) var(--sp-4);
        cursor: pointer;
        border-bottom: 1px solid var(--glass-border);
        position: relative;
        transition: background var(--duration-fast);
      }

      .sess-item:hover { background: var(--bg-card); }
      .sess-item.active { background: var(--accent-soft); border-left: 2px solid var(--accent); }

      .sess-item-top {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        margin-bottom: 2px;
      }

      .sess-active-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--success);
        flex-shrink: 0;
        animation: pulse 1.5s infinite;
      }

      .sess-id {
        font-size: 10px;
        font-family: var(--font-mono);
        color: var(--text-muted);
        letter-spacing: 0.3px;
      }

      .sess-title {
        font-size: var(--text-sm);
        font-weight: 500;
        color: var(--text-primary);
        margin-bottom: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .sess-preview {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 4px;
      }

      .sess-meta {
        display: flex;
        align-items: center;
        gap: var(--sp-3);
        font-size: var(--text-xs);
        color: var(--text-muted);
      }

      .sess-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 16px;
        padding: 0 4px;
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: 8px;
        font-size: 9px;
        font-weight: 600;
        color: var(--text-secondary);
        font-family: var(--font-mono);
      }

      .sess-ctx {
        height: 2px;
        background: var(--glass-border);
        margin-top: var(--sp-1);
        border-radius: 1px;
        overflow: hidden;
      }

      .sess-ctx-bar { height: 100%; background: var(--accent); transition: width 0.3s; }

      .sess-actions {
        position: absolute;
        top: var(--sp-2);
        right: var(--sp-2);
        display: none;
        gap: 2px;
      }

      .sess-item:hover .sess-actions { display: flex; }

      .sess-actions button {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 12px;
        padding: 2px 4px;
        border-radius: var(--radius-sm);
      }

      .sess-actions button:hover { color: var(--text-primary); background: var(--bg-card-hover); }

      /* Context menu for session actions */
      .sess-ctx-menu {
        position: absolute;
        top: 28px;
        right: var(--sp-2);
        z-index: 20;
        background: var(--bg-secondary);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-sm);
        box-shadow: var(--shadow-md);
        min-width: 140px;
        overflow: hidden;
      }

      .sess-ctx-menu button {
        display: block;
        width: 100%;
        padding: var(--sp-2) var(--sp-3);
        border: none;
        background: none;
        color: var(--text-primary);
        font-size: var(--text-xs);
        text-align: left;
        cursor: pointer;
        font-family: inherit;
      }

      .sess-ctx-menu button:hover { background: var(--bg-card-hover); }
      .sess-ctx-menu button.danger { color: var(--error); }
      .sess-ctx-menu button.danger:hover { background: rgba(255, 69, 58, 0.1); }

      /* Chat Content */
      .chat-content {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
      }

      .sess-toggle-btn {
        background: var(--bg-tertiary);
        border: 1px solid var(--glass-border);
        color: var(--text-primary);
        cursor: pointer;
        padding: 4px 8px;
        margin: var(--sp-2);
        font-size: 14px;
        border-radius: var(--radius-sm);
        width: fit-content;
      }

      /* Operations Toolbar */
      .ops-toolbar {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: var(--sp-2) var(--sp-4);
        border-bottom: 1px solid var(--glass-border);
        background: var(--bg-secondary);
        flex-wrap: wrap;
      }

      .ops-toolbar .ops-label {
        font-size: var(--text-xs);
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.8px;
        margin-right: var(--sp-1);
      }

      .ops-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--sp-1);
        padding: 4px 10px;
        border: 1px solid var(--glass-border);
        background: var(--glass-bg);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        border-radius: var(--radius-sm);
        transition: background var(--duration-fast), border-color var(--duration-fast);
      }

      .ops-btn:hover {
        background: var(--bg-card-hover);
        border-color: rgba(255, 255, 255, 0.15);
        color: var(--text-primary);
      }

      .ops-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .ops-btn.danger {
        border-color: rgba(255, 69, 58, 0.3);
        color: var(--error);
      }

      .ops-btn.danger:hover {
        background: rgba(255, 69, 58, 0.1);
      }

      .ops-btn.aborting {
        border-color: rgba(255, 214, 10, 0.3);
        color: var(--warning);
        animation: pulse 1s infinite;
      }

      .ops-sep {
        width: 1px;
        height: 20px;
        background: var(--glass-border);
        margin: 0 var(--sp-1);
      }

      /* Steer input overlay */
      .steer-overlay {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: var(--sp-2) var(--sp-4);
        border-bottom: 1px solid var(--glass-border);
        background: rgba(100, 210, 255, 0.04);
      }

      .steer-overlay input {
        flex: 1;
        padding: var(--sp-2) var(--sp-3);
        border: 1px solid rgba(100, 210, 255, 0.3);
        background: var(--bg-input);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-family: inherit;
        outline: none;
        border-radius: var(--radius-sm);
      }

      .steer-overlay input:focus { border-color: var(--info); }

      /* Search overlay */
      .search-overlay {
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
        padding: var(--sp-2) var(--sp-4);
        border-bottom: 1px solid var(--glass-border);
        background: rgba(100, 210, 255, 0.04);
      }

      .search-overlay .search-row {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
      }

      .search-overlay input {
        flex: 1;
        padding: var(--sp-2) var(--sp-3);
        border: 1px solid rgba(100, 210, 255, 0.3);
        background: var(--bg-input);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-family: inherit;
        outline: none;
        border-radius: var(--radius-sm);
      }

      .search-results {
        max-height: 160px;
        overflow-y: auto;
      }

      .search-result-item {
        padding: var(--sp-1) var(--sp-2);
        font-size: var(--text-xs);
        border-bottom: 1px solid var(--glass-border);
        cursor: pointer;
      }

      .search-result-item:hover { background: var(--bg-card-hover); }

      .search-result-item .sr-role {
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        font-size: 9px;
        margin-right: var(--sp-2);
      }

      .search-result-item .sr-content {
        color: var(--text-secondary);
      }

      /* Checkpoint list overlay */
      .checkpoint-overlay {
        padding: var(--sp-2) var(--sp-4);
        border-bottom: 1px solid var(--glass-border);
        background: rgba(100, 210, 255, 0.04);
        max-height: 200px;
        overflow-y: auto;
      }

      .checkpoint-overlay .cp-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--sp-2);
      }

      .checkpoint-overlay .cp-hdr span {
        font-size: var(--text-xs);
        font-weight: 600;
        color: var(--text-secondary);
      }

      .cp-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--sp-1) var(--sp-2);
        border-bottom: 1px solid var(--glass-border);
        font-size: var(--text-xs);
      }

      .cp-item:last-child { border-bottom: none; }

      .cp-item .cp-label {
        color: var(--text-primary);
        font-family: var(--font-mono);
      }

      .cp-item .cp-time {
        color: var(--text-muted);
      }

      .cp-item .cp-restore {
        padding: 2px 6px;
        border: 1px solid var(--glass-border);
        background: none;
        color: var(--text-secondary);
        font-size: 10px;
        cursor: pointer;
        border-radius: var(--radius-sm);
        font-family: inherit;
      }

      .cp-item .cp-restore:hover {
        background: var(--bg-card-hover);
        color: var(--text-primary);
      }

      /* Rename dialog */
      .rename-overlay {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: var(--sp-2) var(--sp-4);
        border-bottom: 1px solid var(--glass-border);
        background: rgba(255, 255, 255, 0.02);
      }

      .rename-overlay input {
        flex: 1;
        padding: var(--sp-2) var(--sp-3);
        border: 1px solid var(--glass-border);
        background: var(--bg-input);
        color: var(--text-primary);
        font-size: var(--text-xs);
        font-family: inherit;
        outline: none;
        border-radius: var(--radius-sm);
      }

      /* Messages */
      .messages {
        flex: 1;
        overflow-y: auto;
        padding: var(--sp-4);
      }

      .msg {
        max-width: 85%;
        margin-bottom: var(--sp-3);
        padding: var(--sp-3) var(--sp-4);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
        line-height: 1.6;
        position: relative;
      }

      .msg .role-tag {
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: var(--sp-1);
        display: block;
      }

      .msg.user {
        align-self: flex-end;
        margin-left: auto;
        background: var(--accent-soft);
        border: 1px solid rgba(224, 85, 69, 0.2);
      }

      .msg.user .role-tag { color: var(--accent); }

      .msg.assistant {
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
      }

      .msg.assistant .role-tag { color: var(--text-secondary); }

      .msg.system {
        background: rgba(100, 210, 255, 0.04);
        border: 1px solid rgba(100, 210, 255, 0.15);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }

      .msg.system .role-tag { color: var(--info); }

      .msg.streaming { opacity: 0.9; }
      .msg.streaming .cursor-blink {
        display: inline-block;
        width: 2px;
        height: 14px;
        background: var(--accent);
        margin-left: 2px;
        animation: blink 0.8s infinite;
        vertical-align: text-bottom;
      }

      @keyframes blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }

      /* Markdown styles */
      .md h1, .md h2, .md h3 { margin: var(--sp-3) 0 var(--sp-2); font-weight: 600; }
      .md h1 { font-size: var(--text-lg); }
      .md h2 { font-size: var(--text-base); }
      .md h3 { font-size: var(--text-sm); }
      .md strong { font-weight: 600; }
      .md em { font-style: italic; }
      .md a { color: var(--accent); }
      .md a:hover { color: var(--accent-hover); }
      .md ul, .md ol { padding-left: var(--sp-5); margin: var(--sp-2) 0; }
      .md li { margin-bottom: 2px; }
      .md blockquote {
        border-left: 3px solid var(--accent);
        padding: var(--sp-2) var(--sp-4);
        margin: var(--sp-2) 0;
        color: var(--text-secondary);
        background: rgba(255,255,255,0.02);
      }
      .md hr { border: none; border-top: 1px solid var(--glass-border); margin: var(--sp-3) 0; }
      .md code.md-inline {
        background: rgba(255,255,255,0.08);
        padding: 1px 5px;
        font-family: var(--font-mono);
        font-size: 0.9em;
        border-radius: 3px;
      }
      .md .code-block {
        position: relative;
        margin: var(--sp-2) 0;
      }
      .md pre.md-pre {
        background: rgba(0,0,0,0.3);
        border: 1px solid var(--glass-border);
        padding: var(--sp-3);
        overflow-x: auto;
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        line-height: 1.5;
        border-radius: var(--radius-sm);
      }
      .md .code-copy {
        position: absolute;
        top: 6px;
        right: 6px;
        font-size: 10px;
        padding: 2px 8px;
        opacity: 0.3;
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        color: var(--text-secondary);
        cursor: pointer;
        border-radius: var(--radius-sm);
        font-family: inherit;
      }
      .md .code-copy:hover { opacity: 0.8; }

      /* Tool Step */
      .tool-step {
        align-self: flex-start;
        max-width: 90%;
        margin: 2px 0;
      }

      .sf-row {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: 6px 12px;
        border: 1px solid var(--glass-border);
        background: var(--glass-bg);
        cursor: pointer;
        font-size: var(--text-xs);
        border-radius: var(--radius-sm);
        transition: background var(--duration-fast);
      }

      .sf-row:hover { background: var(--bg-card-hover); }

      .sf-row.ok { border-color: rgba(48,209,88,.2); background: rgba(48,209,88,.03); }
      .sf-row.er { border-color: rgba(255,69,58,.3); background: rgba(255,69,58,.04); }

      .sf-dot {
        width: 6px; height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .sf-dot.running { background: var(--accent); animation: pulse 1.5s infinite; }
      .sf-dot.ok { background: var(--success); }
      .sf-dot.er { background: var(--error); }

      @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

      .sf-name { font-weight: 500; color: var(--text-primary); font-family: var(--font-mono); }
      .sf-status { margin-left: auto; font-weight: 500; }
      .sf-detail {
        display: none;
        border: 1px solid rgba(255,255,255,.06);
        border-top: none;
        border-radius: 0 0 6px 6px;
        padding: 8px 12px;
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 200px;
        overflow-y: auto;
      }

      .sf-detail.open { display: block; }

      /* Step Feed Container */
      .step-feed {
        margin: var(--sp-2) 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .sf-hdr {
        font-size: var(--text-xs);
        font-weight: 600;
        color: var(--text-muted);
        margin-bottom: var(--sp-1);
      }

      /* Iteration Separator */
      .iter-sep {
        display: flex;
        align-items: center;
        gap: var(--sp-4);
        margin: var(--sp-6) 0;
        padding: var(--sp-2) 0;
        font-size: 12px;
        font-weight: 700;
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: 1.5px;
      }

      .iter-sep::before,
      .iter-sep::after {
        content: '';
        flex: 1;
        height: 2px;
        background: linear-gradient(90deg, transparent, rgba(224, 85, 69, 0.3), transparent);
      }

      /* Chat Input */
      .chat-input {
        padding: var(--sp-3) var(--sp-4);
        border-top: 1px solid var(--glass-border);
        display: flex;
        align-items: flex-end;
        gap: var(--sp-2);
      }

      .chat-input textarea {
        flex: 1;
        padding: var(--sp-3);
        border: 1px solid var(--glass-border);
        background: var(--bg-input);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        outline: none;
        border-radius: var(--radius-md);
        transition: border-color var(--duration-fast);
        resize: none;
        min-height: 40px;
        max-height: 160px;
        overflow-y: auto;
        line-height: 1.5;
      }

      .chat-input textarea:focus { border-color: var(--accent); }
      .chat-input textarea::placeholder { color: var(--text-muted); }

      .send-btn {
        width: 36px;
        height: 36px;
        background: var(--accent);
        border: none;
        color: white;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
        transition: background var(--duration-fast);
        flex-shrink: 0;
      }

      .send-btn:hover { background: var(--accent-hover); }
      .send-btn svg { width: 16px; height: 16px; }

      /* Retry button */
      .retry-btn {
        margin-top: 6px;
        font-size: 10px;
        padding: 2px 8px;
        opacity: 0.5;
      }

      .retry-btn:hover { opacity: 1; }

      /* Empty state */
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        gap: var(--sp-2);
        opacity: 0.5;
      }

      .empty-title { font-size: var(--text-base); font-weight: 600; color: #c8cdd6; }
      .empty-subtitle { font-size: var(--text-xs); color: var(--text-muted); }

      /* Trace Panel */
      .trace-toggle {
        position: absolute;
        bottom: 60px;
        right: 12px;
        width: 28px;
        height: 28px;
        background: var(--bg-tertiary);
        border: 1px solid var(--glass-border);
        color: var(--text-muted);
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
        border-radius: var(--radius-sm);
        z-index: 5;
      }

      .trace-toggle:hover { color: var(--accent); border-color: var(--accent); }

      .trace-panel {
        position: absolute;
        bottom: 60px;
        right: 48px;
        width: 260px;
        background: var(--bg-secondary);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        z-index: 5;
        display: none;
        max-height: 400px;
        overflow-y: auto;
      }

      .trace-panel.open { display: block; }

      .tp-hdr {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--sp-2) var(--sp-3);
        font-size: var(--text-xs);
        font-weight: 600;
        color: var(--text-secondary);
        border-bottom: 1px solid var(--glass-border);
        position: sticky;
        top: 0;
        background: var(--bg-secondary);
      }

      .tp-hdr .tp-stop-btn {
        padding: 2px 8px;
        border: 1px solid rgba(255, 69, 58, 0.3);
        background: rgba(255, 69, 58, 0.08);
        color: var(--error);
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
        border-radius: var(--radius-sm);
        font-family: inherit;
      }

      .tp-hdr .tp-stop-btn:hover { background: rgba(255, 69, 58, 0.15); }

      .tp-body { padding: var(--sp-2) var(--sp-3); }

      .tp-row {
        display: flex;
        justify-content: space-between;
        font-size: var(--text-xs);
        padding: 2px 0;
      }

      .tp-row span:first-child { color: var(--text-muted); }
      .tp-row span:last-child { color: var(--text-primary); font-family: var(--font-mono); }

      .tp-section-label {
        font-size: 9px;
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.8px;
        padding: var(--sp-2) var(--sp-3) var(--sp-1);
        border-top: 1px solid var(--glass-border);
        margin-top: var(--sp-1);
      }

      .tp-tool-list {
        padding: 0 var(--sp-3) var(--sp-2);
      }

      .tp-tool-entry {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: 2px 0;
        font-size: var(--text-xs);
      }

      .tp-tool-entry .tp-tool-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .tp-tool-dot.running { background: var(--accent); animation: pulse 1.5s infinite; }
      .tp-tool-dot.done { background: var(--success); }
      .tp-tool-dot.error { background: var(--error); }

      .tp-tool-entry .tp-tool-name {
        font-family: var(--font-mono);
        color: var(--text-secondary);
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tp-tool-entry .tp-tool-time {
        color: var(--text-muted);
        font-family: var(--font-mono);
        flex-shrink: 0;
      }

      .tp-aborting {
        color: var(--warning);
        font-weight: 600;
        font-size: var(--text-xs);
        padding: var(--sp-2) var(--sp-3);
        animation: pulse 1s infinite;
      }

      /* Confirmation dialog */
      .confirm-overlay {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: var(--sp-2) var(--sp-4);
        border-bottom: 1px solid var(--glass-border);
        background: rgba(255, 69, 58, 0.04);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }

      .confirm-overlay .confirm-msg {
        flex: 1;
      }

      /* Thinking indicator */
      .thinking-indicator {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        padding: var(--sp-3) var(--sp-4);
        max-width: 85%;
        margin-bottom: var(--sp-3);
        background: var(--glass-bg);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }

      .thinking-dots {
        display: flex;
        gap: 4px;
      }

      .thinking-dots span {
        width: 6px;
        height: 6px;
        background: var(--text-muted);
        border-radius: 50%;
        animation: thinking-bounce 1.4s ease-in-out infinite;
      }

      .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
      .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

      @keyframes thinking-bounce {
        0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
        40% { opacity: 1; transform: scale(1); }
      }

      /* Message timestamp */
      .msg-time {
        font-size: 9px;
        color: var(--text-muted);
        margin-top: var(--sp-1);
        text-align: right;
      }

      /* Responsive */
      @media (max-width: 768px) {
        .sess-sb { position: fixed; left: 0; top: 0; bottom: 0; z-index: 30; box-shadow: var(--shadow-md); }
        .sess-sb.hidden { display: none; }
      }
    `,
  ];

  @state() private sessions: SessionInfo[] = [];
  @state() private currentSessionId: string | null = localStorage.getItem('cc_sid');
  @state() private messages: ChatMessage[] = [];
  @state() private searchQuery = '';
  @state() private streaming = false;
  @state() private streamText = '';
  @state() private toolSteps: ToolStep[] = [];
  @state() private traceOpen = false;
  @state() private traceData = { iteration: 0, tool: '--', tokens: 0, elapsed: 0, maxIterations: 0 };
  @state() private sessSidebarOpen = true;

  // New state for enhanced features
  @state() private activeSessions: Set<string> = new Set();
  @state() private contextMenuSessionId: string | null = null;
  @state() private aborting = false;
  @state() private traceToolHistory: TraceToolEntry[] = [];
  @state() private showSteerInput = false;
  @state() private showSearchOverlay = false;
  @state() private searchResults: SearchResult[] = [];
  @state() private showCheckpointList = false;
  @state() private checkpoints: CheckpointInfo[] = [];
  @state() private showConfirmCompact = false;
  @state() private showRenameInput = false;
  @state() private renameSessionId: string | null = null;
  @state() private showCheckpointLabel = false;
  @state() private thinking = false;

  @query('#msgInput') private msgInput!: HTMLTextAreaElement;
  @query('.messages') private messagesEl!: HTMLElement;

  private _streamController?: AbortController;
  private _streamStart = 0;
  private _activePollingInterval?: ReturnType<typeof setInterval>;

  connectedCallback() {
    super.connectedCallback();
    this._loadSessions();
    if (this.currentSessionId) {
      this._loadHistory();
    }
    this._startActivePolling();
    // Close context menu on outside click
    this._onDocClick = this._onDocClick.bind(this);
    document.addEventListener('click', this._onDocClick);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._streamController?.abort();
    this._stopActivePolling();
    document.removeEventListener('click', this._onDocClick);
  }

  private _onDocClick() {
    if (this.contextMenuSessionId) {
      this.contextMenuSessionId = null;
    }
  }

  // --- Active session polling ---

  private _startActivePolling() {
    this._pollActiveSessions();
    this._activePollingInterval = setInterval(() => {
      this._pollActiveSessions();
    }, 10_000);
  }

  private _stopActivePolling() {
    if (this._activePollingInterval) {
      clearInterval(this._activePollingInterval);
      this._activePollingInterval = undefined;
    }
  }

  private async _pollActiveSessions() {
    try {
      const data = await api<{ sessions: ActiveSessionInfo[] }>('/api/sessions/active');
      const ids = new Set((data.sessions || []).map((s) => s.sessionId));
      this.activeSessions = ids;
    } catch {
      // ignore polling failures
    }
  }

  private _isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  // --- Session loading ---

  private async _loadSessions() {
    try {
      const data = await api<{
        ok: boolean;
        supported: boolean;
        count: number;
        sessions: Array<{
          sessionId: string;
          messageCount: number;
          updatedAt: string;
          preview?: string;
          userId?: string;
          workspaceId?: string;
          lastRole?: string | null;
        }>;
      }>('/api/sessions');
      const existing = this.sessions.map((s) => s.id);
      const newSessions = (data.sessions || [])
        .filter((s) => !existing.includes(s.sessionId))
        .map((s) => ({
          id: s.sessionId,
          title: '',
          preview: s.preview ?? '',
          messageCount: s.messageCount ?? 0,
          updatedAt: s.updatedAt ?? new Date().toISOString(),
        }));
      this.sessions = [...this.sessions, ...newSessions];
    } catch { /* ignore */ }
  }

  private async _loadHistory() {
    if (!this.currentSessionId) return;
    try {
      const data = await api<{ sessionId: string; messages: ChatMessage[]; updatedAt?: string }>(`/api/sessions/${encodeURIComponent(this.currentSessionId!)}/history`);
      this.messages = data.messages || [];
      this._scrollToBottom();
    } catch {
      this.messages = [];
    }
  }

  private _selectSession(id: string) {
    this.currentSessionId = id;
    localStorage.setItem('cc_sid', id);
    this.sessions = [...this.sessions];
    this._closeAllOverlays();
    this._loadHistory();
  }

  private async _createSession() {
    const id = `s-${Date.now().toString(36)}`;
    this.sessions = [
      { id, title: '', preview: '', messageCount: 0, updatedAt: new Date().toISOString() },
      ...this.sessions,
    ];
    this._selectSession(id);
    try {
      await api('/api/sessions', { method: 'POST', body: JSON.stringify({ sessionId: id }) });
    } catch { /* session will be created on first message if this fails */ }
  }

  private async _deleteSession(e: Event, id: string) {
    e.stopPropagation();
    this.contextMenuSessionId = null;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.currentSessionId === id) {
      this.currentSessionId = null;
      localStorage.removeItem('cc_sid');
      this.messages = [];
    }
    try {
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch { /* ignore */ }
  }

  // --- Context menu ---

  private _openContextMenu(e: Event, sessionId: string) {
    e.stopPropagation();
    e.preventDefault();
    this.contextMenuSessionId = this.contextMenuSessionId === sessionId ? null : sessionId;
  }

  // --- Session operations ---

  private async _abortSession() {
    if (!this.currentSessionId) return;
    this.aborting = true;
    try {
      await api<{ ok: boolean; aborted: boolean }>(`/api/sessions/${encodeURIComponent(this.currentSessionId!)}/abort`, { method: 'POST', body: JSON.stringify({}) });
      this._streamController?.abort();
      this.streaming = false;
      this.streamText = '';
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Abort failed';
      this.messages = [...this.messages, { role: 'system', content: `Abort error: ${msg}` }];
    } finally {
      this.aborting = false;
    }
  }

  private async _compactSession() {
    if (!this.currentSessionId) return;
    this.showConfirmCompact = false;
    try {
      const data = await api<{ ok: boolean; originalMessageCount: number; compactedMessageCount: number; summary: string }>(`/api/sessions/${encodeURIComponent(this.currentSessionId!)}/compact`, { method: 'POST', body: JSON.stringify({}) });
      this.messages = [...this.messages, { role: 'system', content: `Compacted: ${data.originalMessageCount} -> ${data.compactedMessageCount} messages. ${data.summary}` }];
      // Refresh session info
      const session = this.sessions.find((s) => s.id === this.currentSessionId);
      if (session) {
        session.messageCount = data.compactedMessageCount;
        this.sessions = [...this.sessions];
      }
      this._loadHistory();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Compact failed';
      this.messages = [...this.messages, { role: 'system', content: `Compact error: ${msg}` }];
    }
  }

  private async _steerSession(directive: string) {
    if (!this.currentSessionId || !directive.trim()) return;
    this.showSteerInput = false;
    try {
      const data = await api<{ ok: boolean; injectedPrompt: string }>(`/api/sessions/${encodeURIComponent(this.currentSessionId!)}/steer`, { method: 'POST', body: JSON.stringify({ directive: directive.trim() }) });
      this.messages = [...this.messages, { role: 'system', content: `Steered: ${data.injectedPrompt}` }];
      this._scrollToBottom();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Steer failed';
      this.messages = [...this.messages, { role: 'system', content: `Steer error: ${msg}` }];
    }
  }

  private async _checkpointSession(label?: string) {
    if (!this.currentSessionId) return;
    this.showCheckpointLabel = false;
    try {
      await api<{ ok: boolean; checkpoint: unknown }>(`/api/sessions/${encodeURIComponent(this.currentSessionId!)}/checkpoint`, { method: 'POST', body: JSON.stringify({ label: label || undefined }) });
      this.messages = [...this.messages, { role: 'system', content: `Checkpoint created${label ? `: ${label}` : ''}` }];
      this._scrollToBottom();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Checkpoint failed';
      this.messages = [...this.messages, { role: 'system', content: `Checkpoint error: ${msg}` }];
    }
  }

  private async _loadCheckpoints() {
    if (!this.currentSessionId) return;
    this.showCheckpointList = !this.showCheckpointList;
    if (!this.showCheckpointList) return;
    try {
      const data = await api<{ checkpoints: CheckpointInfo[] }>(`/api/sessions/${encodeURIComponent(this.currentSessionId!)}/checkpoints`);
      this.checkpoints = data.checkpoints || [];
    } catch {
      this.checkpoints = [];
    }
  }

  private async _restoreCheckpoint(checkpointId: string) {
    if (!this.currentSessionId) return;
    try {
      await api<{ ok: boolean; restoredTo: string }>(`/api/sessions/${encodeURIComponent(this.currentSessionId!)}/restore`, { method: 'POST', body: JSON.stringify({ checkpointId }) });
      this.showCheckpointList = false;
      this._loadHistory();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Restore failed';
      this.messages = [...this.messages, { role: 'system', content: `Restore error: ${msg}` }];
    }
  }

  private async _searchSession(query: string) {
    if (!this.currentSessionId || !query.trim()) return;
    try {
      const data = await api<{ ok: boolean; results: SearchResult[] }>(`/api/sessions/${encodeURIComponent(this.currentSessionId!)}/search`, { method: 'POST', body: JSON.stringify({ query: query.trim() }) });
      this.searchResults = data.results || [];
    } catch {
      this.searchResults = [];
    }
  }

  private async _renameSession(sessionId: string, name: string) {
    if (!name.trim()) return;
    this.showRenameInput = false;
    this.renameSessionId = null;
    this.contextMenuSessionId = null;
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.title = name.trim();
      this.sessions = [...this.sessions];
    }
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    } catch { /* ignore */ }
  }

  private _closeAllOverlays() {
    this.showSteerInput = false;
    this.showSearchOverlay = false;
    this.showCheckpointList = false;
    this.showConfirmCompact = false;
    this.showRenameInput = false;
    this.showCheckpointLabel = false;
    this.searchResults = [];
  }

  // --- Messaging ---

  private _sendMessage() {
    const text = this.msgInput?.value.trim();
    if (!text || !this.currentSessionId || this.streaming) return;
    this.msgInput.value = '';
    this._autoResizeTextarea();
    this._sendMessageWithText(text);
  }

  private _sendMessageWithText(text: string) {
    if (!text || !this.currentSessionId || this.streaming) return;

    const now = new Date().toISOString();
    this.messages = [...this.messages, { role: 'user', content: text, createdAt: now }];

    const session = this.sessions.find((s) => s.id === this.currentSessionId);
    if (session) {
      session.messageCount++;
      session.updatedAt = now;
      if (!session.title) session.title = text.slice(0, 30);
      session.preview = text.slice(0, 60);
      this.sessions = [...this.sessions];
    }

    this.streaming = true;
    this.thinking = true;
    this.streamText = '';
    this.toolSteps = [];
    this.traceToolHistory = [];
    this._streamStart = Date.now();
    this.traceData = { iteration: 0, tool: '--', tokens: 0, elapsed: 0, maxIterations: 0 };
    this.aborting = false;

    this._scrollToBottom();

    const callbacks: StreamCallbacks = {
      onTextDelta: (content) => {
        this.thinking = false;
        this.streamText += content;
        this.traceData = { ...this.traceData, tokens: this.traceData.tokens + 1 };
        this._scrollToBottom();
      },
      onToolStart: (toolName, toolCallId, input) => {
        this.thinking = false;
        this.toolSteps = [...this.toolSteps, {
          toolCallId, toolName, status: 'running', input,
        }];
        this.traceData = { ...this.traceData, tool: toolName };
        this.traceToolHistory = [...this.traceToolHistory, { toolName, status: 'running' }];
        if (this.streamText.trim()) {
          this.messages = [...this.messages, { role: 'assistant', content: this.streamText, createdAt: new Date().toISOString() }];
          this.streamText = '';
        }
      },
      onToolEnd: (toolCallId, output, success) => {
        const endTime = Date.now();
        this.toolSteps = this.toolSteps.map((s) =>
          s.toolCallId === toolCallId
            ? { ...s, status: success ? 'done' : 'error', output }
            : s,
        );
        // Update trace history
        const histIdx = this.traceToolHistory.findIndex((t) => t.toolName === this.traceData.tool && t.status === 'running');
        if (histIdx >= 0) {
          const updated = [...this.traceToolHistory];
          updated[histIdx] = { ...updated[histIdx], status: success ? 'done' : 'error', elapsed: endTime - this._streamStart };
          this.traceToolHistory = updated;
        }
        const step = this.toolSteps.find((s) => s.toolCallId === toolCallId);
        if (step) {
          this.messages = [...this.messages, { role: 'tool', content: output, name: step.toolName }];
        }
      },
      onIterationStart: (iteration) => {
        this.traceData = { ...this.traceData, iteration, maxIterations: Math.max(this.traceData.maxIterations, iteration + 1) };
        if (this.streamText.trim()) {
          this.messages = [...this.messages, { role: 'assistant', content: this.streamText }];
          this.streamText = '';
        }
        if (iteration > 0) {
          this.messages = [...this.messages, { role: 'iteration', content: `Iteration ${iteration + 1}` }];
        }
      },
      onDone: () => {
        this.thinking = false;
        if (this.streamText.trim()) {
          this.messages = [...this.messages, { role: 'assistant', content: this.streamText, createdAt: new Date().toISOString() }];
        }
        this.streaming = false;
        this.streamText = '';
        this.aborting = false;
        this.traceData = { ...this.traceData, elapsed: Date.now() - this._streamStart };
        this._scrollToBottom();
        this._applyHighlighting();
      },
      onError: (error) => {
        if (error.includes('falling back')) {
          // Informational: stream continues with fallback provider
          this.messages = [...this.messages, { role: 'system', content: error, createdAt: new Date().toISOString() }];
          return;
        }
        this.thinking = false;
        this.streaming = false;
        this.aborting = false;
        this.messages = [...this.messages, { role: 'system', content: `Error: ${error}`, createdAt: new Date().toISOString() }];
        this._scrollToBottom();
      },
    };

    this._streamController = streamMessage(this.currentSessionId, text, callbacks);
  }

  private _inputKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this._sendMessage();
    }
  }

  private _autoResizeTextarea() {
    if (!this.msgInput) return;
    this.msgInput.style.height = 'auto';
    this.msgInput.style.height = Math.min(this.msgInput.scrollHeight, 160) + 'px';
  }

  private _scrollToBottom() {
    requestAnimationFrame(() => {
      if (this.messagesEl) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      }
    });
  }

  private _applyHighlighting() {
    requestAnimationFrame(() => {
      if (this.messagesEl) {
        highlightCodeBlocks(this.messagesEl);
        attachCopyHandlers(this.messagesEl);
      }
    });
  }

  private _toggleStepDetail(e: Event) {
    const row = (e.currentTarget as HTMLElement);
    const detail = row.nextElementSibling;
    if (detail) detail.classList.toggle('open');
  }

  private get _filteredSessions() {
    const q = this.searchQuery.toLowerCase();
    const filtered = q
      ? this.sessions.filter((s) =>
          s.id.toLowerCase().includes(q) ||
          s.title.toLowerCase().includes(q) ||
          s.preview.toLowerCase().includes(q))
      : this.sessions;
    return filtered.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  // --- Render ---

  render() {
    return html`
      <div class="chat-area">
        <!-- Session Sidebar -->
        ${this.sessSidebarOpen ? html`
          <div class="sess-sb" @click=${(e: Event) => e.stopPropagation()}>
            <div class="sess-hdr">
              <input placeholder="Search sessions..."
                     .value=${this.searchQuery}
                     @input=${(e: InputEvent) => { this.searchQuery = (e.target as HTMLInputElement).value; }}>
              <button class="btn btn-p" style="padding:6px 10px" @click=${this._createSession} aria-label="New Session" title="New Session">+</button>
            </div>
            <div class="sess-list">
              ${this._filteredSessions.length === 0
                ? html`<div class="empty" style="padding:20px 0"><div class="empty-subtitle">${this.sessions.length ? 'No matching sessions' : 'No sessions yet'}</div></div>`
                : this._filteredSessions.map((s) => this._renderSessionCard(s))}
            </div>
          </div>
        ` : nothing}

        <!-- Chat Content -->
        <div class="chat-content" style="position:relative">
          <button class="sess-toggle-btn" @click=${() => { this.sessSidebarOpen = !this.sessSidebarOpen; }} aria-label="Toggle sidebar">&#9776;</button>

          <!-- Operations Toolbar -->
          ${this.currentSessionId ? this._renderOpsToolbar() : nothing}

          <!-- Overlays -->
          ${this._renderOverlays()}

          <div class="messages">
            ${!this.currentSessionId
              ? html`<div class="empty"><div class="empty-title">No Session</div><div class="empty-subtitle">Create a session to start</div></div>`
              : this.messages.length === 0 && !this.streaming
                ? html`<div class="empty"><div class="empty-title">New Session</div><div class="empty-subtitle">Type a message to begin.</div></div>`
                : html`
                    ${this.messages.map((m, i) => this._renderMessage(m, i))}
                    ${this.streaming && this.thinking ? html`
                      <div class="thinking-indicator">
                        <div class="thinking-dots"><span></span><span></span><span></span></div>
                        Thinking...
                      </div>
                    ` : nothing}
                    ${this.streaming && this.streamText ? html`
                      <div class="msg assistant streaming">
                        <span class="role-tag">assistant</span>
                        <div class="md">${unsafeHTML(renderMarkdown(this.streamText))}</div>
                        <span class="cursor-blink"></span>
                      </div>
                    ` : nothing}
                  `}
          </div>

          <!-- Chat Input -->
          <div class="chat-input">
            <textarea id="msgInput" placeholder="Send a message... (Shift+Enter for newline)"
                      rows="1"
                      ?disabled=${!this.currentSessionId}
                      @keydown=${this._inputKeydown}
                      @input=${this._autoResizeTextarea}></textarea>
            <button class="send-btn" @click=${this._sendMessage}
                    ?disabled=${!this.currentSessionId || this.streaming}
                    aria-label="Send message">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>

          <!-- Trace Panel -->
          <button class="trace-toggle" @click=${() => { this.traceOpen = !this.traceOpen; }} aria-label="Toggle trace panel">T</button>
          ${this._renderTracePanel()}
        </div>
      </div>
    `;
  }

  // --- Rich session card ---

  private _renderSessionCard(s: SessionInfo) {
    const isActive = this._isSessionActive(s.id);
    const isCurrent = s.id === this.currentSessionId;
    const showMenu = this.contextMenuSessionId === s.id;

    return html`
      <div class="sess-item ${isCurrent ? 'active' : ''}"
           @click=${() => this._selectSession(s.id)}>
        <div class="sess-actions">
          <button @click=${(e: Event) => this._openContextMenu(e, s.id)} aria-label="Session actions" title="Actions">...</button>
        </div>
        ${showMenu ? html`
          <div class="sess-ctx-menu" @click=${(e: Event) => e.stopPropagation()}>
            <button @click=${(e: Event) => { e.stopPropagation(); this.contextMenuSessionId = null; this.renameSessionId = s.id; this.showRenameInput = true; this._selectSession(s.id); }}>Rename</button>
            <button @click=${(e: Event) => { e.stopPropagation(); this.contextMenuSessionId = null; this._selectSession(s.id); this._checkpointSession(); }}>Checkpoint</button>
            <button @click=${(e: Event) => { e.stopPropagation(); this.contextMenuSessionId = null; this._selectSession(s.id); this.showConfirmCompact = true; }}>Compact</button>
            <button class="danger" @click=${(e: Event) => this._deleteSession(e, s.id)}>Delete</button>
          </div>
        ` : nothing}
        <div class="sess-item-top">
          ${isActive ? html`<span class="sess-active-dot" title="Active"></span>` : nothing}
          <span class="sess-id" title="${s.id}">${truncateId(s.id)}</span>
        </div>
        <div class="sess-title">${s.title || s.preview?.slice(0, 30) || 'Untitled'}</div>
        ${s.preview ? html`<div class="sess-preview">${s.preview.slice(0, 80)}</div>` : nothing}
        <div class="sess-meta">
          <span>${timeAgo(s.updatedAt)}</span>
          <span class="sess-badge">${s.messageCount}</span>
        </div>
        ${s.contextPct !== undefined ? html`
          <div class="sess-ctx"><div class="sess-ctx-bar" style="width:${Math.min(100, s.contextPct)}%"></div></div>
        ` : nothing}
      </div>
    `;
  }

  // --- Operations toolbar ---

  private _renderOpsToolbar() {
    const isActive = this.currentSessionId ? this._isSessionActive(this.currentSessionId) : false;
    const canAbort = this.streaming || isActive;

    return html`
      <div class="ops-toolbar">
        <span class="ops-label">Ops</span>
        ${canAbort ? html`
          <button class="ops-btn ${this.aborting ? 'aborting' : 'danger'}"
                  @click=${this._abortSession}
                  ?disabled=${this.aborting}
                  aria-label="Abort session">
            ${this.aborting ? 'Aborting...' : 'Abort'}
          </button>
        ` : nothing}
        <button class="ops-btn"
                @click=${() => { this._closeAllOverlays(); this.showConfirmCompact = true; }}
                aria-label="Compact session">
          Compact
        </button>
        <button class="ops-btn"
                @click=${() => { this._closeAllOverlays(); this.showSteerInput = !this.showSteerInput; }}
                aria-label="Steer session">
          Steer
        </button>
        <div class="ops-sep"></div>
        <button class="ops-btn"
                @click=${() => { this._closeAllOverlays(); this.showCheckpointLabel = true; }}
                aria-label="Create checkpoint">
          Checkpoint
        </button>
        <button class="ops-btn"
                @click=${() => { this._closeAllOverlays(); this._loadCheckpoints(); }}
                aria-label="View checkpoint history">
          History
        </button>
        <div class="ops-sep"></div>
        <button class="ops-btn"
                @click=${() => { this._closeAllOverlays(); this.showSearchOverlay = !this.showSearchOverlay; this.searchResults = []; }}
                aria-label="Search messages">
          Search
        </button>
      </div>
    `;
  }

  // --- Overlays (steer, search, checkpoints, confirm, rename) ---

  private _renderOverlays() {
    return html`
      ${this.showConfirmCompact ? html`
        <div class="confirm-overlay">
          <span class="confirm-msg">Compact this session? This will summarize and reduce message count.</span>
          <button class="ops-btn danger" @click=${this._compactSession} aria-label="Confirm compact">Confirm</button>
          <button class="ops-btn" @click=${() => { this.showConfirmCompact = false; }} aria-label="Cancel compact">Cancel</button>
        </div>
      ` : nothing}

      ${this.showSteerInput ? html`
        <div class="steer-overlay">
          <input placeholder="Enter directive to steer the session..."
                 @keydown=${(e: KeyboardEvent) => {
                   if (e.key === 'Enter') {
                     this._steerSession((e.target as HTMLInputElement).value);
                   } else if (e.key === 'Escape') {
                     this.showSteerInput = false;
                   }
                 }}>
          <button class="ops-btn" @click=${(e: Event) => {
            const input = (e.target as HTMLElement).previousElementSibling as HTMLInputElement;
            if (input) this._steerSession(input.value);
          }} aria-label="Send steer directive">Send</button>
          <button class="ops-btn" @click=${() => { this.showSteerInput = false; }} aria-label="Close steer">X</button>
        </div>
      ` : nothing}

      ${this.showCheckpointLabel ? html`
        <div class="steer-overlay">
          <input placeholder="Checkpoint label (optional, press Enter)..."
                 @keydown=${(e: KeyboardEvent) => {
                   if (e.key === 'Enter') {
                     this._checkpointSession((e.target as HTMLInputElement).value || undefined);
                   } else if (e.key === 'Escape') {
                     this.showCheckpointLabel = false;
                   }
                 }}>
          <button class="ops-btn" @click=${(e: Event) => {
            const input = (e.target as HTMLElement).previousElementSibling as HTMLInputElement;
            this._checkpointSession(input?.value || undefined);
          }} aria-label="Create checkpoint">Create</button>
          <button class="ops-btn" @click=${() => { this.showCheckpointLabel = false; }} aria-label="Cancel checkpoint">X</button>
        </div>
      ` : nothing}

      ${this.showRenameInput && this.renameSessionId ? html`
        <div class="rename-overlay">
          <input placeholder="New session name..."
                 @keydown=${(e: KeyboardEvent) => {
                   if (e.key === 'Enter' && this.renameSessionId) {
                     this._renameSession(this.renameSessionId, (e.target as HTMLInputElement).value);
                   } else if (e.key === 'Escape') {
                     this.showRenameInput = false;
                     this.renameSessionId = null;
                   }
                 }}>
          <button class="ops-btn" @click=${(e: Event) => {
            const input = (e.target as HTMLElement).previousElementSibling as HTMLInputElement;
            if (input && this.renameSessionId) this._renameSession(this.renameSessionId, input.value);
          }} aria-label="Confirm rename">Rename</button>
          <button class="ops-btn" @click=${() => { this.showRenameInput = false; this.renameSessionId = null; }} aria-label="Cancel rename">X</button>
        </div>
      ` : nothing}

      ${this.showSearchOverlay ? html`
        <div class="search-overlay">
          <div class="search-row">
            <input placeholder="Search messages in this session..."
                   @keydown=${(e: KeyboardEvent) => {
                     if (e.key === 'Enter') {
                       this._searchSession((e.target as HTMLInputElement).value);
                     } else if (e.key === 'Escape') {
                       this.showSearchOverlay = false;
                       this.searchResults = [];
                     }
                   }}>
            <button class="ops-btn" @click=${(e: Event) => {
              const input = (e.target as HTMLElement).previousElementSibling as HTMLInputElement;
              if (input) this._searchSession(input.value);
            }} aria-label="Search">Go</button>
            <button class="ops-btn" @click=${() => { this.showSearchOverlay = false; this.searchResults = []; }} aria-label="Close search">X</button>
          </div>
          ${this.searchResults.length > 0 ? html`
            <div class="search-results">
              ${this.searchResults.map((r) => html`
                <div class="search-result-item" @click=${() => this._scrollToMessage(r.messageIndex)}>
                  <span class="sr-role">${r.role}</span>
                  <span class="sr-content">${r.content.slice(0, 120)}</span>
                </div>
              `)}
            </div>
          ` : nothing}
        </div>
      ` : nothing}

      ${this.showCheckpointList ? html`
        <div class="checkpoint-overlay">
          <div class="cp-hdr">
            <span>Checkpoints</span>
            <button class="ops-btn" @click=${() => { this.showCheckpointList = false; }} aria-label="Close checkpoints">X</button>
          </div>
          ${this.checkpoints.length === 0
            ? html`<div style="font-size:var(--text-xs);color:var(--text-muted);padding:var(--sp-2) 0">No checkpoints</div>`
            : this.checkpoints.map((cp) => html`
                <div class="cp-item">
                  <span class="cp-label">${cp.label || cp.id.slice(0, 12)}</span>
                  <span class="cp-time">${timeAgo(cp.createdAt)}</span>
                  <button class="cp-restore" @click=${() => this._restoreCheckpoint(cp.id)} aria-label="Restore checkpoint">Restore</button>
                </div>
              `)}
        </div>
      ` : nothing}
    `;
  }

  private _scrollToMessage(index: number) {
    requestAnimationFrame(() => {
      if (!this.messagesEl) return;
      const msgs = this.messagesEl.querySelectorAll('.msg, .tool-step, .iter-sep');
      if (msgs[index]) {
        msgs[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  // --- Enhanced Trace Panel ---

  private _renderTracePanel() {
    return html`
      <div class="trace-panel ${this.traceOpen ? 'open' : ''}">
        <div class="tp-hdr">
          <span>Trace</span>
          ${this.streaming ? html`
            <button class="tp-stop-btn" @click=${this._abortSession} aria-label="Stop streaming">Stop</button>
          ` : nothing}
        </div>
        <div class="tp-body">
          <div class="tp-row">
            <span>Iteration</span>
            <span>${this.traceData.iteration + 1}${this.traceData.maxIterations > 1 ? ` / ${this.traceData.maxIterations}` : ''}</span>
          </div>
          <div class="tp-row"><span>Current Tool</span><span>${this.traceData.tool}</span></div>
          <div class="tp-row"><span>Tokens</span><span>${this.traceData.tokens}</span></div>
          <div class="tp-row">
            <span>Elapsed</span>
            <span>${this.streaming ? `${Math.floor((Date.now() - this._streamStart) / 1000)}s` : `${this.traceData.elapsed}ms`}</span>
          </div>
          ${this.aborting ? html`<div class="tp-aborting">Aborting...</div>` : nothing}
        </div>
        ${this.traceToolHistory.length > 0 ? html`
          <div class="tp-section-label">Tool History</div>
          <div class="tp-tool-list">
            ${this.traceToolHistory.map((t) => html`
              <div class="tp-tool-entry">
                <span class="tp-tool-dot ${t.status}"></span>
                <span class="tp-tool-name">${t.toolName}</span>
                ${t.elapsed !== undefined ? html`<span class="tp-tool-time">${t.elapsed}ms</span>` : nothing}
              </div>
            `)}
          </div>
        ` : nothing}
      </div>
    `;
  }

  // --- Message rendering ---

  private _renderMessage(msg: ChatMessage, index: number) {
    if (msg.role === 'iteration') {
      return html`<div class="iter-sep">${msg.content}</div>`;
    }

    if (msg.role === 'tool') {
      const ok = !msg.content?.match(/error|fail/i);
      return html`
        <div class="tool-step">
          <div class="sf-row ${ok ? 'ok' : 'er'}" @click=${this._toggleStepDetail}>
            <span class="sf-dot ${ok ? 'ok' : 'er'}"></span>
            <span class="sf-name">${msg.name ?? 'tool'}</span>
            <span class="sf-status" style="color:${ok ? 'var(--success)' : 'var(--error)'}">${ok ? 'done' : 'error'}</span>
          </div>
          <div class="sf-detail">${msg.content?.slice(0, 500)}</div>
        </div>
      `;
    }

    const roleClass = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system';
    const content = msg.role === 'user'
      ? escapeHtml(msg.content)
      : renderMarkdown(msg.content);

    return html`
      <div class="msg ${roleClass}">
        <span class="role-tag">${msg.role}${msg.name ? ` / ${msg.name}` : ''}</span>
        ${msg.role === 'user'
          ? html`${msg.content}`
          : html`<div class="md">${unsafeHTML(content)}</div>`}
        ${msg.role === 'assistant' && index > 0
          ? html`<button class="btn retry-btn" @click=${() => this._retryMessage(index)}>Retry</button>`
          : nothing}
        ${msg.createdAt ? html`<div class="msg-time">${timeAgo(msg.createdAt)}</div>` : nothing}
      </div>
    `;
  }

  private _retryMessage(index: number) {
    for (let i = index - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        const retryText = this.messages[i].content;
        this.messages = this.messages.slice(0, i);
        this._sendMessageWithText(retryText);
        break;
      }
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-chat-view': ChatView;
  }
}
