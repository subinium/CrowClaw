/**
 * `<crowclaw-icon>` — small inline icon set (v0.8.1 #246).
 *
 * Stroke-based icons rendered as a single SVG with a `<path>` (or multiple
 * paths) per name. All icons are designed on a 24x24 grid with
 * `stroke-width: 1.5` and `stroke-linecap=round` / `stroke-linejoin=round`.
 *
 * Unknown names render a 1px square fallback so callers never produce a
 * blank slot.
 *
 * Icon set is intentionally tight — extend by adding entries to ICON_PATHS.
 */

import { LitElement, html, css, svg, type SVGTemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * Path data for each icon. Values are either:
 *   - a single `d=` string (rendered as one `<path>`), OR
 *   - an array of `d=` strings (rendered as multiple `<path>` elements).
 */
const ICON_PATHS: Record<string, string | string[]> = {
  'x':              'M6 6l12 12 M6 18l12 -12',
  'chevron-down':   'M6 9l6 6 6 -6',
  'chevron-up':     'M6 15l6 -6 6 6',
  'chevron-right':  'M9 6l6 6 -6 6',
  'chevron-left':   'M15 6l-6 6 6 6',
  'more-horizontal': [
    'M5 12h.01',
    'M12 12h.01',
    'M19 12h.01',
  ],
  'menu':           'M4 7h16 M4 12h16 M4 17h16',
  'search':         'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0 -14z M20 20l-3.5 -3.5',
  'send':           'M4 12l16 -8 -6 16 -3 -7 -7 -1z',
  'check':          'M5 12l4 4 10 -10',
  'alert':          'M12 4l10 16H2L12 4z M12 10v4 M12 17.5v.01',
  'info':           'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0 -16z M12 11v5 M12 8v.01',
  'play':           'M7 5l12 7 -12 7z',
  'pause':          'M8 5v14 M16 5v14',
  'square':         'M5 5h14v14H5z',
  'refresh':        'M4 12a8 8 0 0 1 14 -5l2 -2 M20 12a8 8 0 0 1 -14 5l-2 2 M18 3v4h-4 M6 21v-4h4',
  'copy':           'M9 9h11v11H9z M5 5h11v4 M5 5v11h4',
  'pencil':         'M4 20l4 -1 11 -11 -3 -3 -11 11 -1 4z M14 6l3 3',
  'trash':          'M5 7h14 M9 7V4h6v3 M7 7l1 13h8l1 -13',
  'external-link':  'M14 4h6v6 M20 4l-9 9 M18 13v6H5V6h6',
  'keyboard':       'M3 7h18v10H3z M7 11h.01 M11 11h.01 M15 11h.01 M7 14h10',
  'activity':       'M3 12h4l3 -8 4 16 3 -8h4',
  'bookmark':       'M6 4h12v17l-6 -4 -6 4z',
  'branch':         'M6 3v12 M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0 -6z M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0 -6z M18 6a3 3 0 1 0 0 6 3 3 0 0 0 0 -6z M18 12c0 4 -4 4 -6 6',
  'clock':          'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0 -16z M12 7v5l3 2',
  'database':       'M4 6c0 -1.5 3.5 -3 8 -3s8 1.5 8 3 -3.5 3 -8 3 -8 -1.5 -8 -3z M4 6v12c0 1.5 3.5 3 8 3s8 -1.5 8 -3V6 M4 12c0 1.5 3.5 3 8 3s8 -1.5 8 -3',
  'terminal':       'M4 5h16v14H4z M7 9l3 3 -3 3 M12 15h5',
  'network':        'M12 4a3 3 0 1 1 0 6 3 3 0 0 1 0 -6z M5 14a3 3 0 1 1 0 6 3 3 0 0 1 0 -6z M19 14a3 3 0 1 1 0 6 3 3 0 0 1 0 -6z M12 10v3 M12 13l-5 2 M12 13l5 2',
  'settings':       'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0 -6z M19 12l1.5 -1 -1.5 -3 -2 .5 -1.5 -1.5 .5 -2 -3 -1.5 -1 1.5h-2L9 2.5 6 4l.5 2 -1.5 1.5 -2 -.5 -1.5 3 1.5 1 0 2 -1.5 1 1.5 3 2 -.5 1.5 1.5 -.5 2 3 1.5 1 -1.5h2l1 1.5 3 -1.5 -.5 -2 1.5 -1.5 2 .5 1.5 -3 -1.5 -1z',
  'user':           'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0 -8z M4 21c0 -4 4 -7 8 -7s8 3 8 7',
};

@customElement('crowclaw-icon')
export class CrowClawIcon extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      line-height: 0;
      color: currentColor;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
      stroke: currentColor;
      stroke-width: 1.5;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
    }
    .fallback {
      width: 1px;
      height: 1px;
      background: currentColor;
      display: inline-block;
    }
  `;

  @property({ type: String })
  name = '';

  @property({ type: Number })
  size = 16;

  render() {
    const data = ICON_PATHS[this.name];
    if (!data) {
      return html`<span
        class="fallback"
        role="img"
        aria-label=${this.name || 'icon'}
      ></span>`;
    }
    const paths: SVGTemplateResult[] = (Array.isArray(data) ? data : [data]).map(
      (d) => svg`<path d=${d}></path>`,
    );
    const px = `${this.size}px`;
    return html`
      <svg
        viewBox="0 0 24 24"
        style="width:${px};height:${px}"
        role="img"
        aria-label=${this.name}
        focusable="false"
      >${paths}</svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'crowclaw-icon': CrowClawIcon;
  }
}
