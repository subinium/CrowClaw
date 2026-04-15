/**
 * API client for CrowClaw dashboard.
 * Ported from vanilla JS `ap()` function.
 */

const TOKEN_KEY = 'cc_auth_token';

const storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null;

let authToken: string | null = storage?.getItem(TOKEN_KEY) ?? null;

export const setAuthToken = (token: string | null) => {
  authToken = token;
  if (token) {
    storage?.setItem(TOKEN_KEY, token);
  } else {
    storage?.removeItem(TOKEN_KEY);
  }
};

export const getAuthToken = () => authToken;

export const clearAuthToken = () => {
  authToken = null;
  storage?.removeItem(TOKEN_KEY);
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

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

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
 * Check if user is authenticated via cookie or token.
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
 * Verify token and obtain auth.
 */
export const verifyToken = async (token: string): Promise<boolean> => {
  try {
    const data = await api<{ ok: boolean }>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    if (data.ok) {
      setAuthToken(token);
      return true;
    }
    return false;
  } catch {
    return false;
  }
};
