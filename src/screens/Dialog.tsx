// The app's one popup (UX-02/16): centered and rounded at every width — never a bottom sheet or drawer.
// Dialog role with a name, aria-modal, focus moved in on open and returned to the opener on close, Tab
// kept inside, Escape closes (only the topmost popup when nested), the rest of the app inert while open.
// The title and close button stay put, the body scrolls, the action area (footer) stays attached to the
// popup, and the popup fits the visible viewport — also above an open on-screen keyboard.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open dialogs, bottom to top. */
const stack: HTMLElement[] = [];

/** Everything but the topmost dialog is inert: the app (#root) and any dialog underneath. */
function applyInert() {
  const root = document.getElementById('root');
  const top = stack[stack.length - 1];
  if (root) root.inert = stack.length > 0;
  for (const el of stack) el.inert = el !== top;
}

function visible(el: HTMLElement) {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

export interface DialogProps {
  title: ReactNode;
  /** Plain-text name when the title is not a string. */
  label?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** Unsaved typed work: closing asks first instead of discarding it. */
  dirty?: boolean;
  /** "סגור" as a text button instead of the × icon. */
  closeText?: string;
  /** Extra content next to the title. */
  headExtra?: ReactNode;
  /** The popup's actions, kept visible under the scrolling body. */
  footer?: ReactNode;
  /** Wider popup for content such as the finding editor on large screens. */
  size?: 'normal' | 'wide';
}

export function Dialog({ title, label, onClose, children, className = '', dirty = false, closeText, headExtra, footer, size = 'normal' }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [asking, setAsking] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const requestClose = () => {
    if (dirtyRef.current) setAsking(true);
    else closeRef.current();
  };
  const requestRef = useRef(requestClose);
  requestRef.current = requestClose;

  useEffect(() => {
    const el = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    stack.push(el);
    applyInert();
    el.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== el) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        requestRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus moves here, not by the browser: Safari skips buttons on Tab, which would let focus leave.
      e.preventDefault();
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
      if (!items.length) return el.focus();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = i < 0 ? (e.shiftKey ? items.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    };
    document.addEventListener('keydown', onKey, true);
    // Fit the visible viewport (it shrinks when the on-screen keyboard opens).
    const vv = window.visualViewport;
    const fit = () => {
      const b = backdrop.current;
      if (!b || !vv) return;
      b.style.setProperty('--vvh', `${vv.height}px`);
      b.style.setProperty('--vvt', `${vv.offsetTop}px`);
    };
    fit();
    vv?.addEventListener('resize', fit);
    vv?.addEventListener('scroll', fit);
    return () => {
      vv?.removeEventListener('resize', fit);
      vv?.removeEventListener('scroll', fit);
      document.removeEventListener('keydown', onKey, true);
      if (stack.includes(el)) stack.splice(stack.indexOf(el), 1);
      applyInert();
      // Back to whatever opened it — if it is still there and usable.
      if (opener && document.contains(opener) && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div ref={backdrop} className="sheet-backdrop popup-backdrop" onClick={requestClose}>
      <div
        ref={ref}
        className={`sheet popup ${size === 'wide' ? 'popup-wide' : ''} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={label ? undefined : titleId}
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head popup-head">
          <h2 id={titleId} className="sheet-title">{title}</h2>
          {headExtra}
          {closeText ? (
            <button className="link" onClick={requestClose}>{closeText}</button>
          ) : (
            <button className="icon-btn" aria-label="סגירה" onClick={requestClose}>
              <Icon name="close" size={22} strokeWidth={2.2} />
            </button>
          )}
        </div>
        <div className="popup-body">
          {asking && (
            <div className="alert warn discard" role="alert">
              <span>יש שינויים שלא נשמרו.</span>
              <span className="confirm-actions">
                <button className="btn" onClick={() => setAsking(false)}>המשך לערוך</button>
                <button className="btn danger-outline" onClick={() => closeRef.current()}>סגור בלי לשמור</button>
              </span>
            </div>
          )}
          {children}
        </div>
        {footer && <div className="popup-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
