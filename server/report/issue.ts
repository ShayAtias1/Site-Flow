// Issues a report as the signed-in user: reads through RLS with the user's token, renders the PDF,
// stores it in the private bucket and records the (immutable) report row.
import { createHash, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildProjectModel, type ProjectRows } from '../../shared/projectModel';
import { normalizeOptions, parseScope, selectFindings } from '../../shared/reportFilter';
import {
  DEFAULT_TITLE,
  TOUR_KIND_LABEL,
  legacyOptions,
  type IssuedReport,
  type Participant,
  type ReportFormat,
  type ReportOptions,
  type ReportScope,
  type ServerFinding,
  type TourKind,
} from '../../shared/types';
import { renderPdf } from './pdf';
import { buildSnapshot, type Branding, type SnapshotTour } from './snapshot';

export class ReportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function userClient(url: string, key: string, accessToken: string) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function all<T>(q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new ReportError(error.message, 500);
  return data ?? [];
}

async function loadProject(sb: SupabaseClient, projectId: string) {
  const { data: project, error } = await sb.from('projects').select('*').eq('id', projectId).maybeSingle();
  if (error) throw new ReportError(error.message, 500);
  if (!project) throw new ReportError('project not found or not accessible', 404);
  const rows: ProjectRows = {
    project,
    locations: await all(sb.from('locations').select('*').eq('project_id', projectId)),
    categories: await all(sb.from('categories').select('*').eq('org_id', project.org_id)),
    contractors: await all(sb.from('contractors').select('*').eq('org_id', project.org_id)),
    projectContractors: await all(sb.from('project_contractors').select('*').eq('project_id', projectId)),
    defaults: await all(sb.from('project_category_defaults').select('*').eq('project_id', projectId)),
  };
  return buildProjectModel(rows);
}

interface FindingRow {
  id: string; version: number; display_no: number; created_at: string; updated_at: string; project_id: string;
  tour_id: string | null; batch_id: string | null; location_id: string; location_detail: string;
  category_id: string | null; contractor_id: string | null; classification: ServerFinding['classification'];
  status: ServerFinding['status']; description: string; photo_ids: string[] | null; deleted_at: string | null;
}

const toFinding = (r: FindingRow): ServerFinding => ({
  id: r.id, version: r.version, displayNo: r.display_no, createdAt: r.created_at, updatedAt: r.updated_at,
  projectId: r.project_id, tourId: r.tour_id, batchId: r.batch_id, locationId: r.location_id,
  locationDetail: r.location_detail, categoryId: r.category_id ?? '', contractorId: r.contractor_id ?? '',
  classification: r.classification, status: r.status, description: r.description, photoIds: r.photo_ids ?? [],
  deletedAt: r.deleted_at,
});

async function nextNumber(sb: SupabaseClient, orgId: string, prefix: string) {
  const rows = await all<{ number: string }>(sb.from('reports').select('number').eq('org_id', orgId).like('number', `${prefix}-%`));
  const max = rows.reduce((n, r) => Math.max(n, Number(r.number.slice(prefix.length + 1)) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

/** Reads every row: PostgREST returns at most 1000 rows per request. */
async function allPages<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await all(query(from, from + 999));
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const formatDay = (d: string) => d.split('-').reverse().join('.');

async function loadBranding(sb: SupabaseClient, orgId: string): Promise<Branding> {
  const { data: s } = await sb.from('report_settings').select('*').eq('org_id', orgId).maybeSingle();
  const { data: org } = await sb.from('orgs').select('name').eq('id', orgId).maybeSingle();
  return {
    company: { name: s?.company_name || org?.name || '', details: s?.company_details ?? '', logo: s?.logo ?? null },
    author: { name: s?.author_name ?? '', title: s?.author_title ?? '', registration: s?.author_registration ?? '', signature: s?.signature ?? null },
  };
}

async function loadTours(sb: SupabaseClient, projectId: string): Promise<SnapshotTour[]> {
  const rows = await all<{ id: string; kind: TourKind; tour_date: string; participants: Participant[] | null; deleted_at: string | null }>(
    sb.from('tours').select('id, kind, tour_date, participants, deleted_at').eq('project_id', projectId),
  );
  return rows.map((t) => ({
    id: t.id,
    label: `${TOUR_KIND_LABEL[t.kind] ?? 'סיור'} ${formatDay(t.tour_date)}`,
    date: t.tour_date,
    participants: (t.participants ?? []).filter((p) => p && typeof p.name === 'string'),
  }));
}

export interface IssueRequest {
  projectId: string;
  format: ReportFormat;
  scope: ReportScope;
  options?: unknown;
  /** Issue a new revision of this report: same number and options, current data. */
  supersedes?: string;
}

export async function issueReport(sb: SupabaseClient, req: IssueRequest): Promise<IssuedReport> {
  if (typeof req.projectId !== 'string') throw new ReportError('projectId required', 400);
  let format = req.format;
  let options: ReportOptions;
  let fixedNumber: string | null = null;
  let supersedes: string | null = null;
  if (req.supersedes) {
    const { data: prev, error } = await sb.from('reports').select('id, project_id, org_id, number, format, scope').eq('id', req.supersedes).maybeSingle();
    if (error) throw new ReportError(error.message, 500);
    if (!prev || prev.project_id !== req.projectId) throw new ReportError('report not found', 404);
    format = prev.format;
    const stored = prev.scope as ReportScope & { options?: unknown };
    const scope = parseScope(stored);
    if (!scope) throw new ReportError('stored scope is not valid', 409);
    options = stored.options ? normalizeOptions(stored.options, scope, format) : { ...legacyOptions(scope), title: DEFAULT_TITLE[format] };
    fixedNumber = prev.number;
    supersedes = prev.id;
  } else {
    if (format !== 'table' && format !== 'detailed') throw new ReportError('unknown format', 400);
    const scope = parseScope(req.scope);
    if (!scope) throw new ReportError('invalid scope', 400);
    options = normalizeOptions(req.options, scope, format);
  }

  const model = await loadProject(sb, req.projectId);
  const [branding, tours] = await Promise.all([loadBranding(sb, model.project.orgId), loadTours(sb, req.projectId)]);
  const findings = (
    await allPages<FindingRow>((from, to) =>
      sb.from('findings').select('*').eq('project_id', req.projectId).is('deleted_at', null).order('display_no').range(from, to),
    )
  ).map(toFinding);
  const included = selectFindings(model, findings, options);

  // Photos come from the private bucket, through the same user's permissions. Only the detailed
  // protocol shows them, and only for the findings it includes.
  const photoBytes = new Map<string, Buffer>();
  if (format === 'detailed') {
    const ids = [...new Set(included.flatMap((f) => f.photoIds))];
    const photoRows: { id: string; storage_path: string }[] = [];
    for (const part of chunks(ids, 100)) photoRows.push(...(await all<{ id: string; storage_path: string }>(sb.from('photos').select('id, storage_path').in('id', part))));
    for (const p of photoRows) {
      const { data } = await sb.storage.from('photos').download(p.storage_path);
      if (data) photoBytes.set(p.id, Buffer.from(await data.arrayBuffer()));
    }
  }

  const prefix = `${model.project.code}-${format === 'table' ? 'T' : 'P'}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = fixedNumber ?? (await nextNumber(sb, model.project.orgId, prefix));
    const revision = fixedNumber
      ? (await all<{ revision: number }>(sb.from('reports').select('revision').eq('org_id', model.project.orgId).eq('number', number))).reduce((n, r) => Math.max(n, r.revision), -1) + 1
      : 0;
    const snapshot = buildSnapshot({ model, number, revision, format, options, findings, branding, tours });
    const pdf = await renderPdf(snapshot, (id) => photoBytes.get(id));
    const id = randomUUID();
    const path = `${model.project.orgId}/${req.projectId}/${id}.pdf`;
    const sha = createHash('sha256').update(pdf).digest('hex');
    const up = await sb.storage.from('reports').upload(path, pdf, { contentType: 'application/pdf', upsert: false });
    if (up.error) throw new ReportError(`upload: ${up.error.message}`, /row-level|policy|unauthorized/i.test(up.error.message) ? 403 : 500);
    const ins = await sb.from('reports').insert({
      id, org_id: model.project.orgId, project_id: req.projectId, number, revision, supersedes_report_id: supersedes, format,
      title: snapshot.title, scope: { ...options.scope, options }, issued_at: snapshot.issuedAt, finding_count: snapshot.findings.length,
      snapshot, pdf_path: path, pdf_sha256: sha, pdf_bytes: pdf.length,
    });
    if (ins.error?.code === '23505') continue; // number taken by a concurrent issue — take the next one
    if (ins.error) throw new ReportError(ins.error.message, ins.error.code === '42501' ? 403 : 500);
    return {
      id, number, revision, supersedesId: supersedes, format, title: snapshot.title, issuedAt: snapshot.issuedAt,
      findingCount: snapshot.findings.length, pdfSha256: sha, pdfBytes: pdf.length,
    };
  }
  throw new ReportError('could not allocate a report number', 409);
}
