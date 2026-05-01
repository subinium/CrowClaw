// @vitest-environment jsdom
//
// v0.8.1 (#243): renderer was rewritten to use marked + DOMPurify. These
// tests cover the GFM features the regex pipeline never supported (tables,
// task lists, autolinks) plus a hard XSS gate. DOMPurify needs a real DOM,
// hence the jsdom environment pragma above — vitest's default `node` env
// would leave `window` undefined and make sanitization a no-op.

import { describe, it, expect } from 'vitest';
import {
  renderMarkdown,
  renderMarkdownToHtml,
} from '../packages/web/ui/src/lib/markdown.js';

describe('markdown renderer (v0.8.1)', () => {
  it('renders GFM tables', () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    // `1` and `2` should land in body cells, `a`/`b` in headers.
    expect(html).toMatch(/<th[^>]*>\s*a\s*<\/th>/);
    expect(html).toMatch(/<td[^>]*>\s*1\s*<\/td>/);
  });

  it('renders GFM task lists as checkboxes', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done');
    expect(html).toMatch(/type="checkbox"/);
    // The completed item should be checked, the todo should not.
    expect(html).toMatch(/checked[^>]*>[\s\S]*done/);
    expect(html).toMatch(/<li[^>]*>[\s\S]*?type="checkbox"(?![^>]*checked)[\s\S]*?todo/);
  });

  it('autolinks bare URLs and forces target=_blank with safe rel', () => {
    const html = renderMarkdown('See https://example.com for details.');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('strips XSS payloads via DOMPurify', () => {
    const xss = renderMarkdown(
      '<script>alert(1)</script><img src=x onerror=alert(1)>',
    );
    expect(xss).not.toContain('<script');
    expect(xss).not.toContain('onerror');
    // The <img> may survive but must have no event handlers.
    expect(xss.toLowerCase()).not.toMatch(/on\w+\s*=/);
  });

  it('blocks javascript: links during sanitization', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('preserves code blocks with copy button and language label', () => {
    const html = renderMarkdown('```js\nconst x = 1;\n```');
    expect(html).toContain('md-code-block');
    expect(html).toContain('md-code-copy');
    expect(html).toContain('language-js');
    // The pre content is HTML-escaped before highlighting.
    expect(html).toContain('const x = 1;');
  });

  it('returns empty string for empty / falsy input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('exposes renderMarkdownToHtml as a backwards-compatible alias', () => {
    expect(renderMarkdownToHtml('**hi**')).toContain('<strong>hi</strong>');
  });

  it('renders inline code without triggering the code-block layout', () => {
    const html = renderMarkdown('Use `npm test` to run.');
    expect(html).toMatch(/<code[^>]*>npm test<\/code>/);
    expect(html).not.toContain('md-code-block');
  });

  it('renders fenced code without language using the plain label', () => {
    const html = renderMarkdown('```\nplain code\n```');
    expect(html).toContain('md-code-block');
    expect(html).toContain('plain');
    expect(html).toContain('plain code');
  });
});
