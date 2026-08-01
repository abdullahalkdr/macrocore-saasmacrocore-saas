const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Reads straight from the zustand-persist localStorage blob instead of importing the
// store here — avoids a circular import between the store and the client it uses.
function getToken(): string | null {
  try {
    const raw = localStorage.getItem('macrocore-auth');
    if (!raw) return null;
    return JSON.parse(raw)?.state?.token ?? null;
  } catch {
    return null;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // empty body is fine (e.g. some 204s)
  }

  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error || `Request failed (${res.status})`;
    // A 401 here always means the JWT is missing/expired/invalid (see backend
    // middleware/auth.ts) — the token in localStorage is now dead weight. Clear it
    // and bounce to /login instead of leaving every page showing a raw "Invalid or
    // expired token" banner forever (that string was never meant to be user-facing).
    if (res.status === 401 && typeof window !== 'undefined') {
      try {
        localStorage.removeItem('macrocore-auth');
      } catch {
        // ignore
      }
      if (window.location.pathname !== '/login') {
        window.location.href = '/login?expired=1';
      }
    }
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const get = <T = unknown>(path: string) => request<T>(path);
export const post = <T = unknown>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
export const patch = <T = unknown>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body: body !== undefined ? JSON.stringify(body) : undefined });
export const put = <T = unknown>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined });
export const del = <T = unknown>(path: string, body?: unknown) =>
  request<T>(path, { method: 'DELETE', body: body !== undefined ? JSON.stringify(body) : undefined });
