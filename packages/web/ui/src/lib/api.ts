/**
 * API client for CrowClaw dashboard.
 *
 * Authentication is handled entirely by the server-issued `crowclaw_auth`
 * HttpOnly cookie. The raw dashboard token is never stored in the browser
 * (sessionStorage / localStorage) or sent on every request, because:
 *   - HttpOnly cookies survive XSS that reaches JS-accessible storage
 *   - Tokens in Authorization headers or query strings leak into logs,
 *     proxies, and Referer headers
 */

export const getAuthToken = (): null => null;

export const setAuthToken = (_token: string | null): void => {
  // Intentionally a no-op. Server owns auth state via HttpOnly cookie.
};

/**
 * Sign the user out by asking the server to expire the auth cookie.
 * Failures are swallowed because the UI state transition must continue
 * regardless of the network response.
 */
export const clearAuthToken = (): void => {
  void fetch(`${location.origin}/api/auth/logout`, {
    method: 'POST',
    credentials: 'same-origin',
  }).catch(() => { /* best-effort logout */ });
};

export interface ApiOptions extends RequestInit {
  /** Skip JSON parsing and return raw Response */
  raw?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly statusText: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = async <T = unknown>(path: string, options?: ApiOptions): Promise<T> => {
  const { raw, ...fetchOpts } = options ?? {};
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(fetchOpts.headers as Record<string, string>),
  };

  const response = await fetch(`${location.origin}${path}`, {
    ...fetchOpts,
    headers,
    credentials: 'same-origin',
  });

  if (response.status === 401) {
    document.dispatchEvent(new CustomEvent('crowclaw:auth-required'));
    throw new ApiError('Unauthorized', 401, response.statusText);
  }

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error) {
        errorMessage = typeof body.error === 'string' ? body.error : body.error.message ?? errorMessage;
      }
    } catch {
      // Response is not JSON — use status text
    }
    throw new ApiError(errorMessage, response.status, response.statusText);
  }

  if (raw) {
    return response as unknown as T;
  }

  return response.json() as Promise<T>;
};

/**
 * Check if user is authenticated via cookie.
 */
export const checkAuth = async (): Promise<boolean> => {
  try {
    const data = await api<{ authenticated: boolean }>('/api/auth/check', { method: 'GET' });
    return data.authenticated;
  } catch {
    return false;
  }
};

/**
 * Verify token and obtain auth. On success the server issues an HttpOnly
 * cookie and we throw the raw token away immediately.
 */
export const verifyToken = async (token: string): Promise<boolean> => {
  try {
    const data = await api<{ ok: boolean }>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    return data.ok === true;
  } catch {
    return false;
  }
};
