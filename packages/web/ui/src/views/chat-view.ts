import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { api } from '../lib/api.js';
import { streamMessage, type StreamCallbacks } from '../lib/sse.js';
import { renderMarkdown, highlightCodeBlocks, attachCopyHandlers } from '../lib/markdown.js';
import { buttonStyles } from '../lib/shared-styles.js';

interface SessionInfo {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  updatedAt: string;
  contextPct?: number;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'iteration';
  content: string;
  name?: string;
}

interface ToolStep {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'done' | 'error';
  input?: Record<string, unknown>;
  output?: string;
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
        width: 260px;
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

      .sess-title {
        font-size: var(--text-sm);
        font-weight: 500;
        color: var(--text-primary);
        margin-bottom: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .sess-meta {
        display: flex;
        gap: var(--sp-3);
        font-size: var(--text-xs);
        color: var(--text-muted);
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
        align-items: center;
        gap: var(--sp-2);
      }

      .chat-input input {
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
      }

      .chat-input input:focus { border-color: var(--accent); }
      .chat-input input::placeholder { color: var(--text-muted); }

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
        width: 220px;
        background: var(--bg-secondary);
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        z-index: 5;
        display: none;
      }

      .trace-panel.open { display: block; }

      .tp-hdr {
        padding: var(--sp-2) var(--sp-3);
        font-size: var(--text-xs);
        font-weight: 600;
        color: var(--text-secondary);
        border-bottom: 1px solid var(--glass-border);
      }

      .tp-body { padding: var(--sp-2) var(--sp-3); }

      .tp-row {
        display: flex;
        justify-content: space-between;
        font-size: var(--text-xs);
        padding: 2px 0;
      }

      .tp-row span:first-child { color: var(--text-muted); }
      .tp-row span:last-child { color: var(--text-primary); font-family: var(--font-mono); }

      /* Responsive */
      @media (max-width: 768px) {
        .sess-sb { display: none; }
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
  @state() private traceData = { iteration: 0, tool: '--', tokens: 0, elapsed: 0 };
  @state() private sessSidebarOpen = true;

  @query('#msgInput') private msgInput!: HTMLInputElement;
  @query('.messages') private messagesEl!: HTMLElement;

  private _streamController?: AbortController;
  private _streamStart = 0;

  connectedCallback() {
    super.connectedCallback();
    this._loadSessions();
    if (this.currentSessionId) {
      this._loadHistory();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._streamController?.abort();
  }

  private async _loadSessions() {
    try {
      // Backend returns { ok, supported, count, sessions } from summarizeSessionRecord()
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
      // Backend returns the full session object { sessionId, messages, updatedAt, ... }
      const data = await api<{ sessionId: string; messages: ChatMessage[]; updatedAt?: string }>(`/api/sessions/${this.currentSessionId}/history`);
      this.messages = data.messages || [];
      this._scrollToBottom();
    } catch {
      this.messages = [];
    }
  }

  private _selectSession(id: string) {
    this.currentSessionId = id;
    localStorage.setItem('cc_sid', id);
    this.sessions = [...this.sessions]; // trigger re-render
    this._loadHistory();
  }

  private _createSession() {
    // TODO: Session ID should ideally be generated server-side via POST /api/sessions
    // to avoid potential collisions and ensure the backend is the source of truth.
    const id = `s-${Date.now().toString(36)}`;
    this.sessions = [
      { id, title: '', preview: '', messageCount: 0, updatedAt: new Date().toISOString() },
      ...this.sessions,
    ];
    this._selectSession(id);
  }

  private async _deleteSession(e: Event, id: string) {
    e.stopPropagation();
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.currentSessionId === id) {
      this.currentSessionId = null;
      localStorage.removeItem('cc_sid');
      this.messages = [];
    }
    try {
      await api(`/api/sessions/${id}`, { method: 'DELETE' });
    } catch { /* ignore */ }
  }

  private _sendMessage() {
    const text = this.msgInput?.value.trim();
    if (!text || !this.currentSessionId || this.streaming) return;
    this.msgInput.value = '';

    // Add user message
    this.messages = [...this.messages, { role: 'user', content: text }];

    // Update session
    const session = this.sessions.find((s) => s.id === this.currentSessionId);
    if (session) {
      session.messageCount++;
      session.updatedAt = new Date().toISOString();
      if (!session.title) session.title = text.slice(0, 30);
      session.preview = text.slice(0, 60);
      this.sessions = [...this.sessions];
    }

    // Start streaming
    this.streaming = true;
    this.streamText = '';
    this.toolSteps = [];
    this._streamStart = Date.now();
    this.traceData = { iteration: 0, tool: '--', tokens: 0, elapsed: 0 };

    this._scrollToBottom();

    const callbacks: StreamCallbacks = {
      onTextDelta: (content) => {
        this.streamText += content;
        this.traceData = { ...this.traceData, tokens: this.traceData.tokens + 1 };
        this._scrollToBottom();
      },
      onToolStart: (toolName, toolCallId, input) => {
        this.toolSteps = [...this.toolSteps, {
          toolCallId, toolName, status: 'running', input,
        }];
        this.traceData = { ...this.traceData, tool: toolName };
        // Flush any pending text as a message
        if (this.streamText.trim()) {
          this.messages = [...this.messages, { role: 'assistant', content: this.streamText }];
          this.streamText = '';
        }
      },
      onToolEnd: (toolCallId, output, success) => {
        this.toolSteps = this.toolSteps.map((s) =>
          s.toolCallId === toolCallId
            ? { ...s, status: success ? 'done' : 'error', output }
            : s,
        );
        // Add tool result as message
        const step = this.toolSteps.find((s) => s.toolCallId === toolCallId);
        if (step) {
          this.messages = [...this.messages, { role: 'tool', content: output, name: step.toolName }];
        }
      },
      onIterationStart: (iteration) => {
        this.traceData = { ...this.traceData, iteration };
        // Flush pending stream text before iteration separator
        if (this.streamText.trim()) {
          this.messages = [...this.messages, { role: 'assistant', content: this.streamText }];
          this.streamText = '';
        }
        if (iteration > 0) {
          this.messages = [...this.messages, { role: 'iteration', content: `Iteration ${iteration + 1}` }];
        }
      },
      onDone: () => {
        if (this.streamText.trim()) {
          this.messages = [...this.messages, { role: 'assistant', content: this.streamText }];
        }
        this.streaming = false;
        this.streamText = '';
        this.traceData = { ...this.traceData, elapsed: Date.now() - this._streamStart };
        this._scrollToBottom();
        this._applyHighlighting();
      },
      onError: (error) => {
        this.streaming = false;
        this.messages = [...this.messages, { role: 'system', content: `Error: ${error}` }];
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

  render() {
    return html`
      <div class="chat-area">
        <!-- Session Sidebar -->
        ${this.sessSidebarOpen ? html`
          <div class="sess-sb">
            <div class="sess-hdr">
              <input placeholder="Search sessions..."
                     .value=${this.searchQuery}
                     @input=${(e: InputEvent) => { this.searchQuery = (e.target as HTMLInputElement).value; }}>
              <button class="btn btn-p" style="padding:6px 10px" @click=${this._createSession} title="New Session">+</button>
            </div>
            <div class="sess-list">
              ${this._filteredSessions.length === 0
                ? html`<div class="empty" style="padding:20px 0"><div class="empty-subtitle">${this.sessions.length ? 'No matching sessions' : 'No sessions yet'}</div></div>`
                : this._filteredSessions.map((s) => html`
                    <div class="sess-item ${s.id === this.currentSessionId ? 'active' : ''}"
                         @click=${() => this._selectSession(s.id)}>
                      <div class="sess-actions">
                        <button @click=${(e: Event) => this._deleteSession(e, s.id)} title="Delete">&#128465;</button>
                      </div>
                      <div class="sess-title">${s.title || s.preview?.slice(0, 30) || s.id.slice(0, 20)}</div>
                      <div class="sess-meta">
                        <span>${timeAgo(s.updatedAt)}</span>
                        <span>${s.messageCount} msgs</span>
                      </div>
                      ${s.contextPct !== undefined ? html`
                        <div class="sess-ctx"><div class="sess-ctx-bar" style="width:${Math.min(100, s.contextPct)}%"></div></div>
                      ` : nothing}
                    </div>
                  `)}
            </div>
          </div>
        ` : nothing}

        <!-- Chat Content -->
        <div class="chat-content" style="position:relative">
          <button class="sess-toggle-btn" @click=${() => { this.sessSidebarOpen = !this.sessSidebarOpen; }}>&#9776;</button>

          <div class="messages">
            ${!this.currentSessionId
              ? html`<div class="empty"><div class="empty-title">No Session</div><div class="empty-subtitle">Create a session to start</div></div>`
              : this.messages.length === 0 && !this.streaming
                ? html`<div class="empty"><div class="empty-title">New Session</div><div class="empty-subtitle">Type a message to begin.</div></div>`
                : html`
                    ${this.messages.map((m, i) => this._renderMessage(m, i))}
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
            <input id="msgInput" placeholder="Send a message..."
                   ?disabled=${!this.currentSessionId}
                   @keydown=${this._inputKeydown}>
            <button class="send-btn" @click=${this._sendMessage}
                    ?disabled=${!this.currentSessionId || this.streaming}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </div>

          <!-- Trace Panel -->
          <button class="trace-toggle" @click=${() => { this.traceOpen = !this.traceOpen; }}>T</button>
          <div class="trace-panel ${this.traceOpen ? 'open' : ''}">
            <div class="tp-hdr">Trace</div>
            <div class="tp-body">
              <div class="tp-row"><span>Iteration</span><span>${this.traceData.iteration}</span></div>
              <div class="tp-row"><span>Tool</span><span>${this.traceData.tool}</span></div>
              <div class="tp-row"><span>Tokens</span><span>${this.traceData.tokens}</span></div>
              <div class="tp-row"><span>Elapsed</span><span>${this.traceData.elapsed}ms</span></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

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
      </div>
    `;
  }

  private _retryMessage(index: number) {
    // Find the user message before this assistant message
    for (let i = index - 1; i >= 0; i--) {
      if (this.messages[i].role === 'user') {
        this.messages = this.messages.slice(0, i);
        this._sendMessage();
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
