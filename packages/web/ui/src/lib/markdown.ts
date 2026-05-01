/**
 * v0.8.1 (#243): Markdown rendering swapped from a hand-rolled regex pipeline
 * to `marked` + `DOMPurify`. GFM tables, task lists, autolinks and footnotes
 * now Just Work. `highlight.js` is dynamically imported on the first code-block
 * render so pages with no code do not pay the ~50KB highlighter cost.
 *
 * Public surface preserved (chat-view.ts imports these names):
 *   - renderMarkdown(text: string): string
 *   - highlightCodeBlocks(root: HTMLElement | ShadowRoot): void
 *   - attachCopyHandlers(root: HTMLElement | ShadowRoot): void
 *
 * Security: all model output flows through DOMPurify. Do not bypass.
 */
import { marked, type Tokens, type RendererObject } from 'marked';
import DOMPurify from 'dompurify';

// --- highlight.js lazy loader -----------------------------------------------

type HljsApi = typeof import('highlight.js').default;
let hljsLoader: Promise<HljsApi> | null = null;

const getHighlighter = (): Promise<HljsApi> => {
  if (!hljsLoader) {
    hljsLoader = import('highlight.js').then((m) => m.default);
  }
  return hljsLoader;
};

// --- helpers ----------------------------------------------------------------

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const randomId = (): string => {
  // Used only for DOM ids — no security requirement, just collision avoidance.
  try {
    const buf = new Uint8Array(4);
    globalThis.crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
};

// --- renderer ---------------------------------------------------------------
// In marked v14 the renderer overrides receive a token object, and `this` is
// bound to a context exposing `this.parser.parseInline` for nested tokens.
// We pass the renderer through `marked.use({ renderer })` so the binding is
// set up correctly — `marked.setOptions({ renderer })` does NOT bind `this`.

const customRenderer: RendererObject = {
  code({ text, lang, escaped: alreadyEscaped }: Tokens.Code): string {
    const language = (lang ?? '').trim().split(/\s+/)[0] ?? '';
    // marked may already HTML-escape the text (escaped: true); if so we must
    // not double-escape, otherwise we'd render `&amp;lt;` instead of `&lt;`.
    const escaped = alreadyEscaped ? text : escapeHtml(text);
    // Raw (un-escaped) source — what hljs needs to tokenise correctly.
    const rawCode = alreadyEscaped
      ? text
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
      : text;
    const id = `cc-code-${randomId()}`;
    const langLabel = language || 'plain';

    // Render unhighlighted immediately. If a language is supplied, schedule a
    // post-mount highlight pass via microtask so the DOM has time to mount.
    if (language && typeof document !== 'undefined') {
      queueMicrotask(async () => {
        try {
          const hljs = await getHighlighter();
          const el = document.getElementById(id);
          if (!el || el.dataset.highlighted === 'true') return;
          if (!hljs.getLanguage(language)) return;
          const result = hljs.highlight(rawCode, { language, ignoreIllegals: true });
          el.innerHTML = result.value;
          el.dataset.highlighted = 'true';
        } catch {
          /* unknown language or hljs failure — leave unhighlighted */
        }
      });
    }

    return (
      `<div class="md-code-block code-block">` +
      `<div class="md-code-header">` +
      `<span class="md-code-lang">${escapeHtml(langLabel)}</span>` +
      `<button class="md-code-copy code-copy" type="button" data-code-id="${id}" data-copy aria-label="Copy code">Copy</button>` +
      `</div>` +
      `<pre class="md-pre"><code id="${id}" class="hljs language-${escapeHtml(langLabel)}">${escaped}</code></pre>` +
      `</div>`
    );
  },

  link({ href, title, tokens }: Tokens.Link): string {
    const safeHref = href ?? '';
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const inner = this.parser.parseInline(tokens);
    return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${inner}</a>`;
  },

  table({ header, rows }: Tokens.Table): string {
    const headerHtml = header
      .map((cell) => {
        const align = cell.align ? ` style="text-align:${cell.align}"` : '';
        const inner = this.parser.parseInline(cell.tokens);
        return `<th${align}>${inner}</th>`;
      })
      .join('');
    const bodyHtml = rows
      .map((row) => {
        const cells = row
          .map((cell) => {
            const align = cell.align ? ` style="text-align:${cell.align}"` : '';
            const inner = this.parser.parseInline(cell.tokens);
            return `<td${align}>${inner}</td>`;
          })
          .join('');
        return `<tr>${cells}</tr>`;
      })
      .join('');
    return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
  },
};

let markedConfigured = false;
const ensureMarkedConfigured = (): void => {
  if (markedConfigured) return;
  marked.use({
    gfm: true,
    breaks: true,
    renderer: customRenderer,
  });
  markedConfigured = true;
};

// --- DOMPurify hook: open links in new tab safely ---------------------------
// DOMPurify strips `target` by default; re-add it for anchors that our renderer
// emitted. Only registers once, and only when DOMPurify has a real window
// (i.e. browser runtime or jsdom test env).

let purifyConfigured = false;
const ensurePurifyConfigured = (): void => {
  if (purifyConfigured) return;
  if (typeof DOMPurify.addHook !== 'function') return;
  DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  purifyConfigured = true;
};

// --- public API -------------------------------------------------------------

export const renderMarkdown = (text: string): string => {
  if (!text) return '';
  ensureMarkedConfigured();
  ensurePurifyConfigured();
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel', 'data-code-id', 'data-highlighted', 'data-copy'],
    ADD_TAGS: ['details', 'summary'],
  });
};

// Spec-named alias.
export { renderMarkdown as renderMarkdownToHtml };

/**
 * Apply highlight.js to any code blocks already mounted in the DOM. Useful
 * when chat-view renders innerHTML in bulk and wants to backfill highlighting
 * on blocks the renderer's microtask did not cover (e.g. streamed chunks).
 */
export const highlightCodeBlocks = (root: HTMLElement | ShadowRoot): void => {
  if (typeof document === 'undefined') return;
  const blocks = root.querySelectorAll<HTMLElement>(
    'pre code.hljs, pre code[class*="language-"]',
  );
  if (blocks.length === 0) return;
  void getHighlighter().then((hljs) => {
    blocks.forEach((block) => {
      if (block.dataset.highlighted === 'true') return;
      const langClass = Array.from(block.classList).find((c) => c.startsWith('language-'));
      const language = langClass?.slice('language-'.length) ?? '';
      if (!language || language === 'plain' || !hljs.getLanguage(language)) return;
      try {
        const result = hljs.highlight(block.textContent ?? '', {
          language,
          ignoreIllegals: true,
        });
        block.innerHTML = result.value;
        block.dataset.highlighted = 'true';
      } catch {
        /* unknown language — skip */
      }
    });
  });
};

/**
 * Wire up copy-to-clipboard for every `.md-code-copy` (and legacy `[data-copy]`)
 * button under `root`. Idempotent — repeated calls on the same root are safe.
 */
export const attachCopyHandlers = (root: HTMLElement | ShadowRoot): void => {
  if (typeof document === 'undefined') return;
  const buttons = root.querySelectorAll<HTMLButtonElement>(
    '.md-code-copy, [data-copy]',
  );
  buttons.forEach((btn) => {
    if (btn.dataset.copyBound === 'true') return;
    btn.dataset.copyBound = 'true';
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.codeId;
      let codeEl: HTMLElement | null = null;
      if (targetId) {
        codeEl = (root as Document | HTMLElement | ShadowRoot)
          .querySelector?.(`#${CSS.escape(targetId)}`) as HTMLElement | null;
      }
      if (!codeEl) {
        codeEl = btn
          .closest('.md-code-block, .code-block')
          ?.querySelector<HTMLElement>('code') ?? null;
      }
      if (!codeEl) return;
      const text = codeEl.textContent ?? '';
      const original = btn.textContent ?? 'Copy';
      const restore = (msg: string) => {
        btn.textContent = msg;
        window.setTimeout(() => {
          btn.textContent = original;
        }, 1500);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(() => restore('Copied!'))
          .catch(() => restore('Failed'));
      } else {
        restore('Unsupported');
      }
    });
  });
};

// Spec-named alias for any future caller that prefers the new name.
export { attachCopyHandlers as attachCodeCopyHandlers };
