/**
 * Lightweight Markdown-to-HTML renderer for CrowClaw chat.
 * Ported from vanilla JS md() function.
 * Handles: code blocks, inline code, bold, italic, headers,
 * blockquotes, lists, links, horizontal rules.
 */

const escapeHtml = (text: string): string => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

export const renderMarkdown = (raw: string): string => {
  if (!raw) return '';
  let text = raw;

  // Extract code blocks first (protect from other transformations)
  const codeBlocks: string[] = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const idx = codeBlocks.length;
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    codeBlocks.push(
      `<div class="code-block"><pre class="md-pre"><code${langAttr}>${escapeHtml(code.trim())}</code></pre>` +
      `<button class="code-copy" data-copy>Copy</button></div>`,
    );
    return `%%CODEBLOCK${idx}%%`;
  });

  // Extract inline code
  const inlineCode: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code: string) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code class="md-inline">${escapeHtml(code)}</code>`);
    return `%%INLINE${idx}%%`;
  });

  // Escape remaining HTML
  text = escapeHtml(text);

  // Inline formatting
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Headers
  text = text.replace(/^### (.+)$/gm, '<h3 class="md-h">$1</h3>');
  text = text.replace(/^## (.+)$/gm, '<h2 class="md-h">$1</h2>');
  text = text.replace(/^# (.+)$/gm, '<h1 class="md-h">$1</h1>');

  // Blockquotes (escaped > becomes &gt;)
  text = text.replace(/^&gt; (.+)$/gm, '<blockquote class="md-bq">$1</blockquote>');

  // Horizontal rules
  text = text.replace(/^---$/gm, '<hr class="md-hr">');

  // Links — block dangerous URL schemes (javascript:, vbscript:, data:)
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match: string, label: string, url: string) => {
      const trimmed = url.trim().toLowerCase();
      if (/^(javascript|vbscript|data):/i.test(trimmed)) {
        return `<span title="Blocked: unsafe URL scheme">${label}</span>`;
      }
      return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
    },
  );

  // Lists
  const lines = text.split('\n');
  const output: string[] = [];
  let inUl = false;
  let inOl = false;

  for (const line of lines) {
    if (/^- (.+)$/.test(line)) {
      if (!inUl) {
        if (inOl) { output.push('</ol>'); inOl = false; }
        output.push('<ul class="md-ul">');
        inUl = true;
      }
      output.push(`<li>${line.replace(/^- /, '')}</li>`);
    } else if (/^\d+\. (.+)$/.test(line)) {
      if (!inOl) {
        if (inUl) { output.push('</ul>'); inUl = false; }
        output.push('<ol class="md-ol">');
        inOl = true;
      }
      output.push(`<li>${line.replace(/^\d+\. /, '')}</li>`);
    } else {
      if (inUl) { output.push('</ul>'); inUl = false; }
      if (inOl) { output.push('</ol>'); inOl = false; }
      output.push(line);
    }
  }
  if (inUl) output.push('</ul>');
  if (inOl) output.push('</ol>');

  text = output.join('\n');

  // Paragraphs
  text = text.replace(/\n\n+/g, '</p><p>');
  text = text.replace(/\n/g, '<br>');
  text = `<p>${text}</p>`;

  // Clean up empty paragraphs and misplaced wrapping
  text = text.replace(/<p>\s*<\/p>/g, '');
  text = text.replace(/<p>\s*(<h[123]|<pre|<ul|<ol|<blockquote|<hr)/g, '$1');
  text = text.replace(
    /(<\/h[123]>|<\/pre>|<\/ul>|<\/ol>|<\/blockquote>|<hr[^>]*>)\s*<\/p>/g,
    '$1',
  );

  // Restore code blocks and inline code
  for (let i = 0; i < codeBlocks.length; i++) {
    text = text.replace(`%%CODEBLOCK${i}%%`, codeBlocks[i]);
  }
  for (let i = 0; i < inlineCode.length; i++) {
    text = text.replace(`%%INLINE${i}%%`, inlineCode[i]);
  }

  return text;
};

/**
 * Apply syntax highlighting to all code blocks in an element.
 * Requires highlight.js to be loaded globally.
 */
export const highlightCodeBlocks = (container: HTMLElement): void => {
  const hljs = (globalThis as Record<string, unknown>).hljs as {
    highlightElement: (el: HTMLElement) => void;
  } | undefined;

  if (!hljs) return;

  container.querySelectorAll<HTMLElement>('pre code[class^="language-"]').forEach((block) => {
    hljs.highlightElement(block);
  });
};

/**
 * Attach copy-to-clipboard handlers to code blocks.
 */
export const attachCopyHandlers = (container: HTMLElement): void => {
  container.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.parentElement?.querySelector('code');
      if (code) {
        navigator.clipboard.writeText(code.textContent ?? '');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      }
    });
  });
};
