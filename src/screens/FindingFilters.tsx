// Search and filters for findings. Wide screens: the filters inline. Narrow screens: search, a
// "מסננים (N)" button that opens the filters in a dialog (apply / reset), and removable chips (UX-01).
import { useState } from 'react';
import type { ProjectModel } from '../../shared/projectModel';
import { CLASSIFICATION_LABEL, STATUS_LABEL } from '../../shared/types';
import type { TourRow } from '../db';
import { activeCount, filterChips, NO_FILTERS, NONE, type Filters, type StateFilter } from '../findingFilters';
import { Icon } from '../icons';
import { Dialog } from './Dialog';
import { tourLabel } from './Tours';

function FilterSelects({ m, tours, value, onChange, deletedCount }: { m: ProjectModel; tours: TourRow[]; value: Filters; onChange: (f: Filters) => void; deletedCount: number }) {
  const set = (patch: Partial<Filters>) => onChange({ ...value, ...patch });
  const buildings = m.locations.filter((n) => !n.parentId);
  const floors = value.building ? m.locations.filter((n) => n.parentId === value.building && n.kind === 'floor') : [];
  const units = value.building ? m.locations.filter((n) => n.parentId === (value.floor || value.building) && n.kind !== 'floor') : [];
  const sel = (label: string, v: string, patch: (v: string) => Partial<Filters>, options: [string, string][], all: string, disabled = false) => (
    <label className="ff-field">
      <span>{label}</span>
      <select aria-label={label} value={v} disabled={disabled} onChange={(e) => set(patch(e.target.value))}>
        <option value="">{all}</option>
        {options.map(([k, l]) => (
          <option key={k} value={k}>{l}</option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      {sel('בניין', value.building, (v) => ({ building: v, floor: '', unit: '' }), buildings.map((b) => [b.id, b.name]), 'כל הבניינים')}
      {sel('קומה', value.floor, (v) => ({ floor: v, unit: '' }), floors.map((n) => [n.id, n.name]), 'כל הקומות', !floors.length)}
      {sel('דירה / חלל', value.unit, (v) => ({ unit: v }), units.map((n) => [n.id, n.name]), 'כל הדירות והחללים', !units.length)}
      {sel('קבלן', value.contractor, (v) => ({ contractor: v }), [...m.contractors.map((c): [string, string] => [c.id, c.name]), [NONE, 'ללא קבלן']], 'כל הקבלנים')}
      {sel('קטגוריה', value.category, (v) => ({ category: v }), [...m.categories.map((c): [string, string] => [c.id, c.name]), [NONE, 'ללא קטגוריה']], 'כל הקטגוריות')}
      {sel('סיווג', value.classification, (v) => ({ classification: v }), Object.entries(CLASSIFICATION_LABEL), 'כל הסיווגים')}
      {sel('סטטוס', value.status, (v) => ({ status: v }), Object.entries(STATUS_LABEL), 'כל הסטטוסים')}
      {sel(
        'סיור',
        value.tour,
        (v) => ({ tour: v }),
        [...[...tours].sort((a, b) => b.tour_date.localeCompare(a.tour_date)).map((t): [string, string] => [t.id, tourLabel(t)]), [NONE, 'לפני הגדרת סיורים']],
        'כל הסיורים',
      )}
      <label className="ff-field">
        <span>מצב</span>
        <select aria-label="מצב" value={value.state} onChange={(e) => set({ state: e.target.value as StateFilter })}>
          <option value="active">פעילים</option>
          <option value="deleted">נמחקו ({deletedCount})</option>
          <option value="all">הכול</option>
        </select>
      </label>
    </>
  );
}

export function FilterBar({
  m,
  tours,
  q,
  setQ,
  filters,
  setFilters,
  deletedCount,
  wide,
  onReset,
}: {
  m: ProjectModel;
  tours: TourRow[];
  q: string;
  setQ: (q: string) => void;
  filters: Filters;
  setFilters: (f: Filters) => void;
  deletedCount: number;
  wide: boolean;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Filters>(filters);
  const tourMap = new Map(tours.map((t) => [t.id, t]));
  const chips = filterChips(m, filters, tourMap, tourLabel);
  const n = activeCount(filters);
  return (
    <div className="ff">
      <div className="ff-top">
        <label className="ff-search">
          <Icon name="search" size={18} />
          <input type="search" value={q} aria-label="חיפוש ממצאים" placeholder="תיאור, מיקום, קבלן או #מספר" onChange={(e) => setQ(e.target.value)} />
        </label>
        {!wide && (
          <button
            className={`btn ff-open ${n ? 'on' : ''}`}
            aria-haspopup="dialog"
            onClick={() => {
              setDraft(filters);
              setOpen(true);
            }}
          >
            מסננים{n ? ` (${n})` : ''}
          </button>
        )}
      </div>
      {wide && (
        <div className="ft-filters">
          <FilterSelects m={m} tours={tours} value={filters} onChange={setFilters} deletedCount={deletedCount} />
        </div>
      )}
      {(chips.length > 0 || q.trim()) && (
        <div className="ff-chips" aria-label="מסננים פעילים">
          {chips.map((c) => (
            <button key={c.key} className="chip small ff-chip" aria-label={`הסר מסנן: ${c.label}`} onClick={() => setFilters(c.without)}>
              {c.label}
              <span aria-hidden="true">×</span>
            </button>
          ))}
          <button className="link" onClick={onReset}>
            נקה מסננים
          </button>
        </div>
      )}
      {open && (
        <Dialog
          title="מסננים"
          onClose={() => setOpen(false)}
          className="ff-sheet"
          footer={
            <>
              <button
                className="primary"
                onClick={() => {
                  setFilters(draft);
                  setOpen(false);
                }}
              >
                החל
              </button>
              <button className="btn" onClick={() => setDraft(NO_FILTERS)}>
                איפוס
              </button>
            </>
          }
        >
          <div className="ff-grid">
            <FilterSelects m={m} tours={tours} value={draft} onChange={setDraft} deletedCount={deletedCount} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
