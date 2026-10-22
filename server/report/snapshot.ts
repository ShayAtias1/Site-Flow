import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUTHOR, COMPANY, DISCLAIMER } from '../../shared/project';
import type { ProjectModel } from '../../shared/projectModel';
import { areaOf, filterLabel, scopeLabel, selectFindings } from '../../shared/reportFilter';
import { legacyOptions, type Participant, type ReportFormat, type ReportOptions, type ReportSnapshot, type ServerFinding } from '../../shared/types';

const asset = (name: string) => readFileSync(fileURLToPath(new URL(`../assets/${name}`, import.meta.url)), 'utf8');
const svgUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

/** What every report of an organization shows as company and author (table report_settings). */
export interface Branding {
  company: { name: string; details: string; logo: string | null };
  author: { name: string; title: string; registration: string; signature: string | null };
}

/** Clearly fake branding for the sample PDFs only (scripts/generate-sample-pdfs.ts). Never used for issued reports. */
export const SAMPLE_BRANDING: Branding = {
  company: { name: COMPANY.name, details: COMPANY.address, logo: svgUri(asset('logo.svg')) },
  author: { name: AUTHOR.name, title: AUTHOR.title, registration: AUTHOR.license, signature: svgUri(asset('signature.svg')) },
};

export const DOC_KIND = 'פרוטוקול מעקב השלמת עבודות בנייה — אינו אישור הנדסי, קונסטרוקטיבי או בטיחותי';

export interface SnapshotTour {
  id: string;
  label: string;
  date: string;
  participants: Participant[];
}

export function buildSnapshot(opts: {
  model: ProjectModel;
  number: string;
  revision?: number;
  format: ReportFormat;
  options?: ReportOptions;
  findings: ServerFinding[];
  branding: Branding;
  tours?: SnapshotTour[];
  issuedAt?: string;
}): ReportSnapshot {
  const m = opts.model;
  const o = opts.options ?? legacyOptions({ type: 'project' });
  const b = opts.branding;
  const now = opts.issuedAt ?? new Date().toISOString();
  const tours = new Map((opts.tours ?? []).map((t) => [t.id, t]));
  const header =
    (o.headerTourId && tours.get(o.headerTourId)) || (o.tourIds?.length === 1 ? tours.get(o.tourIds[0]) : undefined) || null;
  const findings = selectFindings(m, opts.findings, o).map((f) => ({
    displayNo: f.displayNo,
    location: m.locationLabel(f.locationId),
    locationCode: m.locationById(f.locationId)?.code ?? '',
    locationDetail: f.locationDetail,
    area: areaOf(m, f.locationId),
    category: m.categoryById(f.categoryId)?.name ?? '—',
    contractor: m.contractorById(f.contractorId)?.name ?? '—',
    classification: f.classification,
    status: f.status,
    description: f.description,
    tour: f.tourId ? tours.get(f.tourId)?.label ?? '' : '',
    createdAt: f.createdAt,
    photoIds: [...f.photoIds],
  }));
  const participants: Participant[] = [];
  if (b.author.name) participants.push({ name: b.author.name, role: [b.author.title, 'עורך הדוח'].filter(Boolean).join(' · ') });
  for (const p of header?.participants ?? []) if (p.name.trim() && p.name !== b.author.name) participants.push(p);
  return {
    number: opts.number,
    revision: opts.revision ?? 0,
    format: opts.format,
    title: o.title || (opts.format === 'table' ? 'דוח עבודות להשלמה — ריכוז טבלאי' : 'פרוטוקול סיור — עבודות להשלמה'),
    docKind: DOC_KIND,
    scopeLabel: scopeLabel(m, o),
    filterLabel: filterLabel(o, (id) => tours.get(id)?.label ?? 'סיור'),
    grouping: o.grouping,
    notes: o.notes,
    issuedAt: now,
    tourDate: header?.date ?? null,
    tourLabel: header?.label ?? '',
    project: { name: m.project.name, code: m.project.code, address: m.project.address, developer: m.project.developer },
    company: b.company,
    author: b.author,
    participants,
    disclaimer: DISCLAIMER,
    findings,
  };
}
