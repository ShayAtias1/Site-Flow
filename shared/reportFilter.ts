// Which findings a report includes, in which order, and how its filters read in words.
// Shared by the report service (what is issued) and the app (the count shown before issuing).
import type { ProjectModel } from './projectModel';
import {
  ALL_STATUSES,
  DEFAULT_TITLE,
  STATUS_LABEL,
  legacyOptions,
  type Classification,
  type FindingStatus,
  type ReportFormat,
  type ReportGrouping,
  type ReportOptions,
  type ReportScope,
} from './types';

export interface Selectable {
  locationId: string;
  contractorId: string;
  classification: Classification;
  status: FindingStatus;
  tourId: string | null;
  deletedAt: string | null;
  displayNo: number | null;
}

/** Marks "recorded before tours existed" in a tour filter. */
export const NO_TOUR = 'none';

export function selectFindings<T extends Selectable>(m: ProjectModel, findings: T[], o: ReportOptions): T[] {
  const statuses = new Set(o.statuses);
  const tours = o.tourIds ? new Set(o.tourIds) : null;
  const walk = new Map(m.walkOrder.map((n, i) => [n.id, i]));
  const contractorName = (id: string) => m.contractorById(id)?.name ?? '￿';
  const out = findings.filter((f) => {
    if (f.deletedAt || !statuses.has(f.status)) return false;
    if (o.criticalOnly && f.classification !== 'critical') return false;
    if (o.contractorId && f.contractorId !== o.contractorId) return false;
    if (tours && !tours.has(f.tourId ?? NO_TOUR)) return false;
    if (o.scope.type === 'location') return m.isWithin(f.locationId, o.scope.locationId);
    if (o.scope.type === 'contractor') return f.contractorId === o.scope.contractorId;
    return true;
  });
  const byWalk = (a: T, b: T) => (walk.get(a.locationId) ?? 1e9) - (walk.get(b.locationId) ?? 1e9) || (a.displayNo ?? 0) - (b.displayNo ?? 0);
  return out.sort(
    o.grouping === 'contractor' ? (a, b) => contractorName(a.contractorId).localeCompare(contractorName(b.contractorId), 'he') || byWalk(a, b) : byWalk,
  );
}

/** The unit's surroundings, e.g. "בניין A › קומה 2" — the group heading when grouping by location. */
export function areaOf(m: ProjectModel, locationId: string) {
  const path = m.locationPath(locationId);
  return (path.length > 1 ? path.slice(0, -1) : path).map((n) => n.name).join(' › ') || '—';
}

export function scopeLabel(m: ProjectModel, o: ReportOptions) {
  const s = o.scope;
  const area = s.type === 'location' ? m.locationLabel(s.locationId) : 'כל הפרויקט';
  const contractorId = s.type === 'contractor' ? s.contractorId : o.contractorId;
  const contractor = contractorId ? ` · קבלן: ${m.contractorById(contractorId)?.name ?? '—'}` : '';
  return `היקף: ${area}${contractor}`;
}

export function filterLabel(o: ReportOptions, tourName: (id: string) => string) {
  const parts: string[] = [];
  parts.push(
    o.statuses.length === ALL_STATUSES.length ? 'כל הסטטוסים' : `סטטוס: ${o.statuses.map((s) => STATUS_LABEL[s]).join(', ')}`,
  );
  if (o.tourIds) parts.push(`סיורים: ${o.tourIds.map((t) => (t === NO_TOUR ? 'לפני הגדרת סיורים' : tourName(t))).join(', ')}`);
  if (o.criticalOnly) parts.push('ליקויים קריטיים בלבד');
  return parts.join(' · ');
}

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const GROUPINGS: ReportGrouping[] = ['location', 'contractor', 'none'];

/** Server side: a request's options, checked field by field. Anything malformed falls back to a safe default. */
export function normalizeOptions(raw: unknown, scope: ReportScope, format: ReportFormat): ReportOptions {
  const base = legacyOptions(scope);
  if (!raw || typeof raw !== 'object') return { ...base, grouping: 'location', title: DEFAULT_TITLE[format] };
  const r = raw as Record<string, unknown>;
  const statuses = Array.isArray(r.statuses) ? ALL_STATUSES.filter((s) => (r.statuses as unknown[]).includes(s)) : ALL_STATUSES;
  const tourIds = Array.isArray(r.tourIds) ? (r.tourIds as unknown[]).filter((t): t is string => isUuid(t) || t === NO_TOUR).slice(0, 200) : null;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    scope,
    contractorId: isUuid(r.contractorId) ? r.contractorId : null,
    statuses: statuses.length ? statuses : ALL_STATUSES,
    tourIds: tourIds && tourIds.length ? tourIds : null,
    criticalOnly: r.criticalOnly === true,
    grouping: GROUPINGS.includes(r.grouping as ReportGrouping) ? (r.grouping as ReportGrouping) : 'location',
    title: text(r.title, 160) || DEFAULT_TITLE[format],
    notes: text(r.notes, 4000),
    headerTourId: isUuid(r.headerTourId) ? r.headerTourId : null,
  };
}

/** Checks a scope from a request; unknown shapes are refused rather than widened to the whole project. */
export function parseScope(raw: unknown): ReportScope | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.type === 'project') return { type: 'project' };
  if (r.type === 'location' && isUuid(r.locationId)) return { type: 'location', locationId: r.locationId };
  if (r.type === 'contractor' && isUuid(r.contractorId)) return { type: 'contractor', contractorId: r.contractorId };
  return null;
}
