import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProjectModel } from '../../shared/projectModel';
import { CLASSIFICATION_LABEL, STATUS_LABEL, type Classification, type FindingData, type FindingStatus } from '../../shared/types';
import { lastUser } from '../auth';
import { db, type EventRow, type LocalFinding, type TourRow } from '../db';
import { applyFilters, isFiltered, useFindingFilters, useHaystack, useWide } from '../findingFilters';
import { attachPhotos, resolveConflict, updateFinding } from '../findings';
import { Icon } from '../icons';
import { storePhoto } from '../image';
import { useProjectModel, useProjects } from '../projectData';
import { scheduleSync } from '../sync';
import { useActiveTour } from '../tours';
import { LocationPicker } from './Capture';
import { PhotoThumb } from './PhotoThumb';
import { Dialog } from './Dialog';
import { FindingCard } from './FindingCard';
import { FilterBar } from './FindingFilters';
import { FindingsTable } from './FindingsTable';
import { Confirm } from './setup/ui';
import { tourLabel, Tours } from './Tours';

const FIELD_LABEL: Partial<Record<keyof FindingData, string>> = {
  description: 'תיאור',
  locationDetail: 'מיקום מדויק',
  locationId: 'מיקום',
  categoryId: 'קטגוריה',
  contractorId: 'קבלן',
  classification: 'סיווג',
  status: 'סטטוס',
  deletedAt: 'מחיקה',
};

/** History entries use the database's column names. */
const COLUMN_FIELD: Record<string, keyof FindingData> = {
  description: 'description',
  location_id: 'locationId',
  location_detail: 'locationDetail',
  category_id: 'categoryId',
  contractor_id: 'contractorId',
  classification: 'classification',
  photo_ids: 'photoIds',
  status: 'status',
};

function show(m: ProjectModel, field: keyof FindingData, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'status') return STATUS_LABEL[v as FindingStatus];
  if (field === 'classification') return CLASSIFICATION_LABEL[v as Classification];
  if (field === 'contractorId') return m.contractorById(v as string)?.name ?? String(v);
  if (field === 'categoryId') return m.categoryById(v as string)?.name ?? String(v);
  if (field === 'locationId') return m.locationLabel(v as string);
  if (field === 'deletedAt') return 'נמחק';
  if (field === 'photoIds') return `${(v as string[]).length} תמונות`;
  return String(v);
}

export function ConflictSheet({ m, f, tourId, onClose }: { m: ProjectModel; f: LocalFinding; tourId: string | null; onClose: () => void }) {
  const c = f.conflict!;
  const [choice, setChoice] = useState<Partial<Record<keyof FindingData, 'mine' | 'theirs'>>>({});
  const ready = c.fields.every((k) => choice[k]);
  return (
    <Dialog title={`התנגשות בממצא ${f.displayNo ?? ''}`} onClose={onClose} closeText="סגור">
        <p className="muted">
          הממצא נערך גם במכשיר הזה וגם במכשיר אחר. שדות שנערכו רק בצד אחד מוזגו אוטומטית. בחר מה לשמור בכל שדה:
        </p>
        {c.fields.map((k) => (
          <div key={k} className="conflict-field" data-field={k}>
            <div className="label">{FIELD_LABEL[k] ?? k}</div>
            <label className={`opt ${choice[k] === 'mine' ? 'on' : ''}`}>
              <input type="radio" name={k} onChange={() => setChoice({ ...choice, [k]: 'mine' })} />
              <span><b>במכשיר הזה:</b> {show(m, k, f[k])}</span>
            </label>
            <label className={`opt ${choice[k] === 'theirs' ? 'on' : ''}`}>
              <input type="radio" name={k} onChange={() => setChoice({ ...choice, [k]: 'theirs' })} />
              <span><b>בשרת (ממכשיר אחר):</b> {show(m, k, c.server[k])}</span>
            </label>
          </div>
        ))}
        <button
          className="primary"
          disabled={!ready}
          onClick={async () => {
            await resolveConflict(f.id, choice, tourId);
            scheduleSync(200);
            onClose();
          }}
        >
          שמור החלטה
        </button>
    </Dialog>
  );
}

const EVENT_TITLE: Record<EventRow['type'], string> = {
  created: 'נוצר',
  status_changed: 'שינוי סטטוס',
  field_changed: 'עריכה',
  photo_added: 'נוספה תמונה',
  comment: 'הערה',
  deleted: 'נמחק',
  restored: 'שוחזר',
};

function History({ m, f, tours }: { m: ProjectModel; f: LocalFinding; tours: Map<string, TourRow> }) {
  const events = useLiveQuery(async () => (await db.events.where('findingId').equals(f.id).toArray()).sort((a, b) => a.at.localeCompare(b.at)), [f.id]);
  if (!events) return null;
  const me = lastUser()?.id;
  return (
    <div className="history">
      <div className="label">היסטוריה</div>
      {!events.length && <div className="muted">אין היסטוריה רשומה{f.tourId ? '' : ' (ממצא שתועד לפני הגדרת סיורים)'}.</div>}
      {events.map((e) => {
        const tour = e.tourId ? tours.get(e.tourId) : undefined;
        const changes = Object.keys(e.to ?? {})
          .filter((k) => COLUMN_FIELD[k] && k !== 'tour_id')
          .map((k) => {
            const field = COLUMN_FIELD[k];
            return `${FIELD_LABEL[field] ?? k}: מ־${show(m, field, e.from?.[k])} ל־${show(m, field, e.to?.[k])}`;
          });
        return (
          <div key={e.id} className="history-row" data-type={e.type}>
            <div className="history-head">
              <b>{EVENT_TITLE[e.type]}</b>
              <span className="muted">
                {new Date(e.at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}
                {' · '}
                {tour ? tourLabel(tour) : 'מחוץ לסיור'}
                {e.actorId && e.actorId !== me ? ' · משתמש אחר' : ''}
              </span>
              {e.pending ? <span className="tag warn">טרם סונכרן</span> : null}
            </div>
            {e.type !== 'created' && changes.length > 0 && <div className="history-changes">{changes.join(' · ')}</div>}
            {e.note && <div className="history-changes">{e.note}</div>}
            {e.type === 'photo_added' && typeof e.to?.photo_id === 'string' && (
              <div className="photos">
                <PhotoThumb id={e.to.photo_id} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Photos of an existing finding, and adding more — saved at once, like photos in capture. */
function AddPhotos({ f, tourId, onError }: { f: LocalFinding; tourId: string | null; onError: (e: string | null) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    onError(null);
    try {
      // One at a time, as in capture: iOS is strict about image memory.
      for (const file of Array.from(files)) await attachPhotos(f.id, [(await storePhoto(file)).id], tourId);
      scheduleSync();
    } catch (e) {
      onError(`שמירת התמונה נכשלה: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  return (
    <div className="edit-photos">
      {f.photoIds.map((id) => (
        <PhotoThumb key={id} id={id} />
      ))}
      <button className="add-photo" aria-label="הוספת תמונה לממצא" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? 'שומר…' : <Icon name="camera" size={22} />}
      </button>
      {!f.photoIds.length && !busy && <span className="photos-hint">הוסף תמונה (לא חובה)</span>}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden aria-label="קובץ תמונה לממצא" onChange={(e) => onFiles(e.target.files)} />
    </div>
  );
}

export function EditSheet({
  m,
  f,
  tour,
  tours,
  batchSize,
  onClose,
}: {
  m: ProjectModel;
  f: LocalFinding;
  tour: TourRow | null;
  tours: Map<string, TourRow>;
  batchSize: number;
  onClose: () => void;
}) {
  const [d, setD] = useState({
    description: f.description,
    locationId: f.locationId,
    locationDetail: f.locationDetail,
    categoryId: f.categoryId,
    status: f.status,
    classification: f.classification,
    contractorId: f.contractorId,
  });
  const [picking, setPicking] = useState(false);
  const wasPicking = useRef(false);
  useEffect(() => {
    // Into the location view: focus its popup. Back: focus the location button that opened it.
    if (picking) (document.querySelector('[role=dialog]:not([inert])') as HTMLElement | null)?.focus();
    else if (wasPicking.current) (document.querySelector('[role=dialog] .loc-btn') as HTMLElement | null)?.focus();
    wasPicking.current = picking;
  }, [picking]);
  const [err, setErr] = useState<string | null>(null);
  const deleted = !!f.deletedAt;
  const save = async (patch: Partial<FindingData>, close = true) => {
    setErr(null);
    try {
      await updateFinding(f.id, patch, tour?.id ?? null);
      scheduleSync();
      if (close) onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  // Only contractors active in the project can be chosen; a finding keeps its earlier contractor.
  const historicContractor = f.contractorId && !m.contractors.some((c) => c.id === f.contractorId);
  const historicCategory = f.categoryId && !m.categories.some((c) => c.id === f.categoryId);
  const dirty =
    !deleted &&
    (d.description !== f.description || d.locationId !== f.locationId || d.locationDetail !== f.locationDetail || d.categoryId !== f.categoryId ||
      d.status !== f.status || d.classification !== f.classification || d.contractorId !== f.contractorId);
  const title = `${deleted ? 'ממצא שנמחק' : 'עריכת ממצא'} ${f.displayNo ?? '(טרם מוספר)'}`;
  const body = (
    <>
        <div className="muted">
          {f.tourId ? `תועד ב${tours.get(f.tourId) ? tourLabel(tours.get(f.tourId)!) : 'סיור'}` : 'תועד לפני הגדרת סיורים'}
          {!deleted && (tour ? ` · שינויים יירשמו ב${tourLabel(tour)}` : ' · אין סיור פעיל — השינויים יירשמו מחוץ לסיור')}
        </div>
        {batchSize > 1 && (
          <div className="muted">
            נוצר יחד עם {batchSize === 2 ? 'ממצא נוסף אחד' : `${batchSize - 1} ממצאים נוספים`} (אותו תיאור במיקומים אחרים). כל אחד מהם מטופל בנפרד.
          </div>
        )}
        {deleted ? (
          <>
            <div className="item-desc">{f.description}</div>
            {f.photoIds.length > 0 && <div className="photos">{f.photoIds.map((id) => <PhotoThumb key={id} id={id} />)}</div>}
            <div className="muted">{m.locationLabel(f.locationId)}</div>
            {err && <div className="alert error">{err}</div>}
          </>
        ) : (
          <>
            <label className="field">
              <span>תיאור</span>
              <textarea className="desc" rows={3} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
            </label>
            <label className="field">
              <span>מיקום</span>
              <button className="btn loc-btn" onClick={() => setPicking(true)}>
                {m.locationLabel(d.locationId)}
                <Icon name="down" size={16} strokeWidth={2.4} />
              </button>
            </label>
            <input className="detail" value={d.locationDetail} placeholder="מיקום מדויק" aria-label="מיקום מדויק" onChange={(e) => setD({ ...d, locationDetail: e.target.value })} />
            <div className="row2">
              <label className="field">
                <span>קטגוריה</span>
                <select value={d.categoryId} onChange={(e) => setD({ ...d, categoryId: e.target.value })}>
                  <option value="">ללא</option>
                  {m.categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                  {historicCategory && <option value={f.categoryId}>{m.categoryById(f.categoryId)?.name ?? 'קטגוריה שהוסרה'} (הוסרה)</option>}
                </select>
              </label>
              <label className="field">
                <span>קבלן</span>
                <select value={d.contractorId} onChange={(e) => setD({ ...d, contractorId: e.target.value })}>
                  <option value="">ללא</option>
                  {m.contractors.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                  {historicContractor && (
                    <option value={f.contractorId}>{m.contractorById(f.contractorId)?.name ?? 'קבלן שהוסר'} (לא פעיל בפרויקט)</option>
                  )}
                </select>
              </label>
            </div>
            <div className="row2">
              <label className="field">
                <span>סטטוס</span>
                <select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value as FindingStatus })}>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>סיווג</span>
                <select value={d.classification} onChange={(e) => setD({ ...d, classification: e.target.value as Classification })}>
                  {Object.entries(CLASSIFICATION_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
            </div>
            <AddPhotos f={f} tourId={tour?.id ?? null} onError={setErr} />
            {err && <div className="alert error">{err}</div>}
            <div className="sub-block">
              <Confirm
                action="מחק ממצא"
                text="הממצא יוסר מהרשימה ומהדוחות הבאים. הוא נשמר בהיסטוריה, וניתן לשחזר אותו ממסך 'נמחקו'."
                onConfirm={() => save({ deletedAt: new Date().toISOString() })}
              />
            </div>
          </>
        )}
        <History m={m} f={f} tours={tours} />
    </>
  );
  const footer = deleted ? (
    <button className="primary" onClick={() => save({ deletedAt: null })}>
      שחזר ממצא
    </button>
  ) : (
    <button className="primary" disabled={!d.description.trim()} onClick={() => save({ ...d, description: d.description.trim(), locationDetail: d.locationDetail.trim() })}>
      שמור שינויים
    </button>
  );
  // Choosing the location is a view inside the same popup, with a way back — not a second popup.
  const picker = (
    <LocationPicker
      embedded
      model={m}
      current={d.locationId}
      counts={new Map()}
      onClose={() => setPicking(false)}
      onPick={(id) => {
        setD({ ...d, locationId: id });
        setPicking(false);
      }}
    />
  );
  return (
    <Dialog
      title={picking ? 'בחירת מיקום' : title}
      onClose={picking ? () => setPicking(false) : onClose}
      closeText={picking ? 'חזרה לממצא' : 'סגור'}
      dirty={picking ? false : dirty}
      size="wide"
      footer={picking ? undefined : footer}
    >
      {picking ? picker : body}
    </Dialog>
  );
}

type View = 'findings' | 'table' | 'tours';

/** Desktop-sized screens open on the management table; phones on the list. */
const wideScreen = () => window.matchMedia?.('(min-width: 1000px)').matches ?? false;

export function Findings() {
  const m = useProjectModel();
  const projects = useProjects();
  const [view, setView] = useState<View>(() => (sessionStorage.getItem('sf.findingsView') as View) || (wideScreen() ? 'table' : 'findings'));
  const choose = (v: View) => {
    sessionStorage.setItem('sf.findingsView', v);
    setView(v);
  };
  // The project bar's tour button, while this screen is already open.
  useEffect(() => {
    const show = () => setView('tours');
    window.addEventListener('sf:show-tours', show);
    return () => window.removeEventListener('sf:show-tours', show);
  }, []);
  if (!m || !projects?.current) return null;
  return (
    <div className="findings-screen">
      <div className="seg view-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'findings'} className={view === 'findings' ? 'on' : ''} onClick={() => choose('findings')}>
          ממצאים
        </button>
        <button role="tab" aria-selected={view === 'table'} className={view === 'table' ? 'on' : ''} onClick={() => choose('table')}>
          טבלת ניהול
        </button>
        <button role="tab" aria-selected={view === 'tours'} className={view === 'tours' ? 'on' : ''} onClick={() => choose('tours')}>
          סיורים
        </button>
      </div>
      {view === 'tours' ? (
        <Tours project={projects.current} model={m} />
      ) : view === 'table' ? (
        <FindingsTable m={m} />
      ) : (
        <FindingList m={m} />
      )}
    </div>
  );
}

function FindingList({ m }: { m: ProjectModel }) {
  const projectId = m.project.id;
  const all = useLiveQuery(() => db.findings.orderBy('updatedAt').reverse().filter((f) => f.projectId === projectId).toArray(), [projectId]);
  const tourList = useLiveQuery(() => db.tours.where('project_id').equals(projectId).toArray(), [projectId]);
  const active = useActiveTour(projectId);
  const wide = useWide(900);
  const { q, setQ, filters, setFilters, reset } = useFindingFilters(projectId);
  const haystack = useHaystack(all, m);
  const [open, setOpen] = useState<{ id: string; mode: 'edit' | 'conflict' } | null>(null);
  if (!all || !tourList || active === undefined) return null;
  const tours = new Map(tourList.map((t) => [t.id, t]));
  const deletedCount = all.filter((f) => f.deletedAt).length;
  const showDeleted = filters.state === 'deleted';
  const findings = applyFilters(all, q, filters, m, haystack);
  const current = open && all.find((f) => f.id === open.id);
  const batches = new Map<string, number>();
  for (const f of all) if (f.batchId && !f.deletedAt) batches.set(f.batchId, (batches.get(f.batchId) ?? 0) + 1);
  const batchOf = (f: LocalFinding) => (f.batchId ? batches.get(f.batchId) ?? 1 : 1);
  return (
    <div className="list">
      <FilterBar m={m} tours={tourList} q={q} setQ={setQ} filters={filters} setFilters={setFilters} deletedCount={deletedCount} wide={wide} onReset={reset} />
      <div className="list-bar">
        <div className="muted" role="status">
          {findings.length} {showDeleted ? 'ממצאים שנמחקו' : 'ממצאים במכשיר'}
          {findings.length !== all.length && !showDeleted ? ` (מתוך ${all.length})` : ''}
        </div>
        {(deletedCount > 0 || showDeleted) && (
          <button className="link" onClick={() => setFilters({ ...filters, state: showDeleted ? 'active' : 'deleted' })}>
            {showDeleted ? 'חזרה לממצאים' : `נמחקו (${deletedCount})`}
          </button>
        )}
      </div>
      {findings.map((f) => (
        <FindingCard key={f.id} m={m} f={f} batchSize={batchOf(f)} onOpen={() => setOpen({ id: f.id, mode: f.conflict ? 'conflict' : 'edit' })} />
      ))}
      {!findings.length && (
        <div className="empty-state">
          <span>{isFiltered(q, filters) ? 'אין ממצאים שתואמים את החיפוש והמסננים.' : 'עדיין אין ממצאים בפרויקט.'}</span>
          {isFiltered(q, filters) && (
            <button className="btn" onClick={reset}>
              נקה חיפוש ומסננים
            </button>
          )}
        </div>
      )}
      {current && open.mode === 'edit' && <EditSheet m={m} f={current} tour={active} tours={tours} batchSize={batchOf(current)} onClose={() => setOpen(null)} />}
      {current && open.mode === 'conflict' && <ConflictSheet m={m} f={current} tourId={active?.id ?? null} onClose={() => setOpen(null)} />}
    </div>
  );
}
