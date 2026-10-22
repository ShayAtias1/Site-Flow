import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProjectModel } from '../../shared/projectModel';
import { unitShortLabel } from '../../shared/structure';
import { CLASSIFICATION_LABEL, type Classification } from '../../shared/types';
import { db, type CaptureDraft, type TourRow } from '../db';
import { draftKey, SaveError, saveNewFinding } from '../findings';
import { Icon } from '../icons';
import { storePhoto } from '../image';
import { useProjectModel, useProjects } from '../projectData';
import { useActiveTour } from '../tours';
import { StartTour, tourLabel } from './Tours';
import { scheduleSync } from '../sync';
import { Dialog } from './Dialog';
import { PhotoThumb } from './PhotoThumb';

const RECENT_KEY = 'sf.recentCategories';

const emptyDraft = (locationId: string): CaptureDraft => ({
  locationId,
  categoryId: '',
  contractorId: '',
  contractorTouched: false,
  classification: 'missing',
  description: '',
  locationDetail: '',
  photoIds: [],
});

// Each project has its own draft, so switching projects never carries text or photos across.
const LEGACY_MIRROR_KEY = 'sf.draftMirror';
const mirrorKey = (projectId: string) => `${LEGACY_MIRROR_KEY}:${projectId}`;

function readDraftMirror(key: string): { data: CaptureDraft; updatedAt: string } | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function writeDraftMirror(projectId: string, data: CaptureDraft) {
  try {
    localStorage.setItem(mirrorKey(projectId), JSON.stringify({ data, updatedAt: new Date().toISOString() }));
  } catch {
    /* the IndexedDB copy is still written */
  }
}

/**
 * The project's draft: whichever copy (IndexedDB or the synchronous localStorage mirror) is newer.
 * The single draft of earlier versions is adopted only by the project its location belongs to.
 */
async function loadDraft(projectId: string, belongs: (d: CaptureDraft) => boolean): Promise<CaptureDraft | null> {
  const key = draftKey(projectId);
  const row = await db.drafts.get(key);
  const mirror = readDraftMirror(mirrorKey(projectId));
  const own = mirror && (!row || mirror.updatedAt > row.updatedAt) ? mirror.data : row?.data;
  if (own) return own;
  const legacyRow = await db.drafts.get('capture');
  const legacyMirror = readDraftMirror(LEGACY_MIRROR_KEY);
  const legacy = legacyMirror && (!legacyRow || legacyMirror.updatedAt > legacyRow.updatedAt) ? legacyMirror.data : legacyRow?.data;
  if (!legacy || !belongs(legacy)) return null;
  await db.drafts.put({ key, data: legacy, updatedAt: new Date().toISOString() });
  await db.drafts.delete('capture');
  try {
    localStorage.removeItem(LEGACY_MIRROR_KEY);
  } catch {
    /* nothing to clean */
  }
  return legacy;
}

function recentCategories(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

/** Keeps the save bar on top of the iOS keyboard: exposes its height as --sf-kb and flags .kb-open. */
function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--sf-kb', `${inset}px`);
      root.classList.toggle('kb-open', inset > 80);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.classList.remove('kb-open');
      root.style.removeProperty('--sf-kb');
    };
  }, []);
}

export function LocationPicker({
  model,
  current,
  counts,
  onPick,
  onClose,
  extra,
  onPickMany,
  embedded = false,
}: {
  model: ProjectModel;
  current: string;
  /** Findings per location in this project (this device). */
  counts: Map<string, number>;
  onPick: (id: string) => void;
  onClose: () => void;
  /** (M5) With onPickMany, several locations can be chosen: `current` plus `extra`. */
  extra?: string[];
  onPickMany?: (ids: string[]) => void;
  /** Rendered as a view inside another popup (with its own Back action) instead of a popup of its own. */
  embedded?: boolean;
}) {
  const { locations: LOCATIONS, locationPath, walkOrder } = model;
  const roots = LOCATIONS.filter((n) => !n.parentId);
  const [root, setRoot] = useState(locationPath(current)[0]?.id ?? roots[0].id);
  const [query, setQuery] = useState('');
  const [multi, setMulti] = useState(!!extra?.length);
  const [chosen, setChosen] = useState<string[]>(() => [current, ...(extra ?? [])]);
  const children = LOCATIONS.filter((n) => n.parentId === root);
  const commons = children.filter((n) => n.kind !== 'floor');
  const floors = children.filter((n) => n.kind === 'floor');
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const pick = (id: string) => (multi ? toggle(id) : onPick(id));
  const isOn = (id: string) => (multi ? chosen.includes(id) : id === current);
  /** Every unit and common area on the floor — all on, or all off if they already were. */
  const toggleFloor = (floorId: string) => {
    const ids = LOCATIONS.filter((n) => n.parentId === floorId).map((n) => n.id);
    const all = ids.every((id) => chosen.includes(id));
    setChosen((c) => (all ? c.filter((x) => !ids.includes(x)) : [...c, ...ids.filter((x) => !c.includes(x))]));
  };
  // Walking order, so the batch's findings are numbered the way the tour walks.
  const ordered = walkOrder.filter((n) => chosen.includes(n.id)).map((n) => n.id);
  const Chip = ({ id, name, short }: { id: string; name: string; short?: boolean }) => {
    const n = counts.get(id);
    return (
      <button className={`chip ${isOn(id) ? 'on' : ''} ${multi ? 'multi' : ''}`} aria-pressed={isOn(id)} aria-label={name} onClick={() => pick(id)}>
        {multi && <span className={`cbox ${isOn(id) ? 'on' : ''}`} aria-hidden="true" />}
        {short ? unitShortLabel(name) : name}
        {!!n && <span className="chip-count" aria-label={`${n} ממצאים`}>{n}</span>}
      </button>
    );
  };
  // Quick jump: "12" finds דירה 12 in every building; text matches names and codes.
  const q = query.trim().toLowerCase();
  const matches = q
    ? walkOrder.filter((n) => {
        const name = n.name.toLowerCase();
        return /^\d+$/.test(q) ? new RegExp(`(^|\\D)${q}$`).test(name) : name.includes(q) || n.code.toLowerCase().includes(q);
      })
    : [];
  const currentName = model.locationLabel(current);
  const body = (
    <>
        {onPickMany && (
          <div className="seg picker-mode" role="radiogroup" aria-label="מצב בחירה">
            <button role="radio" aria-checked={!multi} className={multi ? '' : 'on'} onClick={() => setMulti(false)}>
              מיקום אחד
            </button>
            <button role="radio" aria-checked={multi} className={multi ? 'on' : ''} onClick={() => setMulti(true)}>
              כמה מיקומים
            </button>
          </div>
        )}
        {multi && (
          <div className="picker-selection" role="status">
            <span>
              <b>נבחרו {ordered.length}</b>
              {chosen.includes(current) && <span className="muted"> · המיקום הנוכחי ({currentName}) נבחר מראש — הקש עליו כדי להסיר</span>}
            </span>
            <button className="link" disabled={!chosen.length} onClick={() => setChosen([])}>
              נקה בחירה
            </button>
          </div>
        )}
        <label className="picker-search">
          <Icon name="search" size={18} />
          <input
            value={query}
            inputMode="search"
            placeholder="מספר דירה או שם שטח"
            aria-label="חיפוש מיקום"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {q ? (
          <div className="picker-results">
            {matches.slice(0, 40).map((n) => (
              <button key={n.id} className={`picker-result ${isOn(n.id) ? 'on' : ''}`} aria-pressed={isOn(n.id)} onClick={() => pick(n.id)}>
                <b>{n.name}</b>
                <span className="muted">{locationPath(n.id).slice(0, -1).map((p) => p.name).join(' › ')}</span>
                {!!counts.get(n.id) && <span className="chip-count">{counts.get(n.id)}</span>}
              </button>
            ))}
            {!matches.length && <div className="muted">לא נמצא מיקום</div>}
          </div>
        ) : (
          <>
            <div className="seg picker-roots">
              {roots.map((r) => (
                <button key={r.id} className={r.id === root ? 'on' : ''} onClick={() => setRoot(r.id)}>
                  {r.name}
                </button>
              ))}
            </div>
            {commons.length > 0 && (
              <>
                <div className="label">שטחים משותפים</div>
                <div className="chips commons">{commons.map((n) => <Chip key={n.id} id={n.id} name={n.name} />)}</div>
              </>
            )}
            {floors.length > 0 && <div className="label">דירות לפי קומה</div>}
            {floors.map((f) => (
              <div key={f.id} className="picker-floor">
                {multi ? (
                  (() => {
                    const ids = LOCATIONS.filter((n) => n.parentId === f.id).map((n) => n.id);
                    const on = ids.filter((id) => chosen.includes(id)).length;
                    const state = on === 0 ? 'off' : on === ids.length ? 'on' : 'mixed';
                    return (
                      <button
                        className="floor-name floor-all"
                        aria-label={`כל ${f.name}`}
                        aria-pressed={state === 'mixed' ? 'mixed' : state === 'on'}
                        onClick={() => toggleFloor(f.id)}
                      >
                        <span className={`cbox ${state}`} aria-hidden="true" />
                        {f.name}
                        <small>הכול</small>
                      </button>
                    );
                  })()
                ) : (
                  <span className="floor-name">{f.name}</span>
                )}
                <div className="chips grid4">
                  {LOCATIONS.filter((n) => n.parentId === f.id).map((n) => <Chip key={n.id} id={n.id} name={n.name} short={n.kind === 'unit'} />)}
                </div>
              </div>
            ))}
          </>
        )}
    </>
  );
  if (embedded) return body;
  const footer =
    multi && onPickMany ? (
      <div className="picker-done">
        <button className="primary" disabled={!ordered.length} onClick={() => onPickMany(ordered)}>
          {ordered.length > 1 ? `ממצא ב-${ordered.length} מיקומים` : ordered.length ? 'מיקום אחד' : 'בחר מיקומים'}
        </button>
      </div>
    ) : undefined;
  return (
    <Dialog title={`בחירת מיקום · ${model.project.name}`} label="בחירת מיקום" onClose={onClose} className="picker-sheet" footer={footer}>
      {body}
    </Dialog>
  );
}

export function Capture({ alerts, onTours, onFindings }: { alerts?: ReactNode; onTours: () => void; onFindings: () => void }) {
  const model = useProjectModel();
  const projects = useProjects();
  const tour = useActiveTour(model?.project.id);
  if (model === undefined || !projects || tour === undefined) return null;
  if (!model || !model.walkOrder.length)
    return (
      <div className="capture">
        {alerts}
        <div className="alert warn">
          {model
            ? `לפרויקט "${model.project.name}" עדיין אין מבנה. הגדר בניינים, קומות ודירות בלשונית "פרויקטים".`
            : 'אין עדיין פרויקט במכשיר. צור פרויקט בלשונית "פרויקטים", או התחבר לאינטרנט כדי לסנכרן את הפרויקטים מהשרת.'}
        </div>
      </div>
    );
  const several = projects.all.filter((p) => p.status === 'active').length > 1;
  // Every new finding belongs to the tour it was recorded in: capture starts with a tour.
  if (!tour)
    return (
      <div className="capture">
        {alerts}
        <StartTour project={projects.current!} model={model} />
      </div>
    );
  // Remounted per project: the draft's location is re-checked against the new project's structure.
  return <CaptureForm key={model.project.id} alerts={alerts} model={model} showProject={several} tour={tour} onTours={onTours} onFindings={onFindings} />;
}

function CaptureForm({
  alerts,
  model,
  showProject,
  tour,
  onTours,
  onFindings,
}: {
  alerts?: ReactNode;
  model: ProjectModel;
  showProject: boolean;
  tour: TourRow;
  onTours: () => void;
  onFindings: () => void;
}) {
  const { categories: CATEGORIES, contractors: CONTRACTORS, project: PROJECT, walkOrder: WALK_ORDER } = model;
  const { categoryById, locationById, locationPath } = model;
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [picking, setPicking] = useState(false);
  const [busyPhoto, setBusyPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ main: string; sub: string } | null>(null);
  const [allCats, setAllCats] = useState(false);
  useKeyboardInset();
  const descRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<CaptureDraft | null>(null);
  draftRef.current = draft;

  // Restore the draft exactly as it was — including after iOS killed the app.
  // Whichever copy (IndexedDB or the synchronous localStorage mirror) is newer wins.
  useEffect(() => {
    loadDraft(PROJECT.id, (d) => !!locationById(d.locationId)).then((saved) => {
      const d = saved ?? emptyDraft(WALK_ORDER[0].id);
      // A restored draft may point at setup that no longer exists (e.g. the PoC demo project).
      setDraft({
        ...d,
        locationId: locationById(d.locationId) ? d.locationId : WALK_ORDER[0].id,
        extraLocationIds: (d.extraLocationIds ?? []).filter((id) => locationById(id) && id !== d.locationId),
        // Only categories and contractors offered in this project survive a restore or a project switch.
        categoryId: CATEGORIES.some((c) => c.id === d.categoryId) ? d.categoryId : '',
        contractorId: CONTRACTORS.some((c) => c.id === d.contractorId) ? d.contractorId : '',
      });
    });
  }, []);

  // Every change goes to localStorage at once (synchronous, survives an abrupt kill)
  // and to IndexedDB debounced.
  useEffect(() => {
    if (!draft) return;
    writeDraftMirror(PROJECT.id, draft);
    const t = setTimeout(() => db.drafts.put({ key: draftKey(PROJECT.id), data: draft, updatedAt: new Date().toISOString() }), 250);
    return () => clearTimeout(t);
  }, [draft]);
  useEffect(() => {
    const flush = () => {
      const d = draftRef.current;
      if (d) db.drafts.put({ key: draftKey(PROJECT.id), data: d, updatedAt: new Date().toISOString() });
    };
    const onVis = () => document.visibilityState === 'hidden' && flush();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  const counts = useLiveQuery(async () => {
    const m = new Map<string, number>();
    await db.findings.filter((f) => f.projectId === PROJECT.id && !f.deletedAt).each((f) => m.set(f.locationId, (m.get(f.locationId) ?? 0) + 1));
    return m;
  }, [PROJECT.id]);
  const hereCount = draft ? counts?.get(draft.locationId) ?? 0 : 0;
  const inTour = useLiveQuery(() => db.findings.where('tourId').equals(tour.id).filter((f) => !f.deletedAt).count(), [tour.id]);

  const orderedCats = useMemo(() => {
    const recent = recentCategories();
    return [...CATEGORIES].sort((a, b) => {
      const ia = recent.indexOf(a.id);
      const ib = recent.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    // Re-sort only when the category (or the setup) changes, so chips don't jump while typing.
  }, [draft?.categoryId, CATEGORIES]);

  if (!draft) return null;
  const set = (patch: Partial<CaptureDraft>) => setDraft({ ...draft, ...patch });
  const idx = WALK_ORDER.findIndex((n) => n.id === draft.locationId);
  const go = (d: number) => set({ locationId: WALK_ORDER[(idx + d + WALK_ORDER.length) % WALK_ORDER.length].id });
  const cat = categoryById(draft.categoryId);

  const pickCategory = (id: string) => {
    const c = categoryById(id)!;
    set({ categoryId: id, contractorId: draft.contractorTouched ? draft.contractorId : c.defaultContractorId });
    // Focus inside the tap handler, so iOS opens the keyboard.
    descRef.current?.focus();
  };

  const addPhrase = (p: string) => {
    const d = draft.description.trim();
    set({ description: d ? `${d}, ${p}` : p });
    descRef.current?.focus();
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusyPhoto(true);
    setError(null);
    let ids = [...draft.photoIds];
    try {
      for (const f of Array.from(files)) {
        const p = await storePhoto(f);
        ids = [...ids, p.id];
        const next = { ...draftRef.current!, photoIds: ids };
        setDraft(next);
        await db.drafts.put({ key: draftKey(PROJECT.id), data: next, updatedAt: new Date().toISOString() });
      }
    } catch (e) {
      setError(`שמירת התמונה נכשלה: ${(e as Error).name} ${(e as Error).message}`);
    } finally {
      setBusyPhoto(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removePhoto = async (id: string) => {
    set({ photoIds: draft.photoIds.filter((p) => p !== id) });
    await db.photos.delete(id);
  };

  const save = async () => {
    setError(null);
    try {
      const saved = await saveNewFinding(draft, PROJECT.id, tour.id);
      const recent = [draft.categoryId, ...recentCategories().filter((c) => c !== draft.categoryId)].slice(0, 9);
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
      setDraft({ ...draft, description: '', locationDetail: '', photoIds: [], extraLocationIds: [], classification: 'missing' });
      const what = saved.length > 1 ? `נשמרו ${saved.length} ממצאים` : 'נשמר במכשיר';
      setToast({
        main: saved[0].photoIds.length ? `${what} · ${saved[0].photoIds.length} תמונות` : what,
        sub: navigator.onLine ? 'מסנכרן…' : 'יסונכרן כשיחזור חיבור',
      });
      setTimeout(() => setToast(null), 3500);
      scheduleSync();
    } catch (e) {
      // The form keeps its content; nothing is lost.
      setError(e instanceof SaveError ? `${e.message}. הטקסט נשמר בטופס — אל תסגור את האפליקציה.` : String(e));
    }
  };

  const canSave = draft.description.trim().length > 0 && !busyPhoto;
  const critical = draft.classification === 'critical';
  const path = locationPath(draft.locationId);
  const parents = path.slice(0, -1);
  const unit = path[path.length - 1];
  const extras = draft.extraLocationIds ?? [];

  return (
    <div className="capture">
      <div className="locbar">
        <button className="nav" aria-label="היחידה הקודמת" disabled={extras.length > 0} onClick={() => go(-1)}>
          <Icon name="prev" size={22} strokeWidth={2.2} />
        </button>
        <button className="loc" aria-label={`מיקום: ${path.map((n) => n.name).join(' › ')}. בחירת מיקום`} onClick={() => setPicking(true)}>
          {(parents.length > 0 || showProject) && (
            <span className="loc-path">
              {showProject && <span className="loc-project">{PROJECT.code}</span>}
              {parents.map((n) => n.name).join(' › ')}
              {parents.length > 0 && ' ›'}
            </span>
          )}
          <span className="loc-unit">
            <span className="loc-name">{unit?.name}</span>
            {extras.length > 0 ? (
              <span className="loc-count multi">+{extras.length} מיקומים</span>
            ) : (
              <span className="loc-count">{hereCount ? `${hereCount} ממצאים` : 'אין ממצאים'}</span>
            )}
            <Icon name="down" size={16} strokeWidth={2.4} />
          </span>
        </button>
        <button className="nav" aria-label="היחידה הבאה" disabled={extras.length > 0} onClick={() => go(1)}>
          <Icon name="next" size={22} strokeWidth={2.2} />
        </button>
      </div>

      {extras.length > 0 && (
        <div className="multi-strip" role="status">
          <b>ממצא נפרד לכל אחד מ-{extras.length + 1} המיקומים:</b>{' '}
          {[draft.locationId, ...extras].map((id) => model.locationLabel(id)).join(' · ')}
          <div className="multi-note">
            לכל ממצא מספר, סטטוס והיסטוריה משלו. תמונות שמצורפות עכשיו משותפות לכל {extras.length + 1} הממצאים; תמונה שתוסיף אחר כך לממצא אחד — רק לו.
          </div>
          <button className="link" onClick={() => set({ extraLocationIds: [] })}>
            חזרה למיקום אחד ({unit?.name})
          </button>
        </div>
      )}

      <button className="tour-strip" onClick={onTours} aria-label={`סיור: ${tourLabel(tour)}. מעבר לסיורים`}>
        <span className="tour-strip-name">{tourLabel(tour)}</span>
        <span className="muted">{inTour ?? 0} ממצאים בסיור</span>
        <span className="link-text">סיורים</span>
      </button>

      {alerts}

      <div className="capture-body">
        <section>
          <div className="section-head">
            <span className="label" id="cat-label">קטגוריה</span>
            <button className="link cat-all" aria-expanded={allCats} onClick={() => setAllCats(!allCats)}>
              {allCats ? 'שורה אחת' : `כל הקטגוריות (${CATEGORIES.length})`}
            </button>
          </div>
          <div className={`chips ${allCats ? 'wrap' : 'scroll'}`} role="group" aria-labelledby="cat-label">
            {orderedCats.map((c) => (
              <button
                key={c.id}
                className={`chip ${c.id === draft.categoryId ? 'on' : ''}`}
                aria-pressed={c.id === draft.categoryId}
                onClick={() => pickCategory(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
        </section>

        <section className="card compose">
          <div className="desc-wrap">
            <label className="label" htmlFor="capture-desc">
              תיאור <span className="req" aria-hidden="true">*</span>
            </label>
            <textarea
              id="capture-desc"
              ref={descRef}
              className="desc"
              rows={3}
              required
              placeholder="הקלד או הכתב (מיקרופון במקלדת)"
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </div>
          {cat && cat.phrases.length > 0 && (
            <div className="phrases">
              <span className="label">ביטויים מהירים · {cat.name}</span>
              <div className="chips scroll">
                {cat.phrases.map((p) => {
                  const added = draft.description.includes(p);
                  return (
                    <button key={p} className={`chip ghost ${added ? 'added' : ''}`} aria-pressed={added} onClick={() => !added && addPhrase(p)}>
                      <Icon name={added ? 'check' : 'plus'} size={15} strokeWidth={2.5} />
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="photos">
            {draft.photoIds.map((id) => (
              <PhotoThumb key={id} id={id} onRemove={() => removePhoto(id)} />
            ))}
            <button className="add-photo" aria-label="צירוף תמונה" disabled={busyPhoto} onClick={() => fileRef.current?.click()}>
              {busyPhoto ? 'שומר…' : <Icon name="camera" size={22} />}
            </button>
            {!draft.photoIds.length && !busyPhoto && (
              <span className="photos-hint">{extras.length ? `צילום (לא חובה) — משותף לכל ${extras.length + 1} הממצאים` : 'צילום או תמונה מהספרייה (לא חובה)'}</span>
            )}
            <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => onFiles(e.target.files)} />
          </div>
        </section>

        <section>
          <div className="section-head">
            <span className="label">פרטים נוספים</span>
            <span className="hint">אופציונלי</span>
          </div>
          <div className="card details">
            <label className="drow">
              <Icon name="pin" />
              <span className="drow-label">מיקום מדויק</span>
              <input
                className="drow-input"
                placeholder="הוסף"
                value={draft.locationDetail}
                onChange={(e) => set({ locationDetail: e.target.value })}
              />
            </label>
            <label className="drow">
              <Icon name="hardhat" />
              <span className="drow-label">קבלן</span>
              {draft.contractorId && !draft.contractorTouched && <span className="auto-tag">אוטומטי</span>}
              <select
                className="drow-select"
                value={draft.contractorId}
                onChange={(e) => set({ contractorId: e.target.value, contractorTouched: true })}
              >
                <option value="">בחר</option>
                {CONTRACTORS.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <span className="chev"><Icon name="chevron" size={16} strokeWidth={2.4} /></span>
            </label>
            <div className="seg-wrap">
              <div className="seg cls" role="group" aria-label="סיווג">
                {(['missing', 'defective', 'critical'] as Classification[]).map((c) => (
                  <button
                    key={c}
                    className={`${draft.classification === c ? 'on' : ''} ${c}`}
                    aria-pressed={draft.classification === c}
                    onClick={() => set({ classification: c })}
                  >
                    {c === 'critical' && <Icon name="alert" size={15} strokeWidth={2.4} />}
                    {CLASSIFICATION_LABEL[c]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {error && <div className="alert error" role="alert">{error}</div>}
      </div>

      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={18} strokeWidth={2.6} />
          <span className="toast-main">{toast.main}</span>
          <span className="toast-sub">{toast.sub}</span>
          <button className="toast-link" onClick={onFindings}>לממצאים</button>
        </div>
      )}

      <div className={`savebar ${critical ? 'critical' : ''}`}>
        {critical && (
          <div className="savebar-note">
            <Icon name="alert" size={18} strokeWidth={2.2} />
            <b>ליקוי קריטי / בטיחותי</b>
            <span>· יופיע ראשון בדוח</span>
          </div>
        )}
        <button className={`primary ${critical ? 'danger' : ''}`} disabled={!canSave} onClick={save} aria-describedby="save-hint">
          {extras.length ? `שמור ${extras.length + 1} ממצאים` : 'שמור והמשך'}
          <Icon name="save" size={20} strokeWidth={2.2} />
        </button>
        <div className="savebar-hint" id="save-hint">
          {extras.length
            ? `${extras.length + 1} ממצאים נפרדים · אחרי השמירה חוזרים ל${unit?.name}`
            : `הטופס מתנקה ונשארים ב${unit?.name} לממצא הבא`}
        </div>
      </div>
      {picking && (
        <LocationPicker
          model={model}
          current={draft.locationId}
          extra={extras}
          counts={counts ?? new Map()}
          onPickMany={(ids) => {
            set({ locationId: ids[0], extraLocationIds: ids.slice(1) });
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
          onPick={(id) => {
            set({ locationId: id, extraLocationIds: [] });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
