// Types shared by the PWA, the sync server and the report renderer.

export type Classification = 'missing' | 'defective' | 'critical';
export type FindingStatus = 'open' | 'reported_done' | 'closed' | 'reopened' | 'cancelled';

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  missing: 'עבודה חסרה',
  defective: 'בוצע שגוי',
  critical: 'ליקוי קריטי / בטיחותי',
};

export const STATUS_LABEL: Record<FindingStatus, string> = {
  open: 'פתוח',
  reported_done: 'דווח כבוצע',
  closed: 'נסגר (אומת)',
  reopened: 'נפתח מחדש',
  cancelled: 'בוטל',
};

// ---------- Tours and history (M4) ----------

export type TourKind = 'initial' | 'follow_up' | 'verification';

export const TOUR_KIND_LABEL: Record<TourKind, string> = {
  initial: 'סיור ראשוני',
  follow_up: 'סיור חוזר',
  verification: 'סיור אימות / מסירה',
};

export interface Participant {
  name: string;
  /** Role or company, e.g. "מפקח", "נציג הקבלן — לוי חשמל". */
  role: string;
}

export type FindingEventType = 'created' | 'status_changed' | 'field_changed' | 'photo_added' | 'comment' | 'deleted' | 'restored';

/** One change to a finding, as recorded on the device and pushed with it. Field names as in the database. */
export interface FindingEventPayload {
  id: string;
  type: FindingEventType;
  at: string;
  tourId: string | null;
  from: Record<string, unknown> | null;
  to: Record<string, unknown> | null;
  note: string;
}

/** The fields that are synced and merged. Everything else is bookkeeping. */
export interface FindingData {
  projectId: string;
  /** Tour the finding was recorded in (tours arrive in M4; null until then). */
  tourId: string | null;
  /** Shared by findings created together for several units. */
  batchId: string | null;
  locationId: string;
  locationDetail: string;
  categoryId: string;
  contractorId: string;
  classification: Classification;
  description: string;
  status: FindingStatus;
  photoIds: string[];
  deletedAt: string | null;
}

export const FINDING_FIELDS: (keyof FindingData)[] = [
  'projectId',
  'tourId',
  'batchId',
  'locationId',
  'locationDetail',
  'categoryId',
  'contractorId',
  'classification',
  'description',
  'status',
  'photoIds',
  'deletedAt',
];

export interface ServerFinding extends FindingData {
  id: string;
  /** Incremented by the server on every accepted write. */
  version: number;
  /** Sequential per project, assigned by the server on first sync. */
  displayNo: number;
  createdAt: string;
  updatedAt: string;
}

export interface PushChange {
  id: string;
  /** The server version this edit was based on; 0 for a new record. */
  baseVersion: number;
  createdAt: string;
  data: FindingData;
  /** History recorded on the device since the last accepted push. Absent: the server derives it. */
  events?: FindingEventPayload[];
}

export type PushResult =
  | { id: string; status: 'ok'; row: ServerFinding }
  | { id: string; status: 'conflict'; row: ServerFinding }
  /** This record was rejected; the rest of the batch is unaffected and it stays pending on the device. */
  | { id: string; status: 'error'; error: string };

export interface PullResponse {
  rows: ServerFinding[];
  cursor: number;
}

export interface PhotoUploadResult {
  id: string;
  size: number;
  sha256: string;
}

// ---------- Reports ----------

export type ReportFormat = 'table' | 'detailed';

export type ReportScope =
  | { type: 'project' }
  | { type: 'location'; locationId: string }
  | { type: 'contractor'; contractorId: string };

export type ReportGrouping = 'location' | 'contractor' | 'none';

/** What goes into a report. Stored with the report (column `scope`) so a later revision repeats it. */
export interface ReportOptions {
  /** Area: the whole project, any location subtree (building, floor, unit, area) or one contractor. */
  scope: ReportScope;
  /** Contractor-specific report within the area. */
  contractorId: string | null;
  statuses: FindingStatus[];
  /** null: findings of every tour (and those recorded before tours existed). */
  tourIds: string[] | null;
  criticalOnly: boolean;
  grouping: ReportGrouping;
  title: string;
  notes: string;
  /** The tour whose date and participants appear on the cover. */
  headerTourId: string | null;
}

export const ALL_STATUSES = Object.keys(STATUS_LABEL) as FindingStatus[];
export const OPEN_STATUSES: FindingStatus[] = ['open', 'reported_done', 'reopened'];

export const DEFAULT_TITLE: Record<ReportFormat, string> = {
  table: 'דוח עבודות להשלמה — ריכוז טבלאי',
  detailed: 'פרוטוקול סיור — עבודות להשלמה',
};

/** Options of reports issued before M7 (scope only): everything not deleted, in walking order. */
export const legacyOptions = (scope: ReportScope): ReportOptions => ({
  scope,
  contractorId: null,
  statuses: ALL_STATUSES,
  tourIds: null,
  criticalOnly: false,
  grouping: 'none',
  title: '',
  notes: '',
  headerTourId: null,
});

export interface ReportFindingRow {
  displayNo: number;
  location: string;
  locationCode: string;
  locationDetail: string;
  /** Grouping key/label when grouped by location: the unit's parent (e.g. "בניין A › קומה 2"). */
  area: string;
  category: string;
  contractor: string;
  classification: Classification;
  status: FindingStatus;
  description: string;
  tour: string;
  createdAt: string;
  /** Photo ids; the renderer resolves them to image bytes. */
  photoIds: string[];
}

/** Everything a report shows, frozen at issue time. */
export interface ReportSnapshot {
  number: string;
  revision: number;
  format: ReportFormat;
  title: string;
  /** Fixed: what kind of document this is (a completion / follow-up protocol, not an approval). */
  docKind: string;
  scopeLabel: string;
  /** Statuses, tours and other filters, in words. */
  filterLabel: string;
  grouping: ReportGrouping;
  notes: string;
  issuedAt: string;
  /** Date of the cover tour, or null when the report is not tied to one tour. */
  tourDate: string | null;
  tourLabel: string;
  project: { name: string; code: string; address: string; developer: string };
  /** Logo: data URI (PNG/JPEG/SVG) or null. */
  company: { name: string; details: string; logo: string | null };
  /** Only what the user entered; empty fields are left out. Signature: data URI or null. */
  author: { name: string; title: string; registration: string; signature: string | null };
  participants: { name: string; role: string }[];
  disclaimer: string;
  findings: ReportFindingRow[];
}

export interface IssuedReport {
  id: string;
  number: string;
  revision: number;
  supersedesId?: string | null;
  format: ReportFormat;
  title: string;
  issuedAt: string;
  findingCount: number;
  pdfSha256: string;
  pdfBytes: number;
}
