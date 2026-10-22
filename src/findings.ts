import { pickData, threeWayMerge } from '../shared/merge';
import type { FindingData, FindingEventType, ServerFinding } from '../shared/types';
import { lastUser } from './auth';
import { db, type CaptureDraft, type EventRow, type LocalFinding } from './db';
import { noteFindingCount } from './storage';

export const DEBUG_FAIL_WRITES = 'sf.debug.failWrites';

/** Lets the acceptance tests exercise the write-failure path without filling the disk (test builds only). */
function maybeSimulateFailure() {
  // Test builds only (VITE_TEST_HOOKS=1): never reachable in the app users run.
  if (import.meta.env.VITE_TEST_HOOKS === '1' && localStorage.getItem(DEBUG_FAIL_WRITES) === '1')
    throw new DOMException('Simulated: storage quota exceeded', 'QuotaExceededError');
}

export class SaveError extends Error {
  constructor(
    readonly cause: unknown,
    readonly kind: 'quota' | 'other',
  ) {
    super(kind === 'quota' ? 'אין מספיק מקום אחסון במכשיר' : `השמירה נכשלה: ${(cause as Error)?.message ?? cause}`);
  }
}

function classify(e: unknown) {
  const name = (e as { name?: string; inner?: { name?: string } })?.inner?.name ?? (e as { name?: string })?.name;
  return new SaveError(e, name === 'QuotaExceededError' ? 'quota' : 'other');
}

// ---------- History ----------

/** Field names in events are the database's, so history reads the same from every device and the server. */
const EVENT_FIELD: Partial<Record<keyof FindingData, string>> = {
  description: 'description',
  locationId: 'location_id',
  locationDetail: 'location_detail',
  categoryId: 'category_id',
  contractorId: 'contractor_id',
  classification: 'classification',
  photoIds: 'photo_ids',
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const orNull = (v: unknown) => (v === '' ? null : v);

function event(findingId: string, tourId: string | null, type: FindingEventType, from: EventRow['from'], to: EventRow['to'], note = ''): EventRow {
  return { id: crypto.randomUUID(), findingId, tourId, at: new Date().toISOString(), type, from, to, note, actorId: lastUser()?.id ?? null, pending: 1 };
}

/** The events one edit produces: deletion/restore, status, and one entry for all other changed fields. */
export function diffEvents(id: string, before: FindingData, after: FindingData, tourId: string | null): EventRow[] {
  const out: EventRow[] = [];
  if (!before.deletedAt && after.deletedAt) out.push(event(id, tourId, 'deleted', null, null));
  if (before.deletedAt && !after.deletedAt) out.push(event(id, tourId, 'restored', null, null));
  if (before.status !== after.status) out.push(event(id, tourId, 'status_changed', { status: before.status }, { status: after.status }));
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(EVENT_FIELD) as [keyof FindingData, string][]) {
    if (!same(before[k], after[k])) {
      from[col] = orNull(before[k]);
      to[col] = orNull(after[k]);
    }
  }
  if (Object.keys(to).length) out.push(event(id, tourId, 'field_changed', from, to));
  return out;
}

export const draftKey = (projectId: string) => `capture:${projectId}`;

/**
 * Saves the capture draft in one transaction (findings + photos + history + draft cleared), then reads
 * the findings back. Only a successful read-back counts as saved. A draft with several locations
 * becomes one finding per location — each with its own id, status and history — sharing a batch id.
 * Photos taken with the draft belong to the first finding and are shown on all of them.
 */
export async function saveNewFinding(draft: CaptureDraft, projectId: string, tourId: string | null): Promise<LocalFinding[]> {
  const now = new Date().toISOString();
  const locations = [...new Set([draft.locationId, ...(draft.extraLocationIds ?? [])])];
  const batchId = locations.length > 1 ? crypto.randomUUID() : null;
  const findings: LocalFinding[] = locations.map((locationId) => ({
    id: crypto.randomUUID(),
    projectId,
    tourId,
    batchId,
    locationId,
    locationDetail: draft.locationDetail.trim(),
    categoryId: draft.categoryId,
    contractorId: draft.contractorId,
    classification: draft.classification,
    description: draft.description.trim(),
    status: 'open',
    photoIds: draft.photoIds,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    displayNo: null,
    version: 0,
    base: null,
    dirty: 1,
    rev: 1,
    conflict: null,
  }));
  try {
    await db.transaction('rw', [db.findings, db.photos, db.drafts, db.events], async () => {
      maybeSimulateFailure();
      await db.findings.bulkAdd(findings);
      await db.events.bulkAdd(findings.map((f) => event(f.id, tourId, 'created', null, { status: 'open', tour_id: tourId, ...(batchId ? { batch_id: batchId } : {}) })));
      for (const pid of draft.photoIds) await db.photos.update(pid, { findingId: findings[0].id, kind: 'initial' });
      await db.drafts.update(draftKey(projectId), {
        'data.description': '',
        'data.locationDetail': '',
        'data.photoIds': [],
        'data.extraLocationIds': [],
        'data.classification': 'missing',
        updatedAt: now,
      });
    });
  } catch (e) {
    throw classify(e);
  }
  const check = await db.findings.bulkGet(findings.map((f) => f.id));
  if (check.some((f) => !f)) throw new SaveError(new Error('read-back failed'), 'other');
  noteFindingCount();
  return check as LocalFinding[];
}

/**
 * Adds photos to an existing finding (e.g. on a follow-up tour). Existing photos are left as they are;
 * each addition is recorded in the history with the tour it was taken in.
 */
export async function attachPhotos(id: string, photoIds: string[], tourId: string | null) {
  try {
    await db.transaction('rw', db.findings, db.photos, db.events, async () => {
      maybeSimulateFailure();
      const cur = await db.findings.get(id);
      if (!cur) throw new Error('not found');
      if (cur.conflict) throw new Error('יש לפתור את ההתנגשות לפני הוספת תמונות');
      const added = photoIds.filter((p) => !cur.photoIds.includes(p));
      if (!added.length) return;
      for (const pid of added) await db.photos.update(pid, { findingId: id, kind: 'progress' });
      await db.findings.update(id, { photoIds: [...cur.photoIds, ...added], dirty: 1, rev: cur.rev + 1, syncError: null, updatedAt: new Date().toISOString() });
      await db.events.bulkAdd(added.map((pid) => event(id, tourId, 'photo_added', null, { photo_id: pid })));
    });
  } catch (e) {
    throw classify(e);
  }
}

/** `tourId`: the tour the edit is made in (recorded in the history), or null outside a tour. */
export async function updateFinding(id: string, patch: Partial<FindingData>, tourId: string | null) {
  try {
    await db.transaction('rw', db.findings, db.events, async () => {
      maybeSimulateFailure();
      const cur = await db.findings.get(id);
      if (!cur) throw new Error('not found');
      if (cur.conflict) throw new Error('יש לפתור את ההתנגשות לפני עריכה');
      const events = diffEvents(id, pickData(cur), { ...pickData(cur), ...patch }, tourId);
      if (!events.length) return;
      // An edit is a new attempt: a record the server rejected becomes eligible to send again.
      await db.findings.update(id, { ...patch, dirty: 1, rev: cur.rev + 1, syncError: null, updatedAt: new Date().toISOString() });
      await db.events.bulkAdd(events);
    });
  } catch (e) {
    throw classify(e);
  }
}

export interface BulkResult {
  changed: number;
  unchanged: number;
  /** In conflict: left untouched until the conflict is resolved. */
  skipped: number;
}

/**
 * The same change to many findings, in one transaction. Each finding gets its own history events, as
 * if edited one by one. Every edit keeps the version it was based on, so the server's optimistic lock
 * and the three-way merge apply to each one: a field someone else changed meanwhile becomes a conflict
 * for the user to decide — a bulk edit never overwrites it silently.
 */
export async function bulkUpdate(ids: string[], patch: Partial<FindingData>, tourId: string | null): Promise<BulkResult> {
  const result: BulkResult = { changed: 0, unchanged: 0, skipped: 0 };
  try {
    await db.transaction('rw', db.findings, db.events, async () => {
      maybeSimulateFailure();
      const rows = await db.findings.bulkGet(ids);
      const now = new Date().toISOString();
      const events: EventRow[] = [];
      for (const cur of rows) {
        if (!cur) continue;
        if (cur.conflict) {
          result.skipped++;
          continue;
        }
        const ev = diffEvents(cur.id, pickData(cur), { ...pickData(cur), ...patch }, tourId);
        if (!ev.length) {
          result.unchanged++;
          continue;
        }
        events.push(...ev);
        await db.findings.update(cur.id, { ...patch, dirty: 1, rev: cur.rev + 1, syncError: null, updatedAt: now });
        result.changed++;
      }
      await db.events.bulkAdd(events);
    });
  } catch (e) {
    throw classify(e);
  }
  return result;
}

export function fromServer(row: ServerFinding): LocalFinding {
  return {
    ...pickData(row),
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    displayNo: row.displayNo,
    version: row.version,
    base: pickData(row),
    dirty: 0,
    rev: 0,
    conflict: null,
    syncError: null,
  };
}

export const MAX_SYNC_ATTEMPTS = 3;

/** Counts one server rejection; blocks the record once it has been refused MAX_SYNC_ATTEMPTS times. */
export async function recordRejection(id: string, message: string) {
  await db.transaction('rw', db.findings, async () => {
    const cur = await db.findings.get(id);
    if (!cur) return;
    const attempts = (cur.syncError?.attempts ?? 0) + 1;
    await db.findings.update(id, {
      syncError: { message, attempts, blocked: attempts >= MAX_SYNC_ATTEMPTS, at: new Date().toISOString() },
    });
  });
}

/**
 * The server has a newer version than this local copy. A clean copy is replaced;
 * a dirty copy is three-way merged. Fields edited differently on both sides become
 * a conflict that waits for the user — nothing is overwritten silently.
 * Returns true when the local copy needs another push.
 */
export async function applyRemoteNewer(row: ServerFinding): Promise<boolean> {
  return db.transaction('rw', db.findings, async () => {
    const local = await db.findings.get(row.id);
    if (!local || !local.dirty) {
      await db.findings.put(fromServer(row));
      return false;
    }
    if (row.version <= local.version) return false;
    const { merged, conflicts } = threeWayMerge(local.base, pickData(local), pickData(row));
    if (conflicts.length === 0) {
      await db.findings.update(row.id, {
        ...merged,
        version: row.version,
        base: pickData(row),
        displayNo: row.displayNo,
        dirty: 1,
        rev: local.rev + 1,
        conflict: null,
      });
      return true;
    }
    await db.findings.update(row.id, { displayNo: row.displayNo, conflict: { server: row, fields: conflicts } });
    return false;
  });
}

export async function resolveConflict(id: string, choice: Partial<Record<keyof FindingData, 'mine' | 'theirs'>>, tourId: string | null) {
  await db.transaction('rw', db.findings, db.events, async () => {
    const local = await db.findings.get(id);
    if (!local?.conflict) return;
    const server = local.conflict.server;
    const { merged } = threeWayMerge(local.base, pickData(local), pickData(server));
    const out = merged as unknown as Record<string, unknown>;
    for (const f of local.conflict.fields) if (choice[f] === 'theirs') out[f] = server[f];
    const decided = local.conflict.fields.map((f) => `${EVENT_FIELD[f] ?? f}: ${choice[f] === 'theirs' ? 'מהשרת' : 'מהמכשיר'}`).join(', ');
    await db.events.add(event(id, tourId, 'comment', null, null, `התנגשות נפתרה (${decided})`));
    await db.findings.update(id, {
      ...merged,
      version: server.version,
      base: pickData(server),
      displayNo: server.displayNo,
      conflict: null,
      syncError: null,
      dirty: 1,
      rev: local.rev + 1,
      updatedAt: new Date().toISOString(),
    });
  });
}
