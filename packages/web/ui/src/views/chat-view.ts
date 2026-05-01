import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { api } from '../lib/api.js';
import { streamMessage, type StreamCallbacks } from '../lib/sse.js';
import { renderMarkdown, highlightCodeBlocks, attachCopyHandlers } from '../lib/markdown.js';
import { buttonStyles } from '../lib/shared-styles.js';
import { showToast } from '../components/toast.js';
// v0.7.0 #193/#194/#195 — register the new session-action components and
// pull in their public types for typed props.
import '../components/steer-composer.js';
import '../components/fork-modal.js';
import '../components/checkpoint-panel.js';
// v0.7.1 #224 — register tool-call-trace + memory-stream so they actually
// render in the DOM. Both components ship in the bundle but were never
// mounted in any view template prior to this fix.
import '../components/tool-call-trace.js';
import '../components/memory-stream.js';
// v0.8.0 (#231) — register `<crowclaw-reasoning-block>` so chat-view can mount
// it inline above assistant content (both persisted and live-streaming).
import '../components/reasoning-block.js';
// v0.8.0 #234 — register the code-execute trace so chat-view can mount it
// inline whenever a `code.execute` tool message appears. The only other
// change in this file is the sibling-branch in `_renderMessage` below.
import '../components/code-execute-trace.js';
import type { ForkParentInfo } from '../components/fork-modal.js';
import type { ToolTraceEntry } from '../components/tool-call-trace.js';
import type { CodeExecuteTraceData } from '../components/code-execute-trace.js';
import type { MemoryStreamEvent } from '../components/memory-stream.js';

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
  /**
   * Sub-classifies `system` messages so the renderer can show distinct
   * icons/colors for steers, compactions, restores, etc. without relying
   * on string-matching the content.
   */
  kind?: 'steer' | 'compact' | 'restore' | 'checkpoint' | 'abort' | 'fork' | 'error' | 'info';
  /**
   * v0.8.0 (#231): Hermes-style reasoning blocks parsed from the model
   * output (e.g. `<plan>`, `<reasoning>`, `<reflection>`, `<thinking>`).
   * Rendered inline above the assistant text via `<crowclaw-reasoning-block>`.
   */
  reasoningBlocks?: Array<{ tag: string; content: string }>;
}

/** v0.8.0 (#231): live reasoning state during a single streaming turn. */
interface LiveReasoningBlock {
  tag: string;
  content: string;
  /** True until the matching `reasoning-end` arrives. */
  open: boolean;
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

      /* v0.7.0 #193: sticky bottom-of-stream Steer affordance. The wrap
         hugs the bottom of the messages list so the button + composer
         track the chat content rather than pinning to the viewport. */
      .steer-sticky-wrap {
        padding: var(--sp-2) var(--sp-4);
        border-top: 1px solid var(--glass-border);
        background: var(--bg-secondary);
        display: flex;
        flex-direction: column;
        gap: var(--sp-2);
      }

      .steer-sticky-btn {
        align-self: flex-end;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border: 1px solid rgba(255, 214, 10, 0.3);
        background: rgba(255, 214, 10, 0.08);
        color: var(--warning);
        font-size: var(--text-xs);
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        border-radius: var(--radius-sm);
        transition: background var(--duration-fast);
      }

      .steer-sticky-btn:hover {
        background: rgba(255, 214, 10, 0.14);
      }

      .steer-sticky-btn svg {
        width: 12px;
        height: 12px;
      }

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

      /* Steered messages — distinct yellow/warning accent so they stand
         apart from generic system notices (compact summaries, restore
         notices, etc.). Issue #144. */
      .msg.steer {
        background: rgba(255, 214, 10, 0.06);
        border: 1px solid rgba(255, 214, 10, 0.25);
        border-left: 3px solid var(--warning);
        font-size: var(--text-sm);
        color: var(--text-primary);
        display: flex;
        gap: var(--sp-2);
        align-items: flex-start;
      }
      .msg.steer .kind-icon {
        flex-shrink: 0;
        color: var(--warning);
        margin-top: 2px;
      }
      .msg.steer .role-tag { color: var(--warning); }

      .msg.compact {
        background: rgba(48, 209, 88, 0.04);
        border: 1px solid rgba(48, 209, 88, 0.2);
        border-left: 3px solid var(--success);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .msg.compact .role-tag { color: var(--success); }

      .msg.checkpoint {
        background: rgba(100, 210, 255, 0.04);
        border: 1px solid rgba(100, 210, 255, 0.2);
        border-left: 3px solid var(--info);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .msg.checkpoint .role-tag { color: var(--info); }

      .msg.error {
        background: rgba(255, 69, 58, 0.05);
        border: 1px solid rgba(255, 69, 58, 0.2);
        border-left: 3px solid var(--error);
        font-size: var(--text-xs);
        color: var(--text-primary);
      }
      .msg.error .role-tag { color: var(--error); }

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
        border-radius: var(--radius-sm);
        z-index: 5;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }

      .trace-toggle svg { display: block; }

      .trace-toggle:hover { color: var(--accent); border-color: var(--accent); }

      /* v0.7.1 #224 — collapsible right-side memory-stream panel.
         Shares the visual language of the trace-toggle/trace-panel pair so
         operators recognize it as another "inspector" affordance. */
      .memory-toggle {
        position: absolute;
        bottom: 100px;
        right: 12px;
        width: 28px;
        height: 28px;
        background: var(--bg-tertiary);
        border: 1px solid var(--glass-border);
        color: var(--text-muted);
        cursor: pointer;
        border-radius: var(--radius-sm);
        z-index: 5;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }

      .memory-toggle svg { display: block; }

      .memory-toggle:hover { color: var(--accent); border-color: var(--accent); }

      .memory-toggle .memory-badge {
        position: absolute;
        top: -4px;
        right: -4px;
        min-width: 14px;
        height: 14px;
        padding: 0 4px;
        background: var(--accent);
        color: #fff;
        font-size: 9px;
        font-weight: 700;
        border-radius: 7px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }

      .memory-panel {
        position: absolute;
        bottom: 100px;
        right: 48px;
        width: 320px;
        max-height: 60vh;
        z-index: 5;
        display: none;
        overflow-y: auto;
      }

      .memory-panel.open { display: block; }

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
  /**
   * v0.8.0 (#231): live reasoning blocks for the in-flight streaming turn.
   * Driven by `reasoning-start` / `reasoning-delta` / `reasoning-end` SSE
   * events; flushed onto the persisted assistant message at `onDone` so the
   * blocks survive past the streaming surface.
   */
  @state() private streamReasoning: LiveReasoningBlock[] = [];
  @state() private toolSteps: ToolStep[] = [];
  @state() private traceOpen = false;
  @state() private traceData = { iteration: 0, tool: '--', tokens: 0, elapsed: 0, maxIterations: 0 };
  @state() private sessSidebarOpen = true;

  // New state for enhanced features
  @state() private activeSessions: Set<string> = new Set();
  @state() private contextMenuSessionId: string | null = null;
  @state() private aborting = false;
  @state() private traceToolHistory: TraceToolEntry[] = [];
  @state() private showSearchOverlay = false;
  @state() private searchResults: SearchResult[] = [];
  @state() private showConfirmCompact = false;
  @state() private showRenameInput = false;
  @state() private renameSessionId: string | null = null;
  @state() private thinking = false;

  // v0.7.1 #224 — memory-stream side panel state. Events are appended as
  // they arrive on the window-level `crowclaw-event` bridge (memory:captured
  // / memory:recalled). The panel is collapsible via `showMemoryPanel`.
  @state() private showMemoryPanel = false;
  @state() private memoryEvents: MemoryStreamEvent[] = [];

  // v0.7.0 #193/#194/#195: state for the new session-action components.
  // These flags are independent from the legacy inline overlays so the old
  // ops-toolbar paths keep working — the new component-driven flows are
  // additive triggers (sticky-bottom Steer button, 3-dot Fork item,
  // header-level Checkpoints panel button).
  @state() private showSteerComposer = false;
  @state() private showForkModal = false;
  @state() private forkParentInfo: ForkParentInfo | null = null;
  @state() private forkAvailableToolsets: string[] = [];
  @state() private showCheckpointPanel = false;
  @state() private checkpointCount = 0;
  /**
   * When true, the WS transport has fallen back to SSE-heartbeats-only.
   * `_sendMessageWithText` then uses the synchronous REST endpoint
   * (POST /api/sessions/:id) instead of the streaming endpoint, so the
   * user still gets a reply rather than an apparently-frozen UI. Issue #141.
   */
  @state() private transportFallback = false;

  @query('#msgInput') private msgInput!: HTMLTextAreaElement;
  @query('.messages') private messagesEl!: HTMLElement;

  private _streamController?: AbortController;
  private _streamStart = 0;
  private _activePollingInterval?: ReturnType<typeof setInterval>;

  private _transportFallbackHandler = (e: Event) => {
    const detail = (e as CustomEvent<{ active: boolean }>).detail;
    this.transportFallback = !!detail?.active;
  };

  /**
   * v0.7.1 #224 — listens to the window-level `crowclaw-event` bridge for
   * `memory:captured` / `memory:recalled` event types and appends them to
   * the side-panel feed. The orchestrator (app.ts) currently bridges
   * `session:` / `gateway:` / `job:` events; once the runtime EventBus
   * starts forwarding `memory:*` through the same bridge, this handler
   * picks them up automatically.
   *
   * TODO: wire memory:* event passthrough in app.ts so the bridge actually
   * dispatches these. Until then this listener is a no-op but the panel
   * still renders (with an empty state).
   */
  private _memoryEventHandler = (e: Event) => {
    const detail = (e as CustomEvent<{ type?: string; data?: Record<string, unknown> }>).detail;
    const type = detail?.type;
    if (type !== 'memory:captured' && type !== 'memory:recalled') return;
    const data = detail?.data ?? {};
    const kind: 'captured' | 'recalled' = type === 'memory:captured' ? 'captured' : 'recalled';
    const evt: MemoryStreamEvent = {
      kind,
      timestamp: new Date().toISOString(),
      sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
      memoryId: typeof data.memoryId === 'string' ? data.memoryId : undefined,
      summary: typeof data.summary === 'string' ? data.summary : undefined,
      scope: typeof data.scope === 'string' ? data.scope : undefined,
      tags: Array.isArray(data.tags) ? (data.tags as string[]) : undefined,
      query: typeof data.query === 'string' ? data.query : undefined,
      hits: typeof data.hits === 'number' ? data.hits : undefined,
      ids: Array.isArray(data.ids) ? (data.ids as string[]) : undefined,
      summaries: Array.isArray(data.summaries) ? (data.summaries as string[]) : undefined,
    };
    this.memoryEvents = [...this.memoryEvents, evt];
  };

  /**
   * Refresh on session lifecycle events emitted by the runtime EventBus
   * (steered/aborted/forked/compacted). Each event triggers a session-list
   * reload so message-counts and active-state stay accurate, and — when
   * the event matches the open session — a timeline marker injects so the
   * user sees what just happened in real-time. Issue #140.
   */
  private _sessionEventHandler = (e: Event) => {
    const { type, data } = (e as CustomEvent<{ type: string; data: Record<string, unknown> }>).detail;
    const sid = typeof data.sessionId === 'string' ? data.sessionId : '';
    if (sid && sid === this.currentSessionId) {
      switch (type) {
        case 'session:steered': {
          const directive = typeof data.directive === 'string' ? data.directive : '';
          this.messages = [...this.messages, {
            role: 'system',
            kind: 'steer',
            content: directive || 'Session steered',
            createdAt: new Date().toISOString(),
          }];
          break;
        }
        case 'session:aborted':
          this.messages = [...this.messages, {
            role: 'system',
            kind: 'abort',
            content: 'Session aborted',
            createdAt: new Date().toISOString(),
          }];
          break;
        case 'session:forked': {
          const newSessionId = typeof data.newSessionId === 'string' ? data.newSessionId : '';
          this.messages = [...this.messages, {
            role: 'system',
            kind: 'fork',
            content: newSessionId ? `Forked to session ${newSessionId.slice(0, 8)}` : 'Session forked',
            createdAt: new Date().toISOString(),
          }];
          break;
        }
        case 'session:compacted': {
          const before = typeof data.beforeMessageCount === 'number' ? data.beforeMessageCount : 0;
          const after = typeof data.afterMessageCount === 'number' ? data.afterMessageCount : 0;
          this.messages = [...this.messages, {
            role: 'system',
            kind: 'compact',
            content: `Session compacted: ${before} -> ${after} messages`,
            createdAt: new Date().toISOString(),
          }];
          // Also refresh history because message ids changed.
          this._loadHistory();
          // Compaction rewrites message indices that older checkpoints
          // reference — refresh the panel + count so stale rows clear.
          void this._loadCheckpointCount();
          const cpPanel = this.renderRoot?.querySelector?.('crowclaw-checkpoint-panel') as
            | (HTMLElement & { refresh: () => Promise<void> })
            | null;
          void cpPanel?.refresh?.();
          break;
        }
      }
    }
    // Always refresh the session list so counts/last-updated are correct.
    void this._loadSessions();
  };

  connectedCallback() {
    super.connectedCallback();
    this._loadSessions();
    if (this.currentSessionId) {
      this._loadHistory();
      // Prime the checkpoint badge so the header button is labelled
      // `Checkpoints (N)` from first paint.
      void this._loadCheckpointCount();
    }
    this._startActivePolling();
    // Close context menu on outside click
    this._onDocClick = this._onDocClick.bind(this);
    document.addEventListener('click', this._onDocClick);
    document.addEventListener('crowclaw:transport-fallback', this._transportFallbackHandler);
    document.addEventListener('crowclaw:session-event', this._sessionEventHandler);
    window.addEventListener('crowclaw-event', this._memoryEventHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._streamController?.abort();
    this._stopActivePolling();
    document.removeEventListener('click', this._onDocClick);
    document.removeEventListener('crowclaw:transport-fallback', this._transportFallbackHandler);
    document.removeEventListener('crowclaw:session-event', this._sessionEventHandler);
    window.removeEventListener('crowclaw-event', this._memoryEventHandler);
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
          title?: string;
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
          title: s.title ?? '',
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
    // Refresh the checkpoint badge for the new session so the header
    // button label `Checkpoints (N)` is accurate without opening the panel.
    void this._loadCheckpointCount();
  }

  private async _createSession() {
    // Server is the authority on session IDs to prevent collision and ID
    // enumeration. We POST with an empty body and use the returned sessionId.
    try {
      const data = await api<{ ok: boolean; session: { sessionId: string; updatedAt: string } }>(
        '/api/sessions',
        { method: 'POST', body: JSON.stringify({}) },
      );
      const id = data.session.sessionId;
      this.sessions = [
        { id, title: '', preview: '', messageCount: 0, updatedAt: data.session.updatedAt },
        ...this.sessions,
      ];
      this._selectSession(id);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to create session';
      showToast(msg, 'error');
    }
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
      this.streamReasoning = [];
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Abort failed';
      this.messages = [...this.messages, { role: 'system', kind: 'error', content: `Abort error: ${msg}` }];
    } finally {
      this.aborting = false;
    }
  }

  private async _compactSession() {
    if (!this.currentSessionId) return;
    this.showConfirmCompact = false;
    try {
      const data = await api<{ ok: boolean; originalMessageCount: number; compactedMessageCount: number; summary: string }>(`/api/sessions/${encodeURIComponent(this.currentSessionId!)}/compact`, { method: 'POST', body: JSON.stringify({}) });
      this.messages = [...this.messages, { role: 'system', kind: 'compact', content: `Compacted: ${data.originalMessageCount} -> ${data.compactedMessageCount} messages. ${data.summary}` }];
      // Refresh session info
      const session = this.sessions.find((s) => s.id === this.currentSessionId);
      if (session) {
        session.messageCount = data.compactedMessageCount;
        this.sessions = [...this.sessions];
      }
      this._loadHistory();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Compact failed';
      this.messages = [...this.messages, { role: 'system', kind: 'error', content: `Compact error: ${msg}` }];
    }
  }

  private async _checkpointSession(label?: string) {
    if (!this.currentSessionId) return;
    try {
      await api<{ ok: boolean; checkpoint: unknown }>(`/api/sessions/${encodeURIComponent(this.currentSessionId!)}/checkpoint`, { method: 'POST', body: JSON.stringify({ label: label || undefined }) });
      this.messages = [...this.messages, { role: 'system', kind: 'checkpoint', content: `Checkpoint created${label ? `: ${label}` : ''}` }];
      this._scrollToBottom();
      void this._loadCheckpointCount();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Checkpoint failed';
      this.messages = [...this.messages, { role: 'system', kind: 'error', content: `Checkpoint error: ${msg}` }];
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
    this.showSearchOverlay = false;
    this.showConfirmCompact = false;
    this.showRenameInput = false;
    this.searchResults = [];
    // The new session-action components are also overlay-style affordances —
    // close them so swapping between Steer/Fork/Checkpoints is mutually
    // exclusive and the screen never has two competing overlays open.
    this.showSteerComposer = false;
    this.showForkModal = false;
    this.showCheckpointPanel = false;
  }

  // --- v0.7.0 #193/#194/#195: session-action component handlers ---

  /**
   * Called when the operator clicks the sticky 'Steer' button while the
   * session is running. Toggles the slide-up composer; closing other
   * overlays first prevents UI overlap.
   */
  private _toggleSteerComposer() {
    if (!this.currentSessionId) return;
    if (this.showSteerComposer) {
      this.showSteerComposer = false;
      return;
    }
    this._closeAllOverlays();
    this.showSteerComposer = true;
    requestAnimationFrame(() => {
      const composer = this.renderRoot.querySelector('crowclaw-steer-composer') as
        | (HTMLElement & { focusInput: () => void })
        | null;
      composer?.focusInput?.();
    });
  }

  /**
   * Steer composer success — drop a 'pending' marker into the chat
   * stream. The marker style flips to 'applied' once the EventBus
   * `session:steered` event arrives (see `_sessionEventHandler`).
   */
  private _onSteered(e: CustomEvent<{ directive: string; injectedPrompt: string }>) {
    this.showSteerComposer = false;
    this.messages = [...this.messages, {
      role: 'system',
      kind: 'steer',
      content: e.detail.injectedPrompt || e.detail.directive,
      createdAt: new Date().toISOString(),
    }];
    this._scrollToBottom();
  }

  /**
   * Open the fork modal for the given session row. Pre-loads the toolset
   * list from `/api/agent/identity` so the chip selector renders the
   * right options. Lookup is best-effort — if the identity endpoint
   * fails, the modal still works and just shows 'inherit parent'.
   */
  private async _openForkModal(sessionId: string) {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    this.contextMenuSessionId = null;
    this._closeAllOverlays();
    this.forkParentInfo = {
      sessionId: session.id,
      title: session.title || undefined,
      preview: session.preview || undefined,
    };
    // Best-effort toolset enumeration; empty list is a valid fallback.
    try {
      const data = await api<{ toolsets?: Array<{ name: string }> }>('/api/agent/identity');
      this.forkAvailableToolsets = (data.toolsets ?? []).map((t) => t.name);
    } catch {
      this.forkAvailableToolsets = [];
    }
    this.showForkModal = true;
  }

  /**
   * Fork modal success — navigate to the newly-created child session
   * and refresh the session list so the new row appears immediately.
   */
  private _onForked(e: CustomEvent<{ parentSessionId: string; forkSessionId: string }>) {
    this.showForkModal = false;
    this.forkParentInfo = null;
    void this._loadSessions();
    // Switching session triggers history load + scroll-to-bottom.
    this._selectSession(e.detail.forkSessionId);
  }

  /**
   * Toggle the checkpoint side panel. Loading the count up front lets
   * the header button label as `Checkpoints (N)` even while collapsed.
   */
  private _toggleCheckpointPanel() {
    if (!this.currentSessionId) return;
    if (this.showCheckpointPanel) {
      this.showCheckpointPanel = false;
      return;
    }
    this._closeAllOverlays();
    this.showCheckpointPanel = true;
  }

  /**
   * Checkpoint restored — reload history so the chat reflects the
   * rewound state, and drop a system marker so the operator sees what
   * happened.
   */
  private _onCheckpointRestored(e: CustomEvent<{ checkpointId: string; messageCount?: number; restoredIteration?: number }>) {
    const target = e.detail.restoredIteration !== undefined
      ? `iteration ${e.detail.restoredIteration}`
      : `checkpoint ${e.detail.checkpointId.slice(0, 8)}`;
    this.messages = [...this.messages, {
      role: 'system',
      kind: 'restore',
      content: `Restored to ${target}${e.detail.messageCount !== undefined ? ` (${e.detail.messageCount} messages)` : ''}`,
      createdAt: new Date().toISOString(),
    }];
    void this._loadHistory();
  }

  /**
   * Replay opened — switch the dashboard to the new replay session so
   * the operator can immediately interact with the cloned state.
   */
  private _onReplayOpened(e: CustomEvent<{ newSessionId: string; sourceCheckpointId: string }>) {
    this.showCheckpointPanel = false;
    void this._loadSessions();
    this._selectSession(e.detail.newSessionId);
  }

  /**
   * Track checkpoint count for the header button label. Called once on
   * session change so the button reads `Checkpoints (N)` without
   * forcing the panel open. Failures fall back to '0' silently.
   */
  private async _loadCheckpointCount() {
    if (!this.currentSessionId) {
      this.checkpointCount = 0;
      return;
    }
    try {
      const data = await api<{ checkpoints?: Array<unknown> }>(
        `/api/sessions/${encodeURIComponent(this.currentSessionId)}/checkpoints`,
      );
      this.checkpointCount = (data.checkpoints ?? []).length;
    } catch {
      this.checkpointCount = 0;
    }
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
    this.streamReasoning = [];
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
        if (this.streamText.trim() || this.streamReasoning.length > 0) {
          this.messages = [...this.messages, { role: 'assistant', content: this.streamText, reasoningBlocks: this._snapshotReasoning() }];
          this.streamText = '';
          this.streamReasoning = [];
        }
        if (iteration > 0) {
          this.messages = [...this.messages, { role: 'iteration', content: `Iteration ${iteration + 1}` }];
        }
      },
      // v0.8.0 (#231): live reasoning lifecycle. Each block opens with a
      // `reasoning-start`, accumulates content via `reasoning-delta`, and
      // closes with `reasoning-end`. Deltas attach to the most-recently-
      // opened block; nested reasoning is impossible per the Hermes flat
      // contract, so a missing `open` block from a stray delta is a no-op.
      onReasoningStart: (tag) => {
        this.thinking = false;
        this.streamReasoning = [...this.streamReasoning, { tag, content: '', open: true }];
      },
      onReasoningDelta: (content) => {
        const idx = this._lastOpenReasoningIdx();
        if (idx < 0) return;
        const next = [...this.streamReasoning];
        next[idx] = { ...next[idx], content: next[idx].content + content };
        this.streamReasoning = next;
      },
      onReasoningEnd: (_tag) => {
        const idx = this._lastOpenReasoningIdx();
        if (idx < 0) return;
        const next = [...this.streamReasoning];
        next[idx] = { ...next[idx], open: false };
        this.streamReasoning = next;
      },
      onDone: () => {
        this.thinking = false;
        if (this.streamText.trim() || this.streamReasoning.length > 0) {
          this.messages = [
            ...this.messages,
            {
              role: 'assistant',
              content: this.streamText,
              createdAt: new Date().toISOString(),
              reasoningBlocks: this._snapshotReasoning(),
            },
          ];
        }
        this.streaming = false;
        this.streamText = '';
        this.streamReasoning = [];
        this.aborting = false;
        this.traceData = { ...this.traceData, elapsed: Date.now() - this._streamStart };
        this._scrollToBottom();
        this._applyHighlighting();
      },
      onError: (error) => {
        if (error.includes('falling back')) {
          // Informational: stream continues with fallback provider
          this.messages = [...this.messages, { role: 'system', kind: 'info', content: error, createdAt: new Date().toISOString() }];
          return;
        }
        this.thinking = false;
        this.streaming = false;
        this.aborting = false;
        this.messages = [...this.messages, { role: 'system', kind: 'error', content: `Error: ${error}`, createdAt: new Date().toISOString() }];
        this._scrollToBottom();
      },
    };

    if (this.transportFallback) {
      // SSE-fallback path (issue #141): the global event channel can't
      // carry per-request stream chunks, so we use the synchronous REST
      // endpoint and surface the final response as a single assistant
      // message once it arrives. Tool steps and iteration markers are
      // not visible in this mode — that's the explicit tradeoff.
      this._sendNonStreaming(this.currentSessionId, text, callbacks);
      return;
    }
    this._streamController = streamMessage(this.currentSessionId, text, callbacks);
  }

  /**
   * REST fallback for chat send when WebSocket has degraded to SSE-only.
   * Uses `POST /api/sessions/:id` which runs `runConfiguredAgent` and
   * returns the full final response in one shot. Mirrors `streamMessage`
   * by replaying the result through the same callbacks so existing UI
   * state machinery stays intact.
   */
  private async _sendNonStreaming(sessionId: string, text: string, callbacks: StreamCallbacks) {
    const controller = new AbortController();
    this._streamController = controller;
    try {
      const result = await api<{ session?: { messages?: Array<{ role: string; content?: string }> }; finalResponse?: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          body: JSON.stringify({ userMessage: text }),
          signal: controller.signal,
        },
      );
      const finalResponse =
        typeof result.finalResponse === 'string' && result.finalResponse.length > 0
          ? result.finalResponse
          : (() => {
              const msgs = result.session?.messages ?? [];
              for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'assistant' && typeof msgs[i].content === 'string') {
                  return msgs[i].content as string;
                }
              }
              return '';
            })();
      if (finalResponse) callbacks.onTextDelta(finalResponse);
      callbacks.onDone();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      callbacks.onError(err instanceof Error ? err.message : 'Request failed');
    }
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

  /**
   * v0.8.0 (#231): index of the most-recently-opened streaming reasoning
   * block (still awaiting `reasoning-end`). Returns -1 when none is open.
   */
  private _lastOpenReasoningIdx(): number {
    for (let i = this.streamReasoning.length - 1; i >= 0; i--) {
      if (this.streamReasoning[i].open) return i;
    }
    return -1;
  }

  /**
   * v0.8.0 (#231): snapshot the live reasoning state into the persistent
   * shape stored on the assistant message. Drops the `open` flag — once a
   * message lands in history every block is treated as final regardless of
   * whether the matching `reasoning-end` arrived (defensive against a
   * truncated stream).
   */
  private _snapshotReasoning(): Array<{ tag: string; content: string }> {
    return this.streamReasoning.map((b) => ({ tag: b.tag, content: b.content }));
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
                ? this.sessions.length === 0
                  ? html`<crowclaw-empty
                      icon="sessions"
                      title="No active sessions"
                      description="Start a new session to chat with your agent."
                      cta-label="New session"
                      cta-event="cc-empty-new-session"
                      @cc-empty-new-session=${this._createSession}
                    ></crowclaw-empty>`
                  : html`<div class="empty" style="padding:20px 0"><div class="empty-subtitle">No matching sessions</div></div>`
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
                    ${this.streaming && (this.streamText || this.streamReasoning.length > 0) ? html`
                      <div class="msg assistant streaming">
                        <span class="role-tag">assistant</span>
                        ${this.streamReasoning.map((rb) => html`
                          <crowclaw-reasoning-block
                            .tag=${rb.tag}
                            .content=${rb.content}
                            ?streaming=${rb.open}
                            collapsed-by-default
                          ></crowclaw-reasoning-block>
                        `)}
                        ${this.streamText ? html`<div class="md">${unsafeHTML(renderMarkdown(this.streamText))}</div>` : nothing}
                        <span class="cursor-blink"></span>
                      </div>
                    ` : nothing}
                  `}
          </div>

          <!-- v0.7.0 #193: sticky bottom-of-stream Steer trigger + composer.
               Only visible while a turn is running so the operator can
               redirect the agent mid-flight. The composer slides up over
               the chat input and POSTs to /api/sessions/:id/steer. -->
          ${this.currentSessionId && (this.streaming || this._isSessionActive(this.currentSessionId)) ? html`
            <div class="steer-sticky-wrap">
              ${!this.showSteerComposer ? html`
                <button class="steer-sticky-btn"
                        @click=${this._toggleSteerComposer}
                        aria-label="Steer the running agent"
                        title="Send mid-run guidance">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M5 12h14"/>
                    <path d="m12 5 7 7-7 7"/>
                  </svg>
                  Steer
                </button>
              ` : nothing}
              <crowclaw-steer-composer
                ?open=${this.showSteerComposer}
                .sessionId=${this.currentSessionId ?? ''}
                @steered=${(e: CustomEvent) => this._onSteered(e as CustomEvent<{ directive: string; injectedPrompt: string }>)}
                @cancel=${() => { this.showSteerComposer = false; }}
              ></crowclaw-steer-composer>
            </div>
          ` : nothing}

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
          <!-- v0.7.1 #225 — replaced bare letter "T" with an inline activity
               pulse SVG icon + accessible label/title so the affordance is
               recognizable at a glance. -->
          <button class="trace-toggle"
                  @click=${() => { this.traceOpen = !this.traceOpen; }}
                  aria-label="Toggle debug trace"
                  title="Debug trace">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
            </svg>
          </button>
          ${this._renderTracePanel()}

          <!-- v0.7.1 #224 — memory-stream pull-tab + collapsible panel.
               The component listens (via this view) to the window-level
               `crowclaw-event` bridge for `memory:captured` / `memory:recalled`
               event types and renders a newest-first feed. -->
          <button class="memory-toggle"
                  @click=${() => { this.showMemoryPanel = !this.showMemoryPanel; }}
                  aria-label="Toggle memory stream"
                  title="Memory stream">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            ${this.memoryEvents.length > 0
              ? html`<span class="memory-badge">${this.memoryEvents.length}</span>`
              : nothing}
          </button>
          <div class="memory-panel ${this.showMemoryPanel ? 'open' : ''}">
            <crowclaw-memory-stream
              heading="Memory stream"
              .events=${this.memoryEvents}
            ></crowclaw-memory-stream>
          </div>

          <!-- v0.7.0 #195: checkpoint side panel. Mounted inside chat-content
               so it slides in over the message list (z-index: 50 in the
               component) without escaping to the dashboard root. -->
          ${this.currentSessionId ? html`
            <crowclaw-checkpoint-panel
              ?open=${this.showCheckpointPanel}
              .sessionId=${this.currentSessionId}
              @close=${() => { this.showCheckpointPanel = false; }}
              @saved=${() => { void this._loadCheckpointCount(); }}
              @restored=${(e: CustomEvent) => this._onCheckpointRestored(e as CustomEvent<{ checkpointId: string; messageCount?: number; restoredIteration?: number }>)}
              @replay-opened=${(e: CustomEvent) => this._onReplayOpened(e as CustomEvent<{ newSessionId: string; sourceCheckpointId: string }>)}
            ></crowclaw-checkpoint-panel>
          ` : nothing}
        </div>

        <!-- v0.7.0 #194: fork modal lives at the chat-area root so the
             overlay covers the full surface (sidebar + chat content). -->
        <crowclaw-fork-modal
          ?open=${this.showForkModal}
          .parent=${this.forkParentInfo}
          .availableToolsets=${this.forkAvailableToolsets}
          @close=${() => { this.showForkModal = false; this.forkParentInfo = null; }}
          @forked=${(e: CustomEvent) => this._onForked(e as CustomEvent<{ parentSessionId: string; forkSessionId: string }>)}
        ></crowclaw-fork-modal>
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
            <!-- v0.7.0 #194: fork-trigger in the 3-dot actions menu. -->
            <button @click=${(e: Event) => { e.stopPropagation(); void this._openForkModal(s.id); }}>Fork session...</button>
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

    // v0.7.1 #220 — toolbar consolidated to Abort + Search + Checkpoints.
    // Steer moved to the sticky-bottom <crowclaw-steer-composer> button
    // (only visible mid-run); Compact moved to the session 3-dot menu;
    // Checkpoint/History collapsed into the single <crowclaw-checkpoint-panel>
    // which already has a Save row + restore list.
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
                @click=${() => { this._closeAllOverlays(); this.showSearchOverlay = !this.showSearchOverlay; this.searchResults = []; }}
                aria-label="Search messages">
          Search
        </button>
        <!-- v0.7.0 #195: header button for the checkpoint side panel.
             Label includes the count so operators can see at a glance how
             many save points exist for the current session. -->
        <button class="ops-btn"
                @click=${this._toggleCheckpointPanel}
                aria-label="Open checkpoints panel"
                title="Manage checkpoints (save / restore / replay)">
          Checkpoints (${this.checkpointCount})
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
          <span>Debug Trace</span>
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
      // v0.7.1 #224 — render the rich <crowclaw-tool-call-trace> inline so
      // the component (which ships in the bundle) actually appears in the
      // DOM. The legacy `.tool-step` row is preserved as a compact fallback
      // for any tool message we can't synthesize a full trace entry for.
      // TODO: wire from the streamed tool-step events so `args`, `output`,
      //       `durationMs`, and `auditId` come from the runtime instead of
      //       being derived from the persisted history line.

      // v0.8.0 #234 — sibling branch for `code.execute`. Parse the persisted
      // payload (the tool's output is a JSON-encoded ExecuteWithToolsResult)
      // and feed it into <crowclaw-code-execute-trace>. On parse failure we
      // fall through to the regular tool-call-trace rendering so we never
      // hide the message entirely.
      if (msg.name === 'code.execute' && typeof msg.content === 'string') {
        try {
          const parsed = JSON.parse(msg.content) as Partial<CodeExecuteTraceData>;
          const data: CodeExecuteTraceData = {
            language: (parsed.language as 'js' | 'ts' | 'python' | undefined) ?? 'js',
            codeHash: parsed.codeHash,
            code: parsed.code,
            stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
            stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
            toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
            durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : 0,
            ok: typeof parsed.ok === 'boolean' ? parsed.ok : ok,
            error: parsed.error,
          };
          return html`
            <div class="tool-step">
              <crowclaw-code-execute-trace .data=${data}></crowclaw-code-execute-trace>
            </div>
          `;
        } catch {
          // Fall through to the regular trace-call rendering.
        }
      }

      const traceEntry: ToolTraceEntry = {
        callId: `${msg.name ?? 'tool'}-${index}`,
        toolName: msg.name ?? 'tool',
        status: ok ? 'ok' : 'error',
        output: msg.content,
        outputLength: msg.content?.length,
        errorMessage: ok ? undefined : msg.content,
      };
      return html`
        <div class="tool-step">
          <crowclaw-tool-call-trace .entry=${traceEntry}></crowclaw-tool-call-trace>
        </div>
      `;
    }

    // Steered messages get a dedicated branch with an icon and a distinct
    // tag so they're not confused with compactions, restores, or errors —
    // all of which previously rendered as plain `system` rows. Issue #144.
    if (msg.role === 'system' && msg.kind === 'steer') {
      return html`
        <div class="msg steer">
          <svg class="kind-icon" width="14" height="14" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12h14"/>
            <path d="m12 5 7 7-7 7"/>
          </svg>
          <div style="flex:1;min-width:0;">
            <span class="role-tag">steer</span>
            <div class="md">${unsafeHTML(renderMarkdown(msg.content))}</div>
            ${msg.createdAt ? html`<div class="msg-time">${timeAgo(msg.createdAt)}</div>` : nothing}
          </div>
        </div>
      `;
    }

    // Sub-classified system messages share the system base shape but pick
    // up their own border/icon class (compact/checkpoint/error). Plain
    // system messages still render with the legacy `.msg.system` styling.
    const systemKindClass =
      msg.role === 'system' && msg.kind && msg.kind !== 'info'
        ? msg.kind
        : '';
    const baseRoleClass = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system';
    const roleClass = systemKindClass ? `${baseRoleClass} ${systemKindClass}` : baseRoleClass;
    const content = msg.role === 'user'
      ? escapeHtml(msg.content)
      : renderMarkdown(msg.content);
    const tagLabel = msg.role === 'system' && msg.kind ? msg.kind : msg.role;

    // v0.8.0 (#231): assistant messages may carry parsed reasoning blocks
    // (`<plan>` / `<reasoning>` / `<reflection>` / `<thinking>` etc.). Mount
    // them inline ABOVE the regular text so the operator sees the model's
    // chain of thought without the harness re-injecting it into the prompt.
    const reasoningBlocks = msg.role === 'assistant' ? msg.reasoningBlocks ?? [] : [];

    return html`
      <div class="msg ${roleClass}">
        <span class="role-tag">${tagLabel}${msg.name ? ` / ${msg.name}` : ''}</span>
        ${reasoningBlocks.length > 0
          ? reasoningBlocks.map((rb) => html`
              <crowclaw-reasoning-block
                .tag=${rb.tag}
                .content=${rb.content}
                collapsed-by-default
              ></crowclaw-reasoning-block>
            `)
          : nothing}
        ${msg.role === 'user'
          ? html`${msg.content}`
          : msg.content
            ? html`<div class="md">${unsafeHTML(content)}</div>`
            : nothing}
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
