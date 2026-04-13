/**
 * API client for CrowClaw dashboard.
 * Ported from vanilla JS `ap()` function.
 */

let authToken: string | null = null;

export const setAuthToken = (token: string | null) => {
  authToken = token;
};

export const getAuthToken = () => authToken;

export interface ApiOptions extends RequestInit {
  /** Skip JSON parsing and return raw Response */
  raw?: boolean;
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
    throw new Error('Unauthorized');
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
