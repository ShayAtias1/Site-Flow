import { supabase } from './auth';
const TOKEN_KEY = 'sf.token';

export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
};

export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);

/** The install id (see storage.checkIntegrity) identifies the device to the server. */
const deviceId = () => {
  try {
    return localStorage.getItem('sf.installId') ?? '';
  } catch {
    return '';
  }
};


export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
  const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'x-siteflow-token': getToken(),
        'x-siteflow-device': deviceId(),
        // The report service acts as the signed-in user, so database permissions (RLS) apply to it too.
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (!res.ok) throw new ApiError(body?.error ?? res.statusText, res.status);
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

export const postJson = <T>(path: string, body: unknown, timeoutMs?: number) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, timeoutMs);
