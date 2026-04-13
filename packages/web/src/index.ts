/**
 * CrowClaw Web Dashboard
 *
 * Premium single-page agent management UI.
 * Source files: dashboard.html, dashboard.css, dashboard.js
 * Build with: node scripts/build-dashboard.mjs
 */

export { DASHBOARD_HTML } from './generated.js';

/**
 * Creates a fetch handler that serves the dashboard and proxies API calls.
 */
export function createDashboardHandler(
  runtimeFetch: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '/dashboard') {
      // Dynamic import to avoid bundling the HTML in non-dashboard contexts
      const { DASHBOARD_HTML } = await import('./generated.js');
      return new Response(DASHBOARD_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        },
      });
    }

    return runtimeFetch(req);
  };
}

export const webPackage = {
  name: '@crowclaw/web',
  description: 'Web dashboard for CrowClaw agent management.',
};
