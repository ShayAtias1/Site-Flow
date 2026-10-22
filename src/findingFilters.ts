// Search and filters shared by the findings list and the management table (UX-08). Kept per project
// for the browser session, so switching views or opening a finding never loses them.
import { useEffect, useMemo, useState } from 'react';
import type { ProjectModel } from '../shared/projectModel';
import { CLASSIFICATION_LABEL, STATUS_LABEL, type Classification, type FindingStatus } from '../shared/types';
import type { LocalFinding, TourRow } from './db';

export type StateFilter = 'active' | 'deleted' | 'all';

export interface Filters {
  building: string;
  floor: string;
  unit: string;
  contractor: string;
  category: string;
  classification: string;
  status: string;
  tour: string;
  state: StateFilter;
}

export const NO_FILTERS: Filters = { building: '', floor: '', unit: '', contractor: '', category: '', classification: '', status: '', tour: '', state: 'active' };
/** "No contractor" / "no category" / "before tours". */
export const NONE = '__none';

const key = (projectId: string) => `sf.findingFilters:${projectId}`;

export function useFindingFilters(projectId: string) {
  const read = () => {
    try {
      const v = JSON.parse(sessionStorage.getItem(key(projectId)) ?? 'null');
      return v ? { q: String(v.q ?? ''), filters: { ...NO_FILTERS, ...v.filters } as Filters } : { q: '', filters: NO_FILTERS };
    } catch {
      return { q: '', filters: NO_FILTERS };
    }
  };
  const [state, setState] = useState(read);
  useEffect(() => setState(read()), [projectId]);
  useEffect(() => {
    try {
      sessionStorage.setItem(key(projectId), JSON.stringify(state));
    } catch {
      /* per-tab convenience only */
    }
  }, [state, projectId]);
  return {
    q: state.q,
    filters: state.filters,
    setQ: (q: string) => setState((s) => ({ ...s, q })),
    setFilters: (filters: Filters) => setState((s) => ({ ...s, filters })),
    reset: () => setState({ q: '', filters: NO_FILTERS }),
  };
}

/** Narrow screens show cards and a filter sheet; wide ones the table and inline filters. */
export function useWide(minWidth = 900) {
  const query = `(min-width: ${minWidth}px)`;
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? true);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return wide;
}

/** Filters other than the deleted/active state, counted for the "מסננים (N)" button. */
export const activeCount = (f: Filters) =>
  (['building', 'floor', 'unit', 'contractor', 'category', 'classification', 'status', 'tour'] as const).filter((k) => f[k]).length + (f.state !== 'active' ? 1 : 0);

export const isFiltered = (q: string, f: Filters) => q.trim() !== '' || activeCount(f) > 0;

/** Each active filter as a removable chip: what it shows, and the filters without it. */
export function filterChips(m: ProjectModel, f: Filters, tours: Map<string, TourRow>, tourName: (t: TourRow) => string) {
  const chips: { key: string; label: string; without: Filters }[] = [];
  const add = (k: keyof Filters, label: string, without: Partial<Filters>) => chips.push({ key: k, label, without: { ...f, ...without } });
  if (f.building) add('building', m.locationById(f.building)?.name ?? '—', { building: '', floor: '', unit: '' });
  if (f.floor) add('floor', m.locationById(f.floor)?.name ?? '—', { floor: '', unit: '' });
  if (f.unit) add('unit', m.locationById(f.unit)?.name ?? '—', { unit: '' });
  if (f.contractor) add('contractor', f.contractor === NONE ? 'ללא קבלן' : `קבלן: ${m.contractorById(f.contractor)?.name ?? '—'}`, { contractor: '' });
  if (f.category) add('category', f.category === NONE ? 'ללא קטגוריה' : m.categoryById(f.category)?.name ?? '—', { category: '' });
  if (f.classification) add('classification', CLASSIFICATION_LABEL[f.classification as Classification], { classification: '' });
  if (f.status) add('status', STATUS_LABEL[f.status as FindingStatus], { status: '' });
  if (f.tour) add('tour', f.tour === NONE ? 'לפני הגדרת סיורים' : tours.get(f.tour) ? tourName(tours.get(f.tour)!) : 'סיור', { tour: '' });
  if (f.state !== 'active') add('state', f.state === 'deleted' ? 'נמחקו' : 'כולל נמחקים', { state: 'active' });
  return chips;
}

/** Text each finding is searched by. */
export function useHaystack(all: LocalFinding[] | undefined, m: ProjectModel) {
  return useMemo(() => {
    const out = new Map<string, string>();
    for (const f of all ?? [])
      out.set(
        f.id,
        [
          f.displayNo ? String(f.displayNo) : '',
          f.description,
          m.locationLabel(f.locationId),
          m.locationById(f.locationId)?.code ?? '',
          f.locationDetail,
          m.contractorById(f.contractorId)?.name ?? '',
          m.categoryById(f.categoryId)?.name ?? '',
        ]
          .join(' ')
          .toLowerCase(),
      );
    return out;
  }, [all, m]);
}

export function applyFilters(all: LocalFinding[], q: string, f: Filters, m: ProjectModel, haystack: Map<string, string>) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const area = f.unit || f.floor || f.building;
  return all.filter((x) => {
    if (f.state === 'active' && x.deletedAt) return false;
    if (f.state === 'deleted' && !x.deletedAt) return false;
    if (area && !m.isWithin(x.locationId, area)) return false;
    if (f.contractor && (f.contractor === NONE ? !!x.contractorId : x.contractorId !== f.contractor)) return false;
    if (f.category && (f.category === NONE ? !!x.categoryId : x.categoryId !== f.category)) return false;
    if (f.classification && x.classification !== f.classification) return false;
    if (f.status && x.status !== f.status) return false;
    if (f.tour && (f.tour === NONE ? !!x.tourId : x.tourId !== f.tour)) return false;
    if (words.length) {
      const h = haystack.get(x.id) ?? '';
      // "#12" is a finding number: exact, so it does not also match #120.
      if (!words.every((w) => (/^#\d+$/.test(w) ? x.displayNo === Number(w.slice(1)) : h.includes(w)))) return false;
    }
    return true;
  });
}
