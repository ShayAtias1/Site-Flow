import Dexie, { type Table } from 'dexie';
import type { Classification, FindingData, FindingEventPayload, Participant, ServerFinding, TourKind } from '../shared/types';

export interface LocalFinding extends FindingData {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Assigned by the server on first sync; null until then. */
  displayNo: number | null;
  /** Server version this local copy is based on; 0 = never synced. */
  version: number;
  /** The server's data at `version`, used as the common ancestor for merges. */
  base: FindingData | null;
  dirty: 0 | 1;
  /** Local edit counter, so a push result never clears an edit made while it was in flight. */
  rev: number;
  conflict: { server: ServerFinding; fields: (keyof FindingData)[] } | null;
  /**
   * The server refused this record. It is retried on later syncs (one attempt per sync) and,
   * after MAX_SYNC_ATTEMPTS, blocked until the user edits it — never resent without limit.
   */
  syncError?: { message: string; attempts: number; blocked: boolean; at: string } | null;
}

export interface LocalPhoto {
  id: string;
  /** null while the photo belongs to an unsaved draft. */
  findingId: string | null;
  // Stored as ArrayBuffer rather than Blob: Blobs in IndexedDB have had WebKit bugs.
  bytes: ArrayBuffer;
  thumb: ArrayBuffer;
  type: string;
  width: number;
  height: number;
  size: number;
  sha256: string;
  uploaded: 0 | 1;
  uploadedAt: string | null;
  createdAt: string;
  /** initial: taken when the finding was recorded; progress: added later (e.g. on a follow-up tour). */
  kind?: 'initial' | 'progress' | 'closure';
}

export interface CaptureDraft {
  locationId: string;
  /** (M5) More locations for the same finding: one finding per location, sharing a batch id. */
  extraLocationIds?: string[];
  categoryId: string;
  contractorId: string;
  contractorTouched: boolean;
  classification: Classification;
  description: string;
  locationDetail: string;
  photoIds: string[];
}

export interface DraftRow {
  /** `capture:<projectId>` — each project keeps its own draft. ('capture' was the single pre-M4 draft.) */
  key: string;
  data: CaptureDraft;
  updatedAt: string;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

// ---- Reference data, pulled from Supabase as-is (column names as in the database) ----

interface SyncedRow {
  id: string;
  org_id: string;
  version: number;
  seq: number;
  deleted_at: string | null;
}
export interface ProjectRow extends SyncedRow {
  code: string;
  name: string;
  address: string;
  developer: string;
  status: 'active' | 'archived';
}
export interface LocationRow extends SyncedRow {
  project_id: string;
  parent_id: string | null;
  kind: 'building' | 'floor' | 'unit' | 'common' | 'site';
  name: string;
  code: string;
  sort_order: number;
}
export interface CategoryRow extends SyncedRow {
  name: string;
  phrases: string[];
  sort_order: number;
}
export interface ContractorRow extends SyncedRow {
  name: string;
  trade: string;
  contact_name: string;
  phone: string;
  email: string;
}
export interface ProjectContractorRow extends SyncedRow {
  project_id: string;
  contractor_id: string;
}
export interface CategoryDefaultRow extends SyncedRow {
  project_id: string;
  category_id: string;
  contractor_id: string | null;
}

/** A tour: created and edited on the device (also offline), pushed with optimistic locking. */
export interface TourFields {
  kind: TourKind;
  tour_date: string;
  participants: Participant[];
  notes: string;
  status: 'active' | 'closed';
}
export interface TourRow extends SyncedRow, TourFields {
  project_id: string;
  scope_location_ids: string[];
  created_at?: string;
  /** Device bookkeeping (absent on rows as pulled): unsynced edit, edit counter, server copy at `version`. */
  dirty?: 0 | 1;
  rev?: number;
  base?: TourFields | null;
  syncError?: string | null;
}
export const TOUR_FIELDS: (keyof TourFields)[] = ['kind', 'tour_date', 'participants', 'notes', 'status'];

/** History of a finding. `pending`: recorded here and not yet accepted by the server. */
export interface EventRow extends FindingEventPayload {
  findingId: string;
  actorId: string | null;
  pending: 0 | 1;
}

/** Reference tables pulled from Supabase, in pull order. */
export const REFERENCE_TABLES = [
  'projects',
  'locations',
  'categories',
  'contractors',
  'project_contractors',
  'project_category_defaults',
] as const;
export type ReferenceTable = (typeof REFERENCE_TABLES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | null | undefined) => !!s && UUID_RE.test(s);

class SiteFlowDB extends Dexie {
  findings!: Table<LocalFinding, string>;
  photos!: Table<LocalPhoto, string>;
  drafts!: Table<DraftRow, string>;
  meta!: Table<MetaRow, string>;
  projects!: Table<ProjectRow, string>;
  locations!: Table<LocationRow, string>;
  categories!: Table<CategoryRow, string>;
  contractors!: Table<ContractorRow, string>;
  project_contractors!: Table<ProjectContractorRow, string>;
  project_category_defaults!: Table<CategoryDefaultRow, string>;
  /** PoC test data (demo ids that don't exist on the server), set aside by the v2 upgrade. Never synced. */
  legacyFindings!: Table<LocalFinding, string>;
  legacyPhotos!: Table<LocalPhoto, string>;
  tours!: Table<TourRow, string>;
  events!: Table<EventRow, string>;

  constructor() {
    // Strict durability: a write is reported done only once it is on disk (honoured by Chromium; WebKit flushes anyway).
    super('siteflow', { chromeTransactionDurability: 'strict' });
    this.version(1).stores({
      findings: 'id, dirty, locationId, updatedAt',
      photos: 'id, findingId, uploaded',
      drafts: 'key',
      meta: 'key',
    });
    // v2 (M2): sync moves to Supabase. Reference data gets local tables; PoC findings, whose
    // project/location ids exist only in the old demo, are moved aside (kept, not shown, not synced).
    this.version(2)
      .stores({
        projects: 'id',
        locations: 'id, project_id',
        categories: 'id',
        contractors: 'id',
        project_contractors: 'id, project_id',
        project_category_defaults: 'id, project_id',
        legacyFindings: 'id',
        legacyPhotos: 'id, findingId',
      })
      .upgrade(async (tx) => {
        const legacy = (await tx.table('findings').toArray()).filter((f: LocalFinding) => !isUuid(f.projectId));
        const ids = new Set(legacy.map((f) => f.id));
        const photos = (await tx.table('photos').toArray()).filter((p: LocalPhoto) => p.findingId && ids.has(p.findingId));
        await tx.table('legacyFindings').bulkPut(legacy);
        await tx.table('legacyPhotos').bulkPut(photos);
        await tx.table('findings').bulkDelete([...ids]);
        await tx.table('photos').bulkDelete(photos.map((p) => p.id));
        // Keep the eviction check (storage.checkIntegrity) from mistaking this move for data loss.
        try {
          localStorage.setItem('sf.knownFindings', String(await tx.table('findings').count()));
        } catch {
          /* only a secondary witness */
        }
        // The pull cursor belonged to the old sync server.
        await tx.table('meta').delete('pullCursor');
        const draft = await tx.table('drafts').get('capture');
        if (draft && !isUuid(draft.data.locationId))
          await tx.table('drafts').put({ ...draft, data: { ...draft.data, locationId: '', categoryId: '', contractorId: '' } });
      });
    // v3 (M4): tours and finding history on the device. Existing findings keep tourId null — they were
    // recorded before tours existed, and no tour is invented for them.
    this.version(3).stores({
      findings: 'id, dirty, locationId, updatedAt, projectId, tourId',
      tours: 'id, project_id, dirty',
      events: 'id, findingId, pending, tourId',
    });
  }
}

export const db = new SiteFlowDB();

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown) {
  await db.meta.put({ key, value });
}
