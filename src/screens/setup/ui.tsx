import { useState, type ReactNode } from 'react';
import { Dialog } from '../Dialog';

/** A setup form in the app's accessible dialog. `dirty`: typed work that closing must not drop silently. */
export function Sheet({ title, onClose, children, dirty }: { title: ReactNode; onClose: () => void; children: ReactNode; dirty?: boolean }) {
  return (
    <Dialog title={title} onClose={onClose} className="setup-sheet" dirty={dirty}>
      {children}
    </Dialog>
  );
}

export function Field({ label, hint, children, ltr }: { label: string; hint?: string; children: ReactNode; ltr?: boolean }) {
  return (
    <label className={`field ${ltr ? 'ltr' : ''}`}>
      <span>{label}</span>
      {children}
      {hint && <small className="hint">{hint}</small>}
    </label>
  );
}

/** Runs one setup write at a time and keeps its error message for the screen. */
export function useRunner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

export const ErrorBox = ({ error }: { error: string | null }) =>
  error ? (
    <div className="alert error" role="alert">
      {error}
    </div>
  ) : null;

/** A second, explicit step before a destructive action. */
export function Confirm({
  text,
  action,
  disabled,
  busy,
  onConfirm,
}: {
  text: ReactNode;
  action: string;
  disabled?: string | null;
  busy?: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (disabled) return <div className="alert warn">{disabled}</div>;
  if (!asking)
    return (
      <button className="btn danger-outline" disabled={busy} onClick={() => setAsking(true)}>
        {action}
      </button>
    );
  return (
    <div className="confirm">
      <div>{text}</div>
      <div className="confirm-actions">
        <button className="btn danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'מבצע…' : `כן, ${action}`}
        </button>
        <button className="btn" disabled={busy} onClick={() => setAsking(false)}>
          ביטול
        </button>
      </div>
    </div>
  );
}

export const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
