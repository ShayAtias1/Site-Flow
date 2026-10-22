import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db, type ContractorRow, type ProjectContractorRow, type ProjectRow } from '../../db';
import {
  assignContractor,
  createContractor,
  unassignContractor,
  updateContractor,
  validateContractor,
  type ContractorFields,
} from '../../setup';
import { Confirm, ErrorBox, Field, Sheet, useRunner } from './ui';

const EMPTY: ContractorFields = { name: '', trade: '', contact_name: '', phone: '', email: '' };

function useContractors(project: ProjectRow) {
  return useLiveQuery(async () => {
    const [pcs, all, defaults, categories, findings] = await Promise.all([
      db.project_contractors.where('project_id').equals(project.id).toArray(),
      db.contractors.filter((c) => c.org_id === project.org_id && !c.deleted_at).toArray(),
      db.project_category_defaults.where('project_id').equals(project.id).toArray(),
      db.categories.filter((c) => c.org_id === project.org_id && !c.deleted_at).toArray(),
      db.findings.filter((f) => f.projectId === project.id && !f.deletedAt).toArray(),
    ]);
    const live = pcs.filter((pc) => !pc.deleted_at);
    const onProject = new Set(live.map((pc) => pc.contractor_id));
    const byName = (a: ContractorRow, b: ContractorRow) => a.name.localeCompare(b.name, 'he');
    return {
      assigned: all.filter((c) => onProject.has(c.id)).sort(byName).map((c) => ({
        c,
        pc: live.find((pc) => pc.contractor_id === c.id)!,
        defaults: categories.filter((cat) => defaults.some((d) => !d.deleted_at && d.category_id === cat.id && d.contractor_id === c.id)).map((cat) => cat.name),
        findings: findings.filter((f) => f.contractorId === c.id).length,
      })),
      others: all.filter((c) => !onProject.has(c.id)).sort(byName),
    };
  }, [project.id]);
}

export function Contractors({ project, readOnly }: { project: ProjectRow; readOnly: boolean }) {
  const data = useContractors(project);
  const [open, setOpen] = useState<{ mode: 'new' } | { mode: 'edit'; id: string } | null>(null);
  if (!data) return null;
  // The open sheet always edits the current row (its version changes after every save).
  const editing = open?.mode === 'edit' ? data.assigned.find((a) => a.c.id === open.id) : undefined;
  return (
    <div className="contractors">
      <div className="structure-bar">
        <div className="muted">{data.assigned.length} קבלנים בפרויקט. רק הם מוצגים בתיעוד ובדוחות של הפרויקט הזה.</div>
        {!readOnly && (
          <button className="btn primary-solid" onClick={() => setOpen({ mode: 'new' })}>
            + הוסף קבלן
          </button>
        )}
      </div>
      {!data.assigned.length && (
        <div className="empty card">
          <b>אין קבלנים בפרויקט</b>
          <p className="muted">הוסף קבלן חדש, או בחר מקבלני הארגון שכבר עובדים בפרויקטים אחרים.</p>
        </div>
      )}
      <div className="cards-grid">
        {data.assigned.map(({ c, defaults, findings }) => (
          <button key={c.id} className="card contractor-card" data-id={c.id} onClick={() => setOpen({ mode: 'edit', id: c.id })}>
            <div className="item-top">
              <b>{c.name}</b>
              {c.trade && <span className="tag">{c.trade}</span>}
            </div>
            <div className="muted">
              {[c.contact_name, c.phone, c.email].filter(Boolean).join(' · ') || 'אין פרטי קשר'}
            </div>
            <div className="item-tags">
              {defaults.map((d) => (
                <span key={d} className="tag ok">ברירת מחדל: {d}</span>
              ))}
              {findings > 0 && <span className="tag">{findings} ממצאים</span>}
            </div>
          </button>
        ))}
      </div>
      {open?.mode === 'new' && <NewContractor project={project} others={data.others} onClose={() => setOpen(null)} />}
      {editing && <EditContractor key={editing.c.id} project={project} c={editing.c} pc={editing.pc} readOnly={readOnly} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ContractorForm({ value, onChange, disabled }: { value: ContractorFields; onChange: (v: ContractorFields) => void; disabled?: boolean }) {
  const set = (patch: Partial<ContractorFields>) => onChange({ ...value, ...patch });
  return (
    <div className="form-grid">
      <Field label="שם החברה / הקבלן">
        <input value={value.name} disabled={disabled} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="מקצוע">
        <input value={value.trade} disabled={disabled} list="sf-trades" onChange={(e) => set({ trade: e.target.value })} placeholder="לדוגמה: חשמל" />
      </Field>
      <Field label="איש קשר">
        <input value={value.contact_name} disabled={disabled} onChange={(e) => set({ contact_name: e.target.value })} />
      </Field>
      <Field label="טלפון" ltr>
        <input value={value.phone} disabled={disabled} type="tel" dir="ltr" onChange={(e) => set({ phone: e.target.value })} />
      </Field>
      <Field label="אימייל" ltr>
        <input value={value.email} disabled={disabled} type="email" dir="ltr" onChange={(e) => set({ email: e.target.value })} />
      </Field>
      <datalist id="sf-trades">
        {['אינסטלציה', 'חשמל', 'ריצוף וחיפוי', 'אלומיניום', 'טיח וצבע', 'נגרות', 'מסגרות', 'איטום', 'גבס', 'מיזוג אוויר', 'כללי'].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}

function NewContractor({ project, others, onClose }: { project: ProjectRow; others: ContractorRow[]; onClose: () => void }) {
  const [fields, setFields] = useState(EMPTY);
  const { busy, error, setError, run } = useRunner();
  return (
    <Sheet title="הוספת קבלן לפרויקט" onClose={onClose}>
      {others.length > 0 && (
        <>
          <div className="label">מקבלני הארגון</div>
          <div className="pick-list">
            {others.map((c) => (
              <div key={c.id} className="row-line">
                <span>
                  <b>{c.name}</b> {c.trade && <span className="muted">· {c.trade}</span>}
                </span>
                <button className="btn" disabled={busy} onClick={() => run(() => assignContractor(project, c.id))}>
                  + לפרויקט
                </button>
              </div>
            ))}
          </div>
          <div className="label">או קבלן חדש</div>
        </>
      )}
      <ContractorForm value={fields} onChange={setFields} />
      <ErrorBox error={error} />
      <button
        className="primary"
        disabled={busy}
        onClick={async () => {
          const invalid = validateContractor(fields);
          if (invalid) return setError(invalid);
          if (await run(() => createContractor(project, fields))) onClose();
        }}
      >
        {busy ? 'שומר…' : 'צור והוסף לפרויקט'}
      </button>
    </Sheet>
  );
}

function EditContractor({
  project,
  c,
  pc,
  readOnly,
  onClose,
}: {
  project: ProjectRow;
  c: ContractorRow;
  pc: ProjectContractorRow;
  readOnly: boolean;
  onClose: () => void;
}) {
  const [fields, setFields] = useState<ContractorFields>({ name: c.name, trade: c.trade, contact_name: c.contact_name, phone: c.phone, email: c.email });
  const { busy, error, setError, run } = useRunner();
  return (
    <Sheet title={c.name} onClose={onClose}>
      <ContractorForm value={fields} onChange={setFields} disabled={readOnly} />
      <p className="muted small">פרטי הקבלן משותפים לכל הפרויקטים בארגון.</p>
      <ErrorBox error={error} />
      {!readOnly && (
        <>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              const invalid = validateContractor(fields);
              if (invalid) return setError(invalid);
              if (await run(() => updateContractor(c, fields))) onClose();
            }}
          >
            שמור
          </button>
          <div className="sub-block">
            <Confirm
              action="הסר מהפרויקט"
              text="הקבלן לא יוצע עוד בתיעוד בפרויקט הזה, וקטגוריות שהוא קבלן ברירת המחדל שלהן יישארו ללא ברירת מחדל. ממצאים קיימים נשארים משויכים אליו."
              busy={busy}
              onConfirm={async () => (await run(() => unassignContractor(project, pc))) && onClose()}
            />
          </div>
        </>
      )}
    </Sheet>
  );
}
