import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState, type ReactNode } from 'react';
import { db, getMeta, type ProjectRow, type TourRow } from '../../db';
import { tourLabel } from '../Tours';
import { useProjects } from '../../projectData';
import {
  canWrite,
  createProject,
  loadMemberships,
  setCurrentProject,
  updateProject,
  validateProject,
  type Membership,
  type ProjectFields,
} from '../../setup';
import { Categories } from './Categories';
import { Contractors } from './Contractors';
import { Structure } from './Structure';
import { ErrorBox, Field, Sheet, useRunner } from './ui';

type Section = 'structure' | 'contractors' | 'categories' | 'details';
const SECTIONS: [Section, string][] = [
  ['structure', 'מבנה'],
  ['contractors', 'קבלנים'],
  ['categories', 'קטגוריות'],
  ['details', 'פרטי פרויקט'],
];

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

type View = 'home' | 'manage';

export function Setup({ onOpenProject }: { onOpenProject: () => void }) {
  const projects = useProjects();
  const online = useOnline();
  const [members, setMembers] = useState<Membership[] | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(false);
  const [view, setView] = useState<View>(() => (sessionStorage.getItem('sf.setupView') as View) || 'home');
  const [section, setSection] = useState<Section>(() => (sessionStorage.getItem('sf.setupSection') as Section) || 'structure');

  useEffect(() => {
    loadMemberships().then(setMembers, (e) => setMemberError((e as Error).message));
  }, [online]);
  useEffect(() => sessionStorage.setItem('sf.setupSection', section), [section]);
  useEffect(() => sessionStorage.setItem('sf.setupView', view), [view]);

  if (!projects) return <div className="muted">טוען פרויקטים…</div>;
  const project = projects.current;
  const role = members?.find((m) => m.orgId === project?.org_id)?.role;
  const writableOrgs = (members ?? []).filter((m) => canWrite(m.role));
  // Setup is edited online only; offline it is shown as synced to the device.
  const readOnly = !online || !canWrite(role);
  const createBlocked = !online ? 'יצירת פרויקט דורשת חיבור.' : members && !writableOrgs.length ? 'אין לך הרשאה ליצור פרויקטים.' : null;

  const manage = async (id: string, s: Section = 'structure') => {
    await setCurrentProject(id);
    setSection(s);
    setView('manage');
  };

  return (
    <div className="setup">
      {view === 'home' || !project ? (
        <ProjectsHome
          projects={projects.all}
          currentId={project?.id ?? null}
          error={online ? memberError : null}
          offline={!online}
          createBlocked={createBlocked}
          onCreate={() => setCreating(true)}
          onOpen={async (id) => {
            await setCurrentProject(id);
            onOpenProject();
          }}
          onManage={(id) => manage(id)}
          archived={<Archived projects={projects.all.filter((p) => p.status === 'archived')} readOnly={!online} />}
        />
      ) : (
        <>
          <div className="manage-head">
            <button className="link back-link" onClick={() => setView('home')}>
              ‹ כל הפרויקטים
            </button>
            <h2 className="section-title">
              ניהול: <bdi>{project.name}</bdi> <span className="pb-code" dir="ltr">{project.code}</span>
            </h2>
          </div>
          {!online && <div className="alert info">אין חיבור. מוצגים הנתונים שסונכרנו למכשיר; עריכת הגדרות הפרויקט דורשת חיבור.</div>}
          {online && members && !canWrite(role) && <div className="alert info">הרשאת צפייה בלבד בארגון הזה.</div>}
          {memberError && online && <div className="alert warn">לא ניתן לטעון את ההרשאות: {memberError}</div>}
          {justCreated && (
            <div className="alert info next-step" role="status">
              <span>
                <b>הפרויקט נוצר.</b> הצעדים הבאים: הגדרת מבנה (בניינים, קומות ודירות), שיוך קבלנים, וקבלן ברירת מחדל לכל קטגוריה.
              </span>
              <span className="actions-row">
                <button className="btn" onClick={() => setSection('structure')}>1. מבנה</button>
                <button className="btn" onClick={() => setSection('contractors')}>2. קבלנים</button>
                <button className="btn" onClick={() => setSection('categories')}>3. קטגוריות</button>
                <button className="link" onClick={() => setJustCreated(false)}>סגירה</button>
              </span>
            </div>
          )}
          <div className="seg setup-tabs" role="tablist">
            {SECTIONS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={section === k} className={section === k ? 'on' : ''} onClick={() => setSection(k)}>
                {label}
              </button>
            ))}
          </div>
          {section === 'structure' && <Structure key={project.id} project={project} readOnly={readOnly} />}
          {section === 'contractors' && <Contractors key={project.id} project={project} readOnly={readOnly} />}
          {section === 'categories' && <Categories key={project.id} project={project} readOnly={readOnly} />}
          {section === 'details' && <ProjectDetails key={`${project.id}:${project.version}`} project={project} readOnly={readOnly} onArchived={() => setView('home')} />}
        </>
      )}

      {creating && (
        <NewProject
          orgs={writableOrgs}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setSection('structure');
            setView('manage');
            setJustCreated(true);
          }}
        />
      )}
    </div>
  );
}

interface ProjectStats {
  open: number;
  total: number;
  pending: number;
  units: number;
  buildings: number;
  tour: TourRow | null;
}

/** "הפרויקטים שלי": every project on this device, from the device's own data (works offline). */
function ProjectsHome({
  projects,
  currentId,
  error,
  offline,
  createBlocked,
  onCreate,
  onOpen,
  onManage,
  archived,
}: {
  projects: ProjectRow[];
  currentId: string | null;
  error: string | null;
  offline: boolean;
  createBlocked: string | null;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onManage: (id: string) => void;
  archived: ReactNode;
}) {
  const [q, setQ] = useState('');
  const active = projects.filter((p) => p.status === 'active');
  const stats = useLiveQuery(async () => {
    const out = new Map<string, ProjectStats>();
    const findings = await db.findings.toArray();
    const locs = await db.locations.toArray();
    for (const p of active) {
      const fs = findings.filter((f) => f.projectId === p.id && !f.deletedAt);
      const tourId = await getMeta<string>(`activeTour:${p.id}`);
      const tour = tourId ? ((await db.tours.get(tourId)) ?? null) : null;
      const ls = locs.filter((l) => l.project_id === p.id && !l.deleted_at);
      out.set(p.id, {
        open: fs.filter((f) => f.status === 'open' || f.status === 'reopened' || f.status === 'reported_done').length,
        total: fs.length,
        pending: fs.filter((f) => f.dirty).length,
        units: ls.filter((l) => l.kind === 'unit').length,
        buildings: ls.filter((l) => l.kind === 'building').length,
        tour: tour && tour.status === 'active' ? tour : null,
      });
    }
    return out;
  }, [projects]);
  const words = q.trim().toLowerCase();
  const shown = active.filter((p) => !words || `${p.name} ${p.code} ${p.address} ${p.developer}`.toLowerCase().includes(words));
  return (
    <section className="projects-home" aria-labelledby="ph-title">
      <div className="ph-head">
        <h2 className="ph-title" id="ph-title">הפרויקטים שלי</h2>
        <button className="btn primary-solid ph-new" disabled={!!createBlocked} onClick={onCreate}>
          + פרויקט חדש
        </button>
      </div>
      {createBlocked && <div className="muted">{createBlocked}</div>}
      {offline && <div className="alert info">אין חיבור. הפרויקטים שבמכשיר זמינים לתיעוד; יצירה ועריכת הגדרות דורשות חיבור.</div>}
      {error && <div className="alert warn">לא ניתן לטעון את ההרשאות: {error}</div>}
      {active.length > 4 && (
        <label className="ff-search ph-search">
          <span className="sr-only">חיפוש פרויקט</span>
          <input type="search" value={q} placeholder="חיפוש לפי שם, קוד או כתובת" onChange={(e) => setQ(e.target.value)} />
        </label>
      )}
      {!active.length && (
        <div className="empty-state ph-empty">
          <b>עדיין אין פרויקטים במכשיר</b>
          <span>צור פרויקט חדש, או התחבר לאינטרנט כדי לקבל את הפרויקטים של הארגון מהשרת.</span>
          {!createBlocked && (
            <button className="primary" onClick={onCreate}>
              צור את הפרויקט הראשון
            </button>
          )}
        </div>
      )}
      {active.length > 0 && !shown.length && (
        <div className="empty-state">
          <span>אין פרויקט שמתאים לחיפוש.</span>
          <button className="btn" onClick={() => setQ('')}>נקה חיפוש</button>
        </div>
      )}
      <div className="ph-grid">
        {shown.map((p) => {
          const st = stats?.get(p.id);
          return (
            <article key={p.id} className={`ph-card card ${p.id === currentId ? 'is-current' : ''}`} data-id={p.id} aria-labelledby={`ph-${p.id}`}>
              <div className="ph-card-top">
                <h3 id={`ph-${p.id}`}>
                  <bdi>{p.name}</bdi>
                </h3>
                <span className="pb-code" dir="ltr">{p.code}</span>
                {p.id === currentId && <span className="tag ok">הפרויקט הפעיל</span>}
              </div>
              {(p.address || p.developer) && <div className="muted">{[p.address, p.developer].filter(Boolean).join(' · ')}</div>}
              {st && (
                <div className="ph-stats">
                  <span>
                    <b>{st.open}</b> ממצאים פתוחים
                  </span>
                  <span>{st.total} ממצאים בסך הכול</span>
                  <span>{st.buildings ? `${st.buildings} בניינים · ${st.units} דירות` : 'עדיין אין מבנה'}</span>
                </div>
              )}
              {st?.tour && <div className="ph-tour"><span className="pb-dot" aria-hidden="true" /> סיור פעיל: {tourLabel(st.tour)}</div>}
              {!!st?.pending && <div className="tag warn">{st.pending} ממצאים ממתינים לסנכרון</div>}
              <div className="ph-actions">
                <button className="primary" aria-label={`פתח את ${p.name}`} onClick={() => onOpen(p.id)}>
                  {st?.tour ? 'המשך לתעד' : 'פתח'}
                </button>
                <button className="btn" aria-label={`ניהול ${p.name}`} onClick={() => onManage(p.id)}>
                  ניהול
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {archived}
    </section>
  );
}

function Archived({ projects, readOnly }: { projects: ProjectRow[]; readOnly: boolean }) {
  const { busy, error, run } = useRunner();
  if (!projects.length) return null;
  return (
    <details className="archived">
      <summary>פרויקטים בארכיון ({projects.length})</summary>
      {projects.map((p) => (
        <div key={p.id} className="row-line">
          <span>
            {p.name} <span className="code" dir="ltr">{p.code}</span>
          </span>
          {!readOnly && (
            <button className="btn" disabled={busy} onClick={() => run(() => updateProject(p, { status: 'active' }))}>
              החזר לפעילות
            </button>
          )}
        </div>
      ))}
      <ErrorBox error={error} />
    </details>
  );
}

const EMPTY: ProjectFields = { code: '', name: '', address: '', developer: '' };

function ProjectFieldsForm({ value, onChange, disabled }: { value: ProjectFields; onChange: (v: ProjectFields) => void; disabled?: boolean }) {
  const set = (patch: Partial<ProjectFields>) => onChange({ ...value, ...patch });
  return (
    <div className="form-grid">
      <Field label="שם הפרויקט">
        <input value={value.name} disabled={disabled} onChange={(e) => set({ name: e.target.value })} placeholder="לדוגמה: מגדלי הפארק — שלב ב׳" />
      </Field>
      <Field label="קוד" hint="מופיע במספרי הדוחות, לדוגמה PARK-P-001" ltr>
        <input value={value.code} disabled={disabled} dir="ltr" maxLength={12} onChange={(e) => set({ code: e.target.value.toUpperCase() })} placeholder="PARK" />
      </Field>
      <Field label="כתובת">
        <input value={value.address} disabled={disabled} onChange={(e) => set({ address: e.target.value })} />
      </Field>
      <Field label="יזם / מזמין">
        <input value={value.developer} disabled={disabled} onChange={(e) => set({ developer: e.target.value })} />
      </Field>
    </div>
  );
}

function NewProject({ orgs, onClose, onCreated }: { orgs: Membership[]; onClose: () => void; onCreated: () => void }) {
  const [fields, setFields] = useState<ProjectFields>(EMPTY);
  const [orgId, setOrgId] = useState(orgs[0]?.orgId ?? '');
  const { busy, error, setError, run } = useRunner();
  const submit = async () => {
    const invalid = validateProject(fields);
    if (invalid) return setError(invalid);
    if (await run(() => createProject(orgId, fields))) {
      onCreated();
      onClose();
    }
  };
  return (
    <Sheet title="פרויקט חדש" onClose={onClose}>
      {orgs.length > 1 && (
        <Field label="ארגון">
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((o) => (
              <option key={o.orgId} value={o.orgId}>{o.orgName}</option>
            ))}
          </select>
        </Field>
      )}
      <ProjectFieldsForm value={fields} onChange={setFields} />
      <p className="muted">אחרי היצירה הפרויקט נבחר כפעיל, ואפשר להגדיר את המבנה, הקבלנים וקבלני ברירת המחדל.</p>
      <ErrorBox error={error} />
      <button className="primary" disabled={busy} onClick={submit}>
        {busy ? 'יוצר…' : 'צור פרויקט'}
      </button>
    </Sheet>
  );
}

function ProjectDetails({ project, readOnly, onArchived }: { project: ProjectRow; readOnly: boolean; onArchived: () => void }) {
  const [fields, setFields] = useState<ProjectFields>({ code: project.code, name: project.name, address: project.address, developer: project.developer });
  const [saved, setSaved] = useState(false);
  const { busy, error, setError, run } = useRunner();
  const dirty = (Object.keys(fields) as (keyof ProjectFields)[]).some((k) => fields[k] !== project[k]);
  const save = async () => {
    const invalid = validateProject(fields);
    if (invalid) return setError(invalid);
    setSaved(await run(() => updateProject(project, fields)));
  };
  return (
    <div className="card setup-card">
      <ProjectFieldsForm
        value={fields}
        disabled={readOnly}
        onChange={(v) => {
          setFields(v);
          setSaved(false);
        }}
      />
      <ErrorBox error={error} />
      {saved && !dirty && <div className="alert info">נשמר.</div>}
      {!readOnly && (
        <div className="actions-row">
          <button className="btn primary-solid" disabled={busy || !dirty} onClick={save}>
            {busy ? 'שומר…' : 'שמור שינויים'}
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => (await run(() => updateProject(project, { status: 'archived' }))) && onArchived()}
            title="פרויקט בארכיון לא מוצג בתיעוד. הנתונים נשמרים."
          >
            העבר לארכיון
          </button>
        </div>
      )}
    </div>
  );
}
