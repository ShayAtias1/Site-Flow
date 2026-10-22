// The app's checkbox (UX-16): a native, accessible <input type="checkbox"> drawn by the shared .cb style —
// rounded square, filled with a checkmark when checked, a bar when partly selected (mixed). With a label
// the whole row is the click target (44px).
import { useEffect, useRef, type ReactNode } from 'react';

export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  ariaLabel,
  disabled,
  invalid,
  className = '',
}: {
  checked: boolean;
  /** Some but not all of a group selected: shown as a bar, announced as "mixed". */
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  const input = (
    <input
      ref={ref}
      type="checkbox"
      className="cb"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
  if (!label) return <span className={`cb-solo ${className}`}>{input}</span>;
  return (
    <label className={`cb-row ${disabled ? 'is-disabled' : ''} ${className}`}>
      {input}
      <span className="cb-label">{label}</span>
    </label>
  );
}
