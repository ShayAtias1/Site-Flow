// Tours (M4). Created and edited on the device — in the field, usually without a connection — and
// pushed by sync with optimistic locking. The tour in progress is remembered per project on the device.
import { useLiveQuery } from 'dexie-react-hooks';
import type { Participant, TourKind } from '../shared/types';
import { db, getMeta, setMeta, TOUR_FIELDS, type ProjectRow, type TourFields, type TourRow } from './db';
import type { Membership } from './setup';

const activeKey = (projectId: string) => `activeTour:${projectId}`;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const pickTour = (t: TourFields): TourFields => ({
  kind: t.kind,
  tour_date: t.tour_date,
  participants: t.participants ?? [],
  notes: t.notes ?? '',
  status: t.status,
});

export class TourError extends Error {}

/** Viewers cannot record tours; the role is known from the last sign-in that reached the server. */
async function assertCanWrite(orgId: string) {
  const role = (await getMeta<Membership[]>('memberships'))?.find((m) => m.orgId === orgId)?.role;
  if (role === 'viewer') throw new TourError('הרשאת צפייה בלבד — אין אפשרות לפתוח סיור.');
}

export function newTourDefaults(previous: TourRow[]): TourFields {
  return { kind: previous.length ? 'follow_up' : 'initial', tour_date: today(), participants: [], notes: '', status: 'active' };
}

export const cleanParticipants = (list: Participant[]) =>
  list.map((p) => ({ name: p.name.trim(), role: p.role.trim() })).filter((p) => p.name || p.role);

export async function createTour(project: ProjectRow, fields: Omit<TourFields, 'status'>): Promise<TourRow> {
  await assertCanWrite(project.org_id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.tour_date)) throw new TourError('יש לבחור תאריך סיור');
  const tour: TourRow = {
    id: crypto.randomUUID(),
    org_id: project.org_id,
    project_id: project.id,
    ...fields,
    participants: cleanParticipants(fields.participants),
    notes: fields.notes.trim(),
    status: 'active',
    scope_location_ids: [],
    version: 0,
    seq: 0,
    deleted_at: null,
    created_at: new Date().toISOString(),
    dirty: 1,
    rev: 1,
    base: null,
  };
  await db.tours.add(tour);
  await setActiveTour(project.id, tour.id);
  return tour;
}

export async function updateTour(id: string, patch: Partial<TourFields>) {
  await db.transaction('rw', db.tours, async () => {
    const cur = await db.tours.get(id);
    if (!cur) throw new TourError('הסיור לא נמצא');
    const next = { ...patch, ...(patch.participants ? { participants: cleanParticipants(patch.participants) } : {}) };
    await db.tours.update(id, { ...next, dirty: 1, rev: (cur.rev ?? 0) + 1, syncError: null });
  });
}

/** Closing a tour ends it on every device; it stays in the list, with its findings and history. */
export async function closeTour(tour: TourRow) {
  await updateTour(tour.id, { status: 'closed' });
  if ((await getMeta<string>(activeKey(tour.project_id))) === tour.id) await setMeta(activeKey(tour.project_id), null);
}

export async function reopenTour(tour: TourRow) {
  await updateTour(tour.id, { status: 'active' });
  await setActiveTour(tour.project_id, tour.id);
}

export const setActiveTour = (projectId: string, id: string | null) => setMeta(activeKey(projectId), id);

/** The tour this device is working in for the project (open, not deleted), or null. undefined while loading. */
export function useActiveTour(projectId: string | undefined) {
  return useLiveQuery(async () => {
    if (!projectId) return null;
    const id = await getMeta<string | null>(activeKey(projectId));
    const t = id ? await db.tours.get(id) : undefined;
    return t && !t.deleted_at && t.status === 'active' ? t : null;
  }, [projectId]);
}

export async function activeTourId(projectId: string) {
  const id = await getMeta<string | null>(activeKey(projectId));
  const t = id ? await db.tours.get(id) : undefined;
  return t && !t.deleted_at && t.status === 'active' ? t.id : null;
}

/** All tours of a project, newest first. */
export function useTours(projectId: string | undefined) {
  return useLiveQuery(async () => {
    if (!projectId) return [];
    const list = (await db.tours.where('project_id').equals(projectId).toArray()).filter((t) => !t.deleted_at);
    return list.sort((a, b) => b.tour_date.localeCompare(a.tour_date) || (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  }, [projectId]);
}

// ---------- Merge used by sync ----------

const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A newer server copy of a tour this device also edited: fields edited here keep the device's value,
 * the rest take the server's. (Tours are edited rarely; a field edited on both sides keeps this
 * device's value, which is then pushed as a new version.)
 */
export function mergeTour(local: TourRow, server: TourRow): Partial<TourRow> {
  const merged: Partial<TourFields> = {};
  let localChanges = false;
  for (const f of TOUR_FIELDS) {
    const mine = !local.base || !eq(local[f], local.base[f]);
    (merged as Record<string, unknown>)[f] = mine ? local[f] : server[f];
    if (mine && !eq(local[f], server[f])) localChanges = true;
  }
  return { ...merged, version: server.version, seq: server.seq, base: pickTour(server), dirty: localChanges ? 1 : 0 };
}

export type { TourKind };
