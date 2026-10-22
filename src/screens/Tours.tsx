import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectModel } from '../../shared/projectModel';
import { STATUS_LABEL, TOUR_KIND_LABEL, type FindingStatus, type Participant, type TourKind } from '../../shared/types';
import { db, type ProjectRow, type TourFields, type TourRow } from '../db';
import { scheduleSync } from '../sync';
import { closeTour, createTour, newTourDefaults, reopenTour, setActiveTour, updateTour, useActiveTour, useTours } from '../tours';
import { Confirm, ErrorBox, Field, Sheet, useRunner } from './setup/ui';

export const tourDate = (d: string) => d.split('-').reverse().join('.');
export const tourLabel = (t: TourRow) => `${TOUR_KIND_LABEL[t.kind]} · ${tourDate(t.tour_date)}`;

function ParticipantsEditor({ value, onChange, suggestions }: { value: Participant[]; onChange: (v: Participant[]) => void; suggestions: string[] }) {
  const set = (i: number, patch: Partial<Participant>) => onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="participants">
      {value.map((p, i) => (
        <div key={i} className="participant">
          <input value={p.name} placeholder="שם" aria-label={`משתתף ${i + 1}: שם`} onChange={(e) => set(i, { name: e.target.value })} />
          <input value={p.role} placeholder="תפקיד / חברה" aria-label={`משתתף ${i + 1}: תפקיד`} list="sf-participant-roles" onChange={(e) => set(i, { role: e.target.value })} />
          <button className="x-inline" aria-label={`הסר משתתף ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button className="link" onClick={() => onChange([...value, { name: '', role: '' }])}>
        + משתתף
      </button>
      <datalist id="sf-participant-roles">
        {['מפקח', 'מנהל פרויקט', 'מהנדס ביצוע', 'נציג היזם', 'נציג הדיירים', ...suggestions.map((s) => `נציג ${s}`)].map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </div>
  );
}

function TourForm({ value, onChange, contractors }: { value: Omit<TourFields, 'status'>; onChange: (v: Omit<TourFields, 'status'>) => void; contractors: string[] }) {
  const set = (patch: Partial<TourFields>) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="form-grid">
        <Field label="תאריך הסיור">
          <input type="date" value={value.tour_date} onChange={(e) => set({ tour_date: e.target.value })} />
        </Field>
      </div>
      <div className="label">סוג הסיור</div>
      <div className="seg" role="radiogroup" aria-label="סוג הסיור">
        {(Object.keys(TOUR_KIND_LABEL) as TourKind[]).map((k) => (
          <button key={k} role="radio" aria-checked={value.kind === k} className={value.kind === k ? 'on' : ''} onClick={() => set({ kind: k })}>
            {TOUR_KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="label">משתתפים</div>
      <ParticipantsEditor value={value.participants} onChange={(participants) => set({ participants })} suggestions={contractors} />
      <Field label="הערות">
        <textarea className="desc" rows={2} value={value.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
    </>
  );
}

/** Starting a tour (or continuing an open one) — shown in capture when no tour is in progress. */
export function StartTour({
  project,
  model,
  onStarted,
  actionSlot,
}: {
  project: ProjectRow;
  model: ProjectModel;
  onStarted?: () => void;
  /** Inside a popup: the popup's footer, where the start button is rendered instead of at the end of the form. */
  actionSlot?: HTMLElement | null;
}) {
  const tours = useTours(project.id);
  const [form, setForm] = useState<Omit<TourFields, 'status'> | null>(null);
  const { busy, error, run } = useRunner();
  if (!tours) return null;
  const open = tours.filter((t) => t.status === 'active');
  const value = form ?? newTourDefaults(tours);
  const start = (
    <button
      className="primary"
      disabled={busy}
      onClick={() =>
        run(async () => {
          await createTour(project, value);
          scheduleSync();
          onStarted?.();
        })
      }
    >
      התחל סיור
    </button>
  );
  return (
    <div className="start-tour card">
      <b className="start-title">פתיחת סיור — {project.name}</b>
      <p className="muted">כל ממצא חדש נרשם בסיור שבו תועד. אפשר לפתוח סיור גם ללא חיבור.</p>
      {open.length > 0 && (
        <div className="open-tours">
          <div className="label">סיורים פתוחים</div>
          {open.map((t) => (
            <button key={t.id} className="btn primary-outline" onClick={() => run(async () => (await setActiveTour(project.id, t.id), onStarted?.()))}>
              המשך: {tourLabel(t)}
            </button>
          ))}
          <div className="label">או סיור חדש</div>
        </div>
      )}
      <TourForm value={value} onChange={setForm} contractors={model.contractors.map((c) => c.name)} />
      <ErrorBox error={error} />
      {actionSlot === undefined ? start : actionSlot && createPortal(start, actionSlot)}
    </div>
  );
}

interface TourStats {
  created: number;
  statusChanges: number;
  pendingEvents: number;
}

function useTourStats(projectId: string) {
  return useLiveQuery(async () => {
    const findings = await db.findings.where('projectId').equals(projectId).toArray();
    const ids = new Set(findings.map((f) => f.id));
    const events = (await db.events.toArray()).filter((e) => ids.has(e.findingId));
    const stats = new Map<string, TourStats>();
    const of = (id: string) => stats.get(id) ?? (stats.set(id, { created: 0, statusChanges: 0, pendingEvents: 0 }), stats.get(id)!);
    for (const f of findings) if (f.tourId && !f.deletedAt) of(f.tourId).created++;
    for (const e of events) {
      if (!e.tourId) continue;
      if (e.type === 'status_changed') of(e.tourId).statusChanges++;
      if (e.pending) of(e.tourId).pendingEvents++;
    }
    return { stats, beforeTours: findings.filter((f) => !f.tourId && !f.deletedAt).length };
  }, [projectId]);
}

/** Tours of the current project: start, continue, edit, close. */
export function Tours({ project, model }: { project: ProjectRow; model: ProjectModel }) {
  const tours = useTours(project.id);
  const active = useActiveTour(project.id);
  const data = useTourStats(project.id);
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const [closed, setClosed] = useState<TourRow | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  if (!tours || !data || active === undefined) return null;
  const current = typeof open === 'string' && open !== 'new' ? tours.find((t) => t.id === open) : undefined;
  return (
    <div className="tours">
      {closed && (
        <div className="alert info next-step" role="status">
          <span>
            <b>{tourLabel(closed)} נסגר.</b> הממצאים וההיסטוריה שלו נשמרו. מה הלאה?
          </span>
          <span className="actions-row">
            <button className="btn" onClick={() => navigate({ tab: 'findings', view: 'findings', projectId: project.id, tourId: closed.id })}>
              הצג את ממצאי הסיור
            </button>
            <button className="btn" onClick={() => navigate({ tab: 'reports', tourId: closed.id })}>
              הכנת דוח לסיור
            </button>
            <button className="link" onClick={() => setClosed(null)}>
              סגירה
            </button>
          </span>
        </div>
      )}
      <div className="structure-bar">
        <div className="muted">{tours.length === 1 ? 'סיור אחד בפרויקט' : `${tours.length} סיורים בפרויקט`}</div>
        <button className="btn primary-solid" onClick={() => setOpen('new')}>
          + סיור חדש
        </button>
      </div>
      {tours.map((t) => {
        const s = data.stats.get(t.id);
        return (
          <button key={t.id} className={`item tour-item ${active?.id === t.id ? 'is-active' : ''}`} data-id={t.id} onClick={() => setOpen(t.id)}>
            <div className="item-top">
              <b>{tourLabel(t)}</b>
              {active?.id === t.id ? <span className="tag ok">בעבודה במכשיר</span> : t.status === 'active' ? <span className="tag">פתוח</span> : <span className="tag">נסגר</span>}
            </div>
            {t.participants.length > 0 && <div className="muted">{t.participants.map((p) => p.name || p.role).join(' · ')}</div>}
            <div className="item-tags">
              <span className="tag">{s?.created ?? 0} ממצאים חדשים</span>
              {!!s?.statusChanges && <span className="tag">{s.statusChanges} שינויי סטטוס</span>}
              {t.dirty ? <span className="tag warn">ממתין לסנכרון</span> : null}
              {t.syncError && <span className="tag danger" title={t.syncError}>נדחה בסנכרון</span>}
            </div>
          </button>
        );
      })}
      {data.beforeTours > 0 && <div className="muted">{data.beforeTours} ממצאים תועדו לפני שהוגדרו סיורים — הם מוצגים ללא סיור.</div>}
      {open === 'new' && (
        <Sheet title="סיור חדש" onClose={() => setOpen(null)} footer={<div className="footer-slot" ref={setSlot} />}>
          <StartTour project={project} model={model} onStarted={() => setOpen(null)} actionSlot={slot} />
        </Sheet>
      )}
      {current && (
        <TourSheet
          key={current.id}
          tour={current}
          model={model}
          isActive={active?.id === current.id}
          onClose={() => setOpen(null)}
          onClosed={() => {
            setClosed(current);
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}

/** Moves to another screen, e.g. a closed tour's findings or a report for it (App listens). */
export function navigate(to: { tab: 'findings' | 'reports'; view?: 'findings' | 'table' | 'tours'; projectId?: string; tourId?: string }) {
  if (to.view) sessionStorage.setItem('sf.findingsView', to.view);
  if (to.tab === 'findings' && to.projectId && to.tourId)
    sessionStorage.setItem(`sf.findingFilters:${to.projectId}`, JSON.stringify({ q: '', filters: { tour: to.tourId, state: 'active' } }));
  if (to.tab === 'reports' && to.tourId) sessionStorage.setItem('sf.reportTour', to.tourId);
  window.dispatchEvent(new CustomEvent('sf:navigate', { detail: to }));
}

function TourSheet({ tour, model, isActive, onClose, onClosed }: { tour: TourRow; model: ProjectModel; isActive: boolean; onClose: () => void; onClosed: () => void }) {
  const [form, setForm] = useState<Omit<TourFields, 'status'>>({ kind: tour.kind, tour_date: tour.tour_date, participants: tour.participants, notes: tour.notes });
  const { busy, error, run } = useRunner();
  const activity = useLiveQuery(async () => {
    const created = await db.findings.where('tourId').equals(tour.id).filter((f) => !f.deletedAt).toArray();
    const events = (await db.events.where('tourId').equals(tour.id).toArray()).filter((e) => e.type === 'status_changed').sort((a, b) => a.at.localeCompare(b.at));
    const byId = new Map((await db.findings.bulkGet(events.map((e) => e.findingId))).filter(Boolean).map((f) => [f!.id, f!]));
    return { created, statusChanges: events.map((e) => ({ e, f: byId.get(e.findingId) })) };
  }, [tour.id]);
  const dirty = JSON.stringify(form) !== JSON.stringify({ kind: tour.kind, tour_date: tour.tour_date, participants: tour.participants, notes: tour.notes });
  const people = tour.participants.filter((p) => p.name || p.role);
  return (
    <Sheet title={tourLabel(tour)} onClose={onClose} dirty={dirty}>
      <section className="tour-summary" aria-label="סיכום הסיור">
        <div className="tour-summary-tags">
          {isActive ? <span className="tag ok">בעבודה במכשיר</span> : tour.status === 'active' ? <span className="tag">פתוח</span> : <span className="tag">נסגר</span>}
          <span className="tag">{plural(activity?.created.length ?? 0, 'ממצא חדש', 'ממצאים חדשים')}</span>
          <span className="tag">{plural(activity?.statusChanges.length ?? 0, 'שינוי סטטוס', 'שינויי סטטוס')}</span>
        </div>
        {people.length > 0 && <div className="muted">משתתפים: {people.map((p) => [p.name, p.role].filter(Boolean).join(' — ')).join(' · ')}</div>}
        <div className="actions-row">
          {!isActive && (
            <button className="btn primary-solid" disabled={busy} onClick={() => run(async () => (await (tour.status === 'closed' ? reopenTour(tour) : setActiveTour(tour.project_id, tour.id)), scheduleSync(), onClose()))}>
              {tour.status === 'closed' ? 'פתח מחדש והמשך' : 'המשך בסיור זה'}
            </button>
          )}
          <button className="btn" onClick={() => (onClose(), navigate({ tab: 'findings', view: 'findings', projectId: tour.project_id, tourId: tour.id }))}>
            ממצאי הסיור
          </button>
        </div>
      </section>

      <section className="tour-edit" aria-labelledby={`tour-edit-${tour.id}`}>
        <h3 className="section-title" id={`tour-edit-${tour.id}`}>פרטי הסיור</h3>
        <TourForm value={form} onChange={setForm} contractors={model.contractors.map((c) => c.name)} />
        <ErrorBox error={error} />
        <div className="actions-row">
          <button className="btn primary-solid" disabled={busy || !dirty} onClick={() => run(async () => (await updateTour(tour.id, form), scheduleSync()))}>
            שמור פרטי סיור
          </button>
        </div>
      </section>

      {tour.status === 'active' && (
        <div className="sub-block">
          <Confirm
            action="סגור סיור"
            text="הסיור ייסגר בכל המכשירים. הממצאים וההיסטוריה שלו נשמרים, ואפשר לפתוח אותו מחדש."
            busy={busy}
            onConfirm={() => run(async () => (await closeTour(tour), scheduleSync(), onClosed()))}
          />
        </div>
      )}
      {activity && (
        <section className="sub-block tour-activity" aria-labelledby={`tour-act-${tour.id}`}>
          <h3 className="section-title" id={`tour-act-${tour.id}`}>מה נעשה בסיור</h3>
          <div className="label">ממצאים שתועדו בסיור ({activity.created.length})</div>
          {activity.created.map((f) => (
            <div key={f.id} className="row-line">
              <span>
                <b>{f.displayNo ? `#${f.displayNo}` : 'טרם מוספר'}</b> {f.description}
              </span>
              <span className="muted">{model.locationLabel(f.locationId)}</span>
            </div>
          ))}
          {activity.statusChanges.length > 0 && <div className="label">שינויי סטטוס בסיור ({activity.statusChanges.length})</div>}
          {activity.statusChanges.map(({ e, f }) => (
            <div key={e.id} className="row-line">
              <span>
                <b>{f?.displayNo ? `#${f.displayNo}` : ''}</b> {f?.description}
              </span>
              <span className="muted">
                מ־{STATUS_LABEL[e.from?.status as FindingStatus]} ל־{STATUS_LABEL[e.to?.status as FindingStatus]}
              </span>
            </div>
          ))}
        </section>
      )}
    </Sheet>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `${one} אחד` : `${n} ${many}`);
