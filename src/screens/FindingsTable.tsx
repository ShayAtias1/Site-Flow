// M6 findings management: search, filters, sorting, inline and bulk editing, details with photos and
// history, Excel export. Wide screens: a table with a column chooser; details open in the shared popup.
// Narrow screens: cards with the same selection and bulk actions (UX-01/05/13). Everything works on the
// device's copy (offline too); edits go through the same history and sync path as edits in the field.
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { exportFileName, findingsSheet } from '../../shared/findingsSheet';
import type { ProjectModel } from '../../shared/projectModel';
import { CLASSIFICATION_LABEL, STATUS_LABEL, type Classification, type FindingData, type FindingStatus } from '../../shared/types';
import { buildXlsx } from '../../shared/xlsx';
import { db, getMeta, type LocalFinding, type TourRow } from '../db';
import { saveFile } from '../download';
import { applyFilters, isFiltered, NONE, useFindingFilters, useHaystack, useWide } from '../findingFilters';
import { bulkUpdate, updateFinding, type BulkResult } from '../findings';
import { canWrite, type Membership } from '../setup';
import { scheduleSync } from '../sync';
import { useActiveTour } from '../tours';
import { Checkbox } from './Checkbox';
import { FindingCard, SyncTag } from './FindingCard';
import { FilterBar } from './FindingFilters';
import { ConflictSheet, EditSheet } from './Findings';
import { tourLabel } from './Tours';

type SortKey = 'no' | 'location' | 'description' | 'category' | 'contractor' | 'classification' | 'status' | 'tour' | 'updated';
type OptionalColumn = 'category' | 'classification' | 'tour' | 'updated' | 'photos';

const PAGE = 200;
const CLASS_RANK: Record<Classification, number> = { critical: 0, defective: 1, missing: 2 };
const STATUS_RANK: Record<FindingStatus, number> = { open: 0, reopened: 1, reported_done: 2, closed: 3, cancelled: 4 };

const SORT_LABEL: Record<SortKey, string> = {
  no: 'מס׳',
  location: 'מיקום',
  description: 'תיאור',
  category: 'קטגוריה',
  contractor: 'קבלן',
  classification: 'סיווג',
  status: 'סטטוס',
  tour: 'סיור',
  updated: 'עודכן',
};
const OPTIONAL: [OptionalColumn, string][] = [
  ['classification', 'סיווג'],
  ['category', 'קטגוריה'],
  ['tour', 'סיור'],
  ['updated', 'עודכן'],
  ['photos', 'תמונות'],
];
const COLUMNS_KEY = 'sf.ftColumns';

function useColumns() {
  const [cols, setCols] = useState<Set<OptionalColumn>>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? 'null');
      if (Array.isArray(v)) return new Set(v);
    } catch {
      /* default */
    }
    return new Set<OptionalColumn>(['classification', 'category', 'tour', 'updated', 'photos']);
  });
  const toggle = (c: OptionalColumn) => {
    const next = new Set(cols);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setCols(next);
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify([...next]));
    } catch {
      /* per-device convenience */
    }
  };
  return { cols, toggle };
}

/** Saving state of an edit made in a row (saved on the device; syncing is shown separately). */
type RowState = { s: 'saving' } | { s: 'saved' } | { s: 'error'; message: string; patch: Partial<FindingData> };

export function FindingsTable({ m }: { m: ProjectModel }) {
  const projectId = m.project.id;
  const all = useLiveQuery(() => db.findings.where('projectId').equals(projectId).toArray(), [projectId]);
  const tourList = useLiveQuery(() => db.tours.where('project_id').equals(projectId).toArray(), [projectId]);
  const memberships = useLiveQuery(() => getMeta<Membership[]>('memberships'), []);
  const active = useActiveTour(projectId);
  const wide = useWide(900);
  const { q, setQ, filters, setFilters, reset } = useFindingFilters(projectId);
  const { cols, toggle: toggleColumn } = useColumns();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'location', dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<{ id: string; mode: 'edit' | 'conflict' } | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [pending, setPending] = useState<Partial<FindingData>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const role = memberships?.find((x) => x.orgId === m.project.orgId)?.role;
  // Before memberships are cached (first sign-in offline) editing stays possible; the server still checks.
  const readOnly = memberships !== undefined && !!role && !canWrite(role);

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);
  useEffect(() => setLimit(PAGE), [q, filters]);

  const tours = useMemo(() => new Map((tourList ?? []).map((t) => [t.id, t])), [tourList]);
  const walk = useMemo(() => new Map(m.walkOrder.map((n, i) => [n.id, i])), [m]);
  const haystack = useHaystack(all, m);

  const filtered = useMemo(() => {
    if (!all) return [];
    const rows = applyFilters(all, q, filters, m, haystack);
    const name = (s: string | undefined) => s ?? '￿';
    const cmp: Record<SortKey, (a: LocalFinding, b: LocalFinding) => number> = {
      no: (a, b) => (a.displayNo ?? Infinity) - (b.displayNo ?? Infinity),
      location: (a, b) => (walk.get(a.locationId) ?? 1e9) - (walk.get(b.locationId) ?? 1e9),
      description: (a, b) => a.description.localeCompare(b.description, 'he'),
      category: (a, b) => name(m.categoryById(a.categoryId)?.name).localeCompare(name(m.categoryById(b.categoryId)?.name), 'he'),
      contractor: (a, b) => name(m.contractorById(a.contractorId)?.name).localeCompare(name(m.contractorById(b.contractorId)?.name), 'he'),
      classification: (a, b) => CLASS_RANK[a.classification] - CLASS_RANK[b.classification],
      status: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status],
      tour: (a, b) => (tours.get(a.tourId ?? '')?.tour_date ?? '').localeCompare(tours.get(b.tourId ?? '')?.tour_date ?? ''),
      updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    };
    const by = cmp[sort.key];
    // Ties fall back to walking order and number, so the order is stable and predictable.
    return rows.sort((a, b) => by(a, b) * sort.dir || cmp.location(a, b) || cmp.no(a, b));
  }, [all, q, filters, sort, haystack, m, walk, tours]);

  if (!all || !tourList || active === undefined) return null;

  const visibleIds = new Set(filtered.map((f) => f.id));
  const chosen = [...selected].filter((id) => visibleIds.has(id));
  const allChosen = filtered.length > 0 && chosen.length === filtered.length;
  const shown = filtered.slice(0, limit);
  const deletedCount = all.filter((f) => f.deletedAt).length;
  const current = open && all.find((f) => f.id === open.id);
  const batches = new Map<string, number>();
  for (const f of all) if (f.batchId && !f.deletedAt) batches.set(f.batchId, (batches.get(f.batchId) ?? 0) + 1);
  const batchOf = (f: LocalFinding) => (f.batchId ? batches.get(f.batchId) ?? 1 : 1);
  const tourId = active?.id ?? null;
  const selectAll = () => setSelected(allChosen ? new Set() : new Set(filtered.map((f) => f.id)));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const sortBy = (key: SortKey) => setSort(sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: 1 });
  const openFinding = (f: LocalFinding) => setOpen({ id: f.id, mode: f.conflict ? 'conflict' : 'edit' });

  const report = (r: BulkResult) => {
    const parts = [`עודכנו ${r.changed} ממצאים`];
    if (r.unchanged) parts.push(`${r.unchanged} כבר היו במצב הזה`);
    if (r.skipped) parts.push(`${r.skipped} דולגו כי הם בהתנגשות — פתור אותם קודם`);
    setMsg({ kind: r.skipped ? 'warn' : 'ok', text: `${parts.join(' · ')}. נשמר במכשיר; יסונכרן אוטומטית.` });
  };
  const bulk = async (patch: Partial<FindingData>) => {
    setMsg(null);
    try {
      report(await bulkUpdate(chosen, patch, tourId));
      setPending({});
      scheduleSync();
    } catch (e) {
      setMsg({ kind: 'error', text: `השינוי לא נשמר: ${(e as Error).message}` });
    }
  };
  const inline = async (f: LocalFinding, patch: Partial<FindingData>) => {
    clearTimeout(timers.current[f.id]);
    setRowState((r) => ({ ...r, [f.id]: { s: 'saving' } }));
    try {
      await updateFinding(f.id, patch, tourId);
      scheduleSync();
      setRowState((r) => ({ ...r, [f.id]: { s: 'saved' } }));
      timers.current[f.id] = setTimeout(
        () =>
          setRowState((r) => {
            const next = { ...r };
            delete next[f.id];
            return next;
          }),
        3000,
      );
    } catch (e) {
      setRowState((r) => ({ ...r, [f.id]: { s: 'error', message: (e as Error).message, patch } }));
    }
  };
  const exportXlsx = () => {
    const rows = chosen.length ? filtered.filter((f) => selected.has(f.id)) : filtered;
    const bytes = buildXlsx(findingsSheet(m, rows, tours));
    saveFile(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), exportFileName(m));
    setMsg({ kind: 'ok', text: `יוצאו ${rows.length} ממצאים לקובץ Excel` });
  };
  const setPendingField = (key: 'contractorId' | 'categoryId', value: string) => {
    const next = { ...pending };
    if (value) next[key] = value === NONE ? '' : value;
    else delete next[key];
    setPending(next);
  };

  const pendingText = [
    pending.status && `סטטוס ← ${STATUS_LABEL[pending.status]}`,
    pending.contractorId !== undefined && `קבלן ← ${pending.contractorId ? m.contractorById(pending.contractorId)?.name : 'ללא'}`,
    pending.categoryId !== undefined && `קטגוריה ← ${pending.categoryId ? m.categoryById(pending.categoryId)?.name : 'ללא'}`,
    pending.classification && `סיווג ← ${CLASSIFICATION_LABEL[pending.classification]}`,
  ].filter(Boolean);

  const stateCell = (f: LocalFinding) => {
    const r = rowState[f.id];
    if (r?.s === 'saving') return <span className="row-save" role="status">שומר…</span>;
    if (r?.s === 'error')
      return (
        <span className="row-save error" role="alert" title={r.message}>
          לא נשמר
          <button className="link" onClick={() => inline(f, r.patch)}>נסה שוב</button>
        </span>
      );
    return (
      <>
        {r?.s === 'saved' && <span className="row-save ok" role="status">נשמר במכשיר ✓</span>}
        {f.deletedAt && <span className="tag danger">נמחק</span>}
        <SyncTag f={f} />
      </>
    );
  };

  const contractorOptions = (f: LocalFinding) => (
    <>
      <option value="">ללא</option>
      {m.contractors.map((c) => (
        <option key={c.id} value={c.id}>{c.name}</option>
      ))}
      {f.contractorId && !m.contractors.some((c) => c.id === f.contractorId) && (
        <option value={f.contractorId}>{m.contractorById(f.contractorId)?.name ?? 'קבלן שהוסר'} (לא פעיל)</option>
      )}
    </>
  );

  const sortHead = (key: SortKey, className = '') => (
    <th key={key} className={className} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="ft-sort" onClick={() => sortBy(key)}>
        {SORT_LABEL[key]}
        <span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span>
      </button>
    </th>
  );

  const details =
    current && open.mode === 'edit' ? (
      <EditSheet key={current.id} m={m} f={current} tour={active} tours={tours} batchSize={batchOf(current)} onClose={() => setOpen(null)} />
    ) : current && open.mode === 'conflict' ? (
      <ConflictSheet m={m} f={current} tourId={tourId} onClose={() => setOpen(null)} />
    ) : null;

  return (
    <div className="ftable">
      <div className="ft-main">
        <FilterBar m={m} tours={tourList} q={q} setQ={setQ} filters={filters} setFilters={setFilters} deletedCount={deletedCount} wide={wide} onReset={reset} />

        <div className="ft-summary">
          <span className="ft-count" role="status">
            {filtered.length} ממצאים{filtered.length !== all.length ? ` (מתוך ${all.length})` : ''}
          </span>
          <span className="ft-tools">
            {!wide && (
              <select
                aria-label="מיון"
                value={`${sort.key}:${sort.dir}`}
                onChange={(e) => {
                  const [key, dir] = e.target.value.split(':');
                  setSort({ key: key as SortKey, dir: Number(dir) as 1 | -1 });
                }}
              >
                <option value="location:1">לפי סדר הסיור</option>
                <option value="no:1">מספר — עולה</option>
                <option value="no:-1">מספר — יורד</option>
                <option value="status:1">לפי סטטוס</option>
                <option value="contractor:1">לפי קבלן</option>
                <option value="classification:1">קריטיים ראשונים</option>
                <option value="updated:-1">עודכנו לאחרונה</option>
              </select>
            )}
            {wide && (
              <details className="ft-columns">
                <summary className="btn">עמודות</summary>
                <div className="ft-columns-menu" role="group" aria-label="עמודות בטבלה">
                  {OPTIONAL.map(([k, label]) => (
                    <Checkbox key={k} checked={cols.has(k)} onChange={() => toggleColumn(k)} label={label} />
                  ))}
                </div>
              </details>
            )}
            <button className="btn ft-export" disabled={!filtered.length} onClick={exportXlsx}>
              {chosen.length ? `ייצוא ${chosen.length} שנבחרו ל-Excel` : `ייצוא ${filtered.length} ל-Excel`}
            </button>
          </span>
        </div>

        {chosen.length > 0 && (
          <div className="ft-bulk" role="region" aria-label="עריכה מרובה">
            <div className="ft-bulk-head">
              <b>נבחרו {chosen.length}</b>
              <button className="link" onClick={() => (setSelected(new Set()), setPending({}), setConfirmDelete(false))}>
                בטל בחירה
              </button>
            </div>
            {readOnly ? (
              <span className="muted">צפייה בלבד — אין הרשאת עריכה</span>
            ) : (
              <>
                <div className="ft-bulk-fields">
                  <select
                    aria-label="שינוי סטטוס לנבחרים"
                    value={pending.status ?? ''}
                    onChange={(e) => setPending({ ...pending, status: (e.target.value || undefined) as FindingStatus | undefined })}
                  >
                    <option value="">סטטוס — ללא שינוי</option>
                    {Object.entries(STATUS_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                  <select
                    aria-label="שיוך קבלן לנבחרים"
                    value={pending.contractorId === undefined ? '' : pending.contractorId || NONE}
                    onChange={(e) => setPendingField('contractorId', e.target.value)}
                  >
                    <option value="">קבלן — ללא שינוי</option>
                    {m.contractors.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                    <option value={NONE}>ללא קבלן</option>
                  </select>
                  <select
                    aria-label="שינוי קטגוריה לנבחרים"
                    value={pending.categoryId === undefined ? '' : pending.categoryId || NONE}
                    onChange={(e) => setPendingField('categoryId', e.target.value)}
                  >
                    <option value="">קטגוריה — ללא שינוי</option>
                    {m.categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                    <option value={NONE}>ללא קטגוריה</option>
                  </select>
                  <select
                    aria-label="שינוי סיווג לנבחרים"
                    value={pending.classification ?? ''}
                    onChange={(e) => setPending({ ...pending, classification: (e.target.value || undefined) as Classification | undefined })}
                  >
                    <option value="">סיווג — ללא שינוי</option>
                    {Object.entries(CLASSIFICATION_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                {pendingText.length > 0 && (
                  <div className="ft-bulk-apply">
                    <span>
                      {pendingText.join(' · ')} — עבור {chosen.length} ממצאים. כל ממצא יקבל רישום בהיסטוריה.
                    </span>
                    <button className="btn primary-solid" onClick={() => bulk(pending)}>
                      החל על {chosen.length} ממצאים
                    </button>
                    <button className="btn" onClick={() => setPending({})}>
                      ביטול
                    </button>
                  </div>
                )}
                <div className="ft-bulk-more">
                  {filters.state !== 'active' && (
                    <button className="btn" onClick={() => bulk({ deletedAt: null })}>
                      שחזר נבחרים
                    </button>
                  )}
                  {filters.state !== 'deleted' &&
                    (confirmDelete ? (
                      <span className="ft-confirm">
                        למחוק {chosen.length} ממצאים? (ניתן לשחזר)
                        <button className="btn danger" onClick={() => (setConfirmDelete(false), bulk({ deletedAt: new Date().toISOString() }))}>
                          כן, מחק
                        </button>
                        <button className="btn" onClick={() => setConfirmDelete(false)}>
                          ביטול
                        </button>
                      </span>
                    ) : (
                      <button className="btn danger-outline" onClick={() => setConfirmDelete(true)}>
                        מחק נבחרים
                      </button>
                    ))}
                </div>
              </>
            )}
          </div>
        )}
        {msg && <div className={`alert ${msg.kind === 'ok' ? 'info' : msg.kind}`} role="status">{msg.text}</div>}
        {!active && !readOnly && <div className="muted ft-note">אין סיור פעיל — שינויים יירשמו בהיסטוריה מחוץ לסיור.</div>}

        {wide ? (
          <div className="ft-wrap" tabIndex={-1}>
            <table className="ft">
              <thead>
                <tr>
                  <th className="ft-check ft-sticky">
                    <Checkbox ariaLabel="בחר את כל הממצאים המסוננים" checked={allChosen} indeterminate={chosen.length > 0} onChange={selectAll} />
                  </th>
                  {sortHead('no', 'ft-sticky ft-sticky-2')}
                  {sortHead('location')}
                  {sortHead('description')}
                  {sortHead('contractor')}
                  {sortHead('status')}
                  {cols.has('classification') && sortHead('classification')}
                  {cols.has('category') && sortHead('category')}
                  {cols.has('tour') && sortHead('tour')}
                  {cols.has('updated') && sortHead('updated')}
                  {cols.has('photos') && <th>תמונות</th>}
                  <th>מצב</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((f) => {
                  const locked = readOnly || !!f.conflict || !!f.deletedAt;
                  const tour = f.tourId ? tours.get(f.tourId) : undefined;
                  return (
                    <tr
                      key={f.id}
                      data-id={f.id}
                      className={`${f.deletedAt ? 'is-deleted' : ''} cls-${f.classification} ${selected.has(f.id) ? 'on' : ''} ${open?.id === f.id ? 'open' : ''}`}
                    >
                      <td className="ft-check ft-sticky">
                        <Checkbox ariaLabel={`בחר ממצא ${f.displayNo ?? ''}`} checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
                      </td>
                      <td className="ft-no ft-sticky ft-sticky-2">
                        <button className="link" onClick={() => openFinding(f)}>
                          {f.displayNo ? `#${f.displayNo}` : 'חדש'}
                        </button>
                      </td>
                      <td className="ft-loc">
                        {m.locationLabel(f.locationId)}
                        {f.locationDetail && <div className="muted">{f.locationDetail}</div>}
                      </td>
                      <td className="ft-desc">
                        <button className="ft-open" onClick={() => openFinding(f)}>
                          {f.description}
                        </button>
                        {batchOf(f) > 1 && <span className="tag subtle">אחד מ-{batchOf(f)} מיקומים</span>}
                      </td>
                      <td>
                        <select aria-label={`קבלן לממצא ${f.displayNo ?? ''}`} value={f.contractorId} disabled={locked} onChange={(e) => inline(f, { contractorId: e.target.value })}>
                          {contractorOptions(f)}
                        </select>
                      </td>
                      <td>
                        <select
                          aria-label={`סטטוס לממצא ${f.displayNo ?? ''}`}
                          value={f.status}
                          disabled={locked}
                          onChange={(e) => inline(f, { status: e.target.value as FindingStatus })}
                        >
                          {Object.entries(STATUS_LABEL).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                          ))}
                        </select>
                      </td>
                      {cols.has('classification') && (
                        <td>
                          <select
                            aria-label={`סיווג לממצא ${f.displayNo ?? ''}`}
                            className={`cls-${f.classification}`}
                            value={f.classification}
                            disabled={locked}
                            onChange={(e) => inline(f, { classification: e.target.value as Classification })}
                          >
                            {Object.entries(CLASSIFICATION_LABEL).map(([k, v]) => (
                              <option key={k} value={k}>{v}</option>
                            ))}
                          </select>
                        </td>
                      )}
                      {cols.has('category') && <td>{m.categoryById(f.categoryId)?.name ?? '—'}</td>}
                      {cols.has('tour') && <td className="ft-nowrap">{tour ? tourLabel(tour as TourRow) : f.tourId ? 'סיור' : '—'}</td>}
                      {cols.has('updated') && <td className="ft-nowrap">{new Date(f.updatedAt).toLocaleDateString('he-IL')}</td>}
                      {cols.has('photos') && <td className="ft-num">{f.photoIds.length || ''}</td>}
                      <td className="ft-state">{stateCell(f)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            {filtered.length > 0 && (
              <Checkbox
                className="ft-selectall"
                ariaLabel="בחר את כל הממצאים המסוננים"
                checked={allChosen}
                indeterminate={chosen.length > 0}
                onChange={selectAll}
                label={chosen.length && !allChosen ? `נבחרו ${chosen.length} מתוך ${filtered.length} — בחירת כולם` : `בחירת כל ${filtered.length} המסוננים`}
              />
            )}
            <div className="list ft-cards">
              {shown.map((f) => (
                <div key={f.id} className={`card-row ${selected.has(f.id) ? 'on' : ''}`}>
                  <Checkbox className="card-check" ariaLabel={`בחר ממצא ${f.displayNo ?? ''}`} checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
                  <FindingCard m={m} f={f} batchSize={batchOf(f)} onOpen={() => openFinding(f)} />
                </div>
              ))}
            </div>
          </>
        )}
        {!filtered.length && (
          <div className="empty-state">
            <span>אין ממצאים שתואמים את החיפוש והמסננים.</span>
            {isFiltered(q, filters) && (
              <button className="btn" onClick={reset}>
                נקה חיפוש ומסננים
              </button>
            )}
          </div>
        )}
        {filtered.length > limit && (
          <button className="btn ft-more" onClick={() => setLimit(limit + PAGE)}>
            הצג עוד ({filtered.length - limit} נוספים)
          </button>
        )}
      </div>
      {details}
    </div>
  );
}
