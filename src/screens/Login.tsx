import { useState } from 'react';
import { signIn, type AuthState } from '../auth';

const REASON: Record<string, string> = {
  expired: 'החיבור שלך הסתיים. היכנס שוב — הנתונים במכשיר נשמרו.',
  'not-configured': 'האפליקציה לא הוגדרה לחיבור לשרת (חסרים פרטי Supabase).',
};

export function Login({ state }: { state: Extract<AuthState, { kind: 'signed-out' }> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    setError(await signIn(email, password));
    setBusy(false);
  };

  return (
    <div className="app login">
      <header className="status">
        <span className="title">SiteFlow</span>
      </header>
      <main>
        <form className="card login-card" onSubmit={submit}>
          <h1>כניסה</h1>
          {state.reason && REASON[state.reason] && <div className="alert warn">{REASON[state.reason]}</div>}
          <label className="field">
            <span>אימייל</span>
            <input type="email" dir="ltr" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            <span>סיסמה</span>
            <input type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="alert error" role="alert">{error}</div>}
          <button className="primary" type="submit" disabled={busy || state.reason === 'not-configured'}>
            {busy ? 'נכנס…' : 'כניסה'}
          </button>
          <p className="muted">אחרי כניסה ראשונה אפשר להמשיך לעבוד גם בלי קליטה.</p>
        </form>
      </main>
    </div>
  );
}
