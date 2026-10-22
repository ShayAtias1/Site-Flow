// Supabase transport for sync: findings via push_findings(), pulls by `seq` cursor, photos in Storage.
// Mapping rules: the client keeps "" for an empty category/contractor; the database uses null.
import type { FindingData, PushChange, PushResult, ServerFinding } from '../shared/types';
import { supabase } from './auth';
import { db, type EventRow, type LocalPhoto, type ReferenceTable, type TourRow } from './db';

const PAGE = 500;

const iso = (t: string | null) => (t ? new Date(t).toISOString() : null);

/** The server row in the client's shape, so merges compare like with like. */
function normalize(r: ServerFinding): ServerFinding {
  return {
    ...r,
    categoryId: r.categoryId ?? '',
    contractorId: r.contractorId ?? '',
    tourId: r.tourId ?? null,
    batchId: r.batchId ?? null,
    locationDetail: r.locationDetail ?? '',
    photoIds: r.photoIds ?? [],
    deletedAt: iso(r.deletedAt),
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
  };
}

interface FindingDbRow {
  id: string;
  version: number;
  display_no: number;
  created_at: string;
  updated_at: string;
  project_id: string;
  tour_id: string | null;
  batch_id: string | null;
  location_id: string;
  location_detail: string;
  category_id: string | null;
  contractor_id: string | null;
  classification: FindingData['classification'];
  status: FindingData['status'];
  description: string;
  photo_ids: string[] | null;
  deleted_at: string | null;
  seq: number;
}

const fromDb = (r: FindingDbRow): ServerFinding =>
  normalize({
    id: r.id,
    version: r.version,
    displayNo: r.display_no,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    projectId: r.project_id,
    tourId: r.tour_id,
    batchId: r.batch_id,
    locationId: r.location_id,
    locationDetail: r.location_detail,
    categoryId: r.category_id ?? '',
    contractorId: r.contractor_id ?? '',
    classification: r.classification,
    status: r.status,
    description: r.description,
    photoIds: r.photo_ids ?? [],
    deletedAt: r.deleted_at,
  });

const toPayload = (d: FindingData) => ({
  ...d,
  categoryId: d.categoryId || null,
  contractorId: d.contractorId || null,
});

/** One call, per-record results. Throws only when the call itself fails (network, auth). */
export async function pushFindings(changes: PushChange[]): Promise<PushResult[]> {
  const { data, error } = await supabase.rpc('push_findings', {
    p_changes: changes.map((c) => ({ ...c, data: toPayload(c.data) })),
  });
  if (error) throw new Error(error.message);
  return (data as PushResult[]).map((r) => (r.status === 'error' ? r : { ...r, row: normalize(r.row) }));
}

export async function pullFindings(since: number): Promise<{ rows: ServerFinding[]; cursor: number }> {
  const { data, error } = await supabase.from('findings').select('*').gt('seq', since).order('seq').limit(PAGE);
  if (error) throw new Error(error.message);
  const rows = data as FindingDbRow[];
  return { rows: rows.map(fromDb), cursor: rows.length ? rows[rows.length - 1].seq : since };
}

/** Setup tables are read-only on devices in M2; they are mirrored as-is. */
export async function pullReference(table: ReferenceTable | 'tours', since: number): Promise<{ rows: { id: string; seq: number }[]; cursor: number }> {
  const { data, error } = await supabase.from(table).select('*').gt('seq', since).order('seq').limit(PAGE);
  if (error) throw new Error(`${table}: ${error.message}`);
  const rows = data as { id: string; seq: number }[];
  return { rows, cursor: rows.length ? rows[rows.length - 1].seq : since };
}

const photoPath = (orgId: string, projectId: string, photoId: string) => `${orgId}/${projectId}/${photoId}.jpg`;

/**
 * Uploads one photo and records it. Safe to repeat after a lost response: an object that already
 * exists counts only if its size matches. Returns false when the photo cannot be uploaded yet.
 */
export async function uploadPhoto(p: LocalPhoto, projectId: string): Promise<boolean> {
  const project = await db.projects.get(projectId);
  if (!project) return false;
  const path = photoPath(project.org_id, projectId, p.id);
  const bucket = supabase.storage.from('photos');
  const up = await bucket.upload(path, new Blob([p.bytes], { type: p.type }), { contentType: p.type, upsert: false });
  if (up.error) {
    const exists = /exists|duplicate/i.test(up.error.message);
    if (!exists) throw new Error(`photo ${p.id.slice(0, 8)}: ${up.error.message}`);
    const listed = await bucket.list(`${project.org_id}/${projectId}`, { search: `${p.id}.jpg` });
    const size = listed.data?.find((o) => o.name === `${p.id}.jpg`)?.metadata?.size;
    if (size !== p.size) throw new Error(`photo ${p.id.slice(0, 8)}: stored copy differs (${size} ≠ ${p.size})`);
  }
  const row = await supabase.from('photos').upsert(
    { id: p.id, org_id: project.org_id, finding_id: p.findingId, storage_path: path, size: p.size, sha256: p.sha256, width: p.width, height: p.height, kind: p.kind ?? 'initial' },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  if (row.error) throw new Error(`photo ${p.id.slice(0, 8)}: ${row.error.message}`);
  return true;
}

/** A short-lived link to a photo stored on the server (for photos taken on another device). */
export async function photoUrl(photoId: string): Promise<string | null> {
  const { data } = await supabase.from('photos').select('storage_path').eq('id', photoId).maybeSingle();
  if (!data) return null;
  const signed = await supabase.storage.from('photos').createSignedUrl(data.storage_path, 3600);
  return signed.data?.signedUrl ?? null;
}

// ---------- Tours and history (M4) ----------

const tourColumns = (t: TourRow) => ({
  id: t.id,
  org_id: t.org_id,
  project_id: t.project_id,
  kind: t.kind,
  tour_date: t.tour_date,
  participants: t.participants,
  notes: t.notes,
  status: t.status,
});

export type TourPush = { status: 'ok'; row: TourRow } | { status: 'stale'; row: TourRow } | { status: 'error'; error: string };

/** Inserts a new tour or updates one at the version the device last saw. 'stale': the server moved on. */
export async function pushTour(t: TourRow): Promise<TourPush> {
  if (t.version === 0) {
    const ins = await supabase.from('tours').insert(tourColumns(t)).select().single();
    if (!ins.error) return { status: 'ok', row: ins.data as TourRow };
    if (ins.error.code !== '23505') return { status: 'error', error: ins.error.message };
    // Inserted by an earlier attempt whose response was lost.
  } else {
    const { kind, tour_date, participants, notes, status } = t;
    const upd = await supabase.from('tours').update({ kind, tour_date, participants, notes, status }).eq('id', t.id).eq('version', t.version).select();
    if (upd.error) return { status: 'error', error: upd.error.message };
    if (upd.data.length) return { status: 'ok', row: upd.data[0] as TourRow };
  }
  const cur = await supabase.from('tours').select('*').eq('id', t.id).single();
  if (cur.error) return { status: 'error', error: cur.error.message };
  return { status: 'stale', row: cur.data as TourRow };
}

export interface ServerEvent {
  id: string;
  finding_id: string;
  tour_id: string | null;
  actor_id: string | null;
  at: string;
  type: EventRow['type'];
  from_value: EventRow['from'];
  to_value: EventRow['to'];
  note: string;
  seq: number;
}

export async function pullEvents(since: number): Promise<{ rows: EventRow[]; cursor: number }> {
  const { data, error } = await supabase.from('finding_events').select('*').gt('seq', since).order('seq').limit(PAGE);
  if (error) throw new Error(`finding_events: ${error.message}`);
  const rows = data as ServerEvent[];
  return {
    rows: rows.map((e) => ({
      id: e.id,
      findingId: e.finding_id,
      tourId: e.tour_id,
      actorId: e.actor_id,
      at: new Date(e.at).toISOString(),
      type: e.type,
      from: e.from_value,
      to: e.to_value,
      note: e.note ?? '',
      pending: 0,
    })),
    cursor: rows.length ? rows[rows.length - 1].seq : since,
  };
}
