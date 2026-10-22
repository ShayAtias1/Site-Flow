import { pickData } from '../shared/merge';
import type { PushChange } from '../shared/types';
import { db, getMeta, REFERENCE_TABLES, setMeta, type TourRow } from './db';
import { applyRemoteNewer, fromServer, recordRejection } from './findings';
import { pullEvents, pullFindings, pullReference, pushFindings, pushTour, uploadPhoto } from './remote';
import { mergeTour, pickTour } from './tours';

export interface SyncOutcome {
  ok: boolean;
  pushed: number;
  pulled: number;
  photos: number;
  conflicts: number;
  autoMerged: number;
  /** Records the server refused; they stay pending on the device. */
  rejected: string[];
  /** Photos that could not be uploaded this time; they stay pending and are retried. */
  photoErrors: string[];
  error?: string;
  at: string;
}

type Listener = (state: { running: boolean; last?: SyncOutcome }) => void;
const listeners = new Set<Listener>();
let running: Promise<SyncOutcome> | null = null;
let last: SyncOutcome | undefined;

export function onSyncState(l: Listener) {
  listeners.add(l);
  l({ running: !!running, last });
  return () => listeners.delete(l);
}
const emit = () => listeners.forEach((l) => l({ running: !!running, last }));

/** Setup data (projects, locations, categories, contractors…) — mirrored from the server. */
async function pullSetup() {
  for (const table of REFERENCE_TABLES) {
    let since = (await getMeta<number>(`pull:${table}`)) ?? 0;
    for (;;) {
      const { rows, cursor } = await pullReference(table, since);
      if (rows.length === 0) break;
      await db.table(table).bulkPut(rows);
      since = cursor;
      await setMeta(`pull:${table}`, since);
    }
  }
}

/** A server copy of a tour, as stored on the device. */
const clean = (row: TourRow): TourRow => ({ ...row, dirty: 0, rev: 0, base: pickTour(row), syncError: null });

/** Tours go up before findings: a finding names the tour it was recorded in. */
async function pushTours(out: SyncOutcome) {
  let again = false;
  for (const t of await db.tours.where('dirty').equals(1).toArray()) {
    const r = await pushTour(t);
    await db.transaction('rw', db.tours, async () => {
      const cur = await db.tours.get(t.id);
      if (!cur) return;
      if (r.status === 'ok') {
        // An edit made while this push was in flight stays pending.
        await db.tours.put(cur.rev === t.rev ? clean(r.row) : { ...cur, version: r.row.version, seq: r.row.seq, base: pickTour(r.row) });
      } else if (r.status === 'stale') {
        await db.tours.update(t.id, mergeTour(cur, r.row));
        again = true;
      } else {
        await db.tours.update(t.id, { syncError: r.error });
        out.rejected.push(`סיור ${t.tour_date}: ${r.error}`);
      }
    });
  }
  return again;
}

async function pullTours() {
  let since = (await getMeta<number>('pull:tours')) ?? 0;
  for (;;) {
    const { rows, cursor } = await pullReference('tours', since);
    if (!rows.length) break;
    for (const row of rows as unknown as TourRow[]) {
      await db.transaction('rw', db.tours, async () => {
        const local = await db.tours.get(row.id);
        if (!local || !local.dirty) await db.tours.put(clean(row));
        else if (row.version > local.version) await db.tours.update(row.id, mergeTour(local, row));
      });
    }
    since = cursor;
    await setMeta('pull:tours', since);
  }
}

/** History from every device. Events recorded here are already on the device. */
async function pullHistory() {
  let since = (await getMeta<number>('pull:events')) ?? 0;
  for (;;) {
    const { rows, cursor } = await pullEvents(since);
    if (!rows.length) break;
    await db.events.bulkPut(rows);
    since = cursor;
    await setMeta('pull:events', since);
  }
}

/**
 * Photos go up after their finding exists on the server (the photo row references it).
 * A photo that fails stays pending and is retried next sync; it never stops the others or the pull.
 */
async function uploadPhotos(out: SyncOutcome) {
  let n = 0;
  const pending = await db.photos.where('uploaded').equals(0).toArray();
  for (const p of pending) {
    if (!p.findingId) continue; // still attached to an unsaved draft
    const finding = await db.findings.get(p.findingId);
    if (!finding || finding.version === 0) continue; // finding not on the server yet
    try {
      if (await uploadPhoto(p, finding.projectId)) {
        await db.photos.update(p.id, { uploaded: 1, uploadedAt: new Date().toISOString() });
        n++;
      }
    } catch (e) {
      out.photoErrors.push((e as Error).message);
    }
  }
  return n;
}

/** `rejectedThisRun`: a record refused once is not resent in the same sync, so each sync is one attempt. */
async function push(out: SyncOutcome, rejectedThisRun: Set<string>) {
  const dirty = (await db.findings.where('dirty').equals(1).toArray()).filter(
    (f) => !f.conflict && !f.syncError?.blocked && !rejectedThisRun.has(f.id),
  );
  let again = false;
  for (let i = 0; i < dirty.length; i += 50) {
    const batch = dirty.slice(i, i + 50);
    const sentRev = new Map(batch.map((f) => [f.id, f.rev]));
    // Each finding carries the history recorded with its edits; the server stores it with the change.
    const sentEvents = new Map<string, string[]>();
    const changes: PushChange[] = [];
    for (const f of batch) {
      const events = (await db.events.where('findingId').equals(f.id).filter((e) => e.pending === 1).toArray()).sort((a, b) => a.at.localeCompare(b.at));
      sentEvents.set(f.id, events.map((e) => e.id));
      changes.push({
        id: f.id,
        baseVersion: f.version,
        createdAt: f.createdAt,
        data: pickData(f),
        // Without events (edits made before M4) the server derives the history itself.
        ...(events.length ? { events: events.map(({ id, type, at, tourId, from, to, note }) => ({ id, type, at, tourId, from, to, note })) } : {}),
      });
    }
    const results = await pushFindings(changes);
    for (const r of results) {
      if (r.status === 'ok') {
        await db.transaction('rw', db.findings, db.events, async () => {
          for (const id of sentEvents.get(r.id) ?? []) await db.events.update(id, { pending: 0 });
          const cur = await db.findings.get(r.id);
          if (!cur) return;
          const unchanged = cur.rev === sentRev.get(r.id);
          await db.findings.update(r.id, {
            version: r.row.version,
            displayNo: r.row.displayNo,
            base: pickData(r.row),
            syncError: null,
            ...(unchanged ? { dirty: 0 as const } : {}),
          });
        });
        out.pushed++;
      } else if (r.status === 'error') {
        // The record stays on the device and is retried on a later sync, up to MAX_SYNC_ATTEMPTS.
        rejectedThisRun.add(r.id);
        await recordRejection(r.id, r.error);
        out.rejected.push(`${r.id.slice(0, 8)}: ${r.error}`);
      } else if (await applyRemoteNewer(r.row)) {
        out.autoMerged++;
        again = true;
      }
    }
  }
  return again;
}

async function pull(out: SyncOutcome) {
  let again = false;
  let since = (await getMeta<number>('pullCursor')) ?? 0;
  for (;;) {
    const { rows, cursor } = await pullFindings(since);
    if (rows.length === 0) break;
    for (const row of rows) {
      const local = await db.findings.get(row.id);
      if (!local) await db.findings.put(fromServer(row));
      else if (row.version > local.version && (await applyRemoteNewer(row))) {
        out.autoMerged++;
        again = true;
      }
      out.pulled++;
    }
    since = cursor;
    await setMeta('pullCursor', since);
  }
  return again;
}

async function run(): Promise<SyncOutcome> {
  const out: SyncOutcome = { ok: false, pushed: 0, pulled: 0, photos: 0, conflicts: 0, autoMerged: 0, rejected: [], photoErrors: [], at: new Date().toISOString() };
  try {
    await pullSetup();
    const rejectedThisRun = new Set<string>();
    // A merge produces a new local edit that must be pushed; a few rounds settle it.
    for (let round = 0; round < 3; round++) {
      const t = await pushTours(out);
      const a = await push(out, rejectedThisRun);
      if (round === 0) out.photos = await uploadPhotos(out);
      await pullTours();
      const b = await pull(out);
      if (!a && !b && !t) break;
    }
    await pullHistory();
    out.conflicts = (await db.findings.toArray()).filter((f) => f.conflict).length;
    out.rejected = [...new Set(out.rejected)];
    if (out.rejected.length || out.photoErrors.length) {
      // Surfaces through the existing "last sync failed" alert; everything else was synced.
      out.error = [
        out.rejected.length ? `השרת דחה ${out.rejected.length} רשומות (נשמרו במכשיר וינוסו שוב): ${out.rejected.join('; ')}` : '',
        out.photoErrors.length ? `${out.photoErrors.length} תמונות לא הועלו (נשמרו במכשיר וינוסו שוב): ${out.photoErrors.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return out;
    }
    out.ok = true;
    await setMeta('lastSyncAt', out.at);
  } catch (e) {
    out.error = (e as Error).message || String(e);
  }
  return out;
}

let queued: Promise<SyncOutcome> | null = null;

/**
 * Runs a sync. If one is already running, a fresh one follows it: the running sync may have pushed
 * before the latest edits, and a caller (e.g. issuing a report) needs everything up to now on the server.
 */
export function syncNow(): Promise<SyncOutcome> {
  if (running)
    return (queued ??= running.then(() => {
      queued = null;
      return syncNow();
    }));
  running = run().then((o) => {
    last = o;
    running = null;
    emit();
    return o;
  });
  emit();
  return running;
}

let debounce: ReturnType<typeof setTimeout> | undefined;
export function scheduleSync(ms = 1500) {
  clearTimeout(debounce);
  debounce = setTimeout(() => navigator.onLine && syncNow(), ms);
}

/** iOS has no background sync, so sync whenever the app is open and has a chance. */
let autoSyncStarted = false;
export function startAutoSync() {
  // The app shell remounts after sign-out/sign-in; listeners must be installed once.
  if (autoSyncStarted) return scheduleSync(500);
  autoSyncStarted = true;
  window.addEventListener('online', () => scheduleSync(300));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && scheduleSync(300));
  setInterval(() => navigator.onLine && document.visibilityState === 'visible' && syncNow(), 30000);
  scheduleSync(500);
}
