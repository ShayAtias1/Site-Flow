import { createClient, type Session } from '@supabase/supabase-js';
import { db, getMeta, setMeta } from './db';

const URL_ = import.meta.env.VITE_SUPABASE_URL ?? '';
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';
const STORAGE_KEY = 'sf.auth';
const LAST_USER_KEY = 'sf.lastUser';

export const authConfigured = !!URL_ && !!KEY;

// Every request names the device (install id), for diagnostics and per-device test harnessing.
const withDevice: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  try {
    headers.set('x-siteflow-device', localStorage.getItem('sf.installId') ?? '');
  } catch {
    /* no device id available */
  }
  return fetch(input, { ...init, headers });
};

export const supabase = createClient(URL_ || 'http://invalid.local', KEY || 'missing', {
  auth: { storageKey: STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  global: { fetch: withDevice },
});

export interface AuthUser {
  id: string;
  email: string;
}

export type AuthState =
  | { kind: 'loading' }
  | { kind: 'signed-out'; reason?: 'expired' | 'other-user' | 'not-configured' }
  /** offline: a session from an earlier sign-in is on the device but could not be verified right now. */
  | { kind: 'signed-in'; user: AuthUser; offline: boolean };

type Listener = (s: AuthState) => void;
const listeners = new Set<Listener>();
let state: AuthState = { kind: 'loading' };
let signingOut = false;

function set(next: AuthState) {
  state = next;
  listeners.forEach((l) => l(state));
}

export function onAuthState(l: Listener) {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
}

const readJson = <T>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};

const storedSession = () => readJson<{ user?: { id: string } }>(STORAGE_KEY);
export const lastUser = () => readJson<AuthUser>(LAST_USER_KEY);

/**
 * The device's local data belongs to the first user who signed in on it.
 * Another user may sign in only while the device holds no findings.
 */
async function claimDevice(user: AuthUser): Promise<boolean> {
  const owner = await getMeta<string>('ownerUserId');
  if (owner && owner !== user.id && (await db.findings.count()) > 0) return false;
  await setMeta('ownerUserId', user.id);
  localStorage.setItem(LAST_USER_KEY, JSON.stringify(user));
  return true;
}

async function fromSession(session: Session | null): Promise<AuthState> {
  if (session?.user) {
    const user = { id: session.user.id, email: session.user.email ?? '' };
    if (!(await claimDevice(user))) {
      signingOut = true;
      await supabase.auth.signOut({ scope: 'local' });
      signingOut = false;
      return { kind: 'signed-out', reason: 'other-user' };
    }
    return { kind: 'signed-in', user, offline: false };
  }
  // No verified session. supabase-js removes the stored session when the server rejects it
  // (revoked/expired refresh token) and keeps it on network errors — so a stored session from
  // the device owner means "offline": keep working locally until it can be verified.
  const last = lastUser();
  const stored = storedSession();
  if (last && stored?.user?.id === last.id) return { kind: 'signed-in', user: last, offline: true };
  return { kind: 'signed-out', reason: last ? 'expired' : undefined };
}

export async function initAuth() {
  if (!authConfigured) return set({ kind: 'signed-out', reason: 'not-configured' });
  supabase.auth.onAuthStateChange((event, session) => {
    // Handled asynchronously: supabase-js forbids awaiting its own calls inside this callback.
    setTimeout(async () => {
      if (event === 'SIGNED_OUT') {
        if (!signingOut) set({ kind: 'signed-out', reason: lastUser() ? 'expired' : undefined });
      } else if (session && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && state.kind !== 'loading') {
        set(await fromSession(session));
      }
    }, 0);
  });
  set(await fromSession((await supabase.auth.getSession()).data.session));
  // While offline, re-check whenever the connection might be back.
  const recheck = async () => {
    if (state.kind === 'signed-in' && state.offline && navigator.onLine)
      set(await fromSession((await supabase.auth.getSession()).data.session));
  };
  window.addEventListener('online', recheck);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && recheck());
  setInterval(recheck, 30000);
}

export async function signIn(email: string, password: string): Promise<string | null> {
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) {
    if (error.name === 'AuthRetryableFetchError' || /fetch|network/i.test(error.message))
      return 'אין חיבור לשרת. הכניסה הראשונה במכשיר דורשת חיבור לאינטרנט.';
    if (/invalid login credentials/i.test(error.message)) return 'אימייל או סיסמה שגויים.';
    return error.message;
  }
  const next = await fromSession(data.session);
  set(next);
  return next.kind === 'signed-out' && next.reason === 'other-user'
    ? 'במכשיר נשמרו נתונים של משתמש אחר. כניסה של משתמש נוסף אינה אפשרית עד שהנתונים יגובו ויימחקו.'
    : null;
}

/** Refuses while anything is still only on this device — signing out must never strand unsynced work. */
export async function signOut(): Promise<string | null> {
  const pending = await db.findings.where('dirty').equals(1).count();
  const photos = await db.photos.where('uploaded').equals(0).filter((p) => !!p.findingId).count();
  const tours = await db.tours.where('dirty').equals(1).count();
  if (pending || photos || tours)
    return `יש ${pending} ממצאים, ${photos} תמונות ו-${tours} סיורים שעוד לא סונכרנו. סנכרן לפני יציאה.`;
  signingOut = true;
  await supabase.auth.signOut({ scope: 'local' });
  signingOut = false;
  localStorage.removeItem(LAST_USER_KEY);
  set({ kind: 'signed-out' });
  return null;
}
