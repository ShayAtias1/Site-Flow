// A project's setup data in the shapes the screens and the report builder use.
// Built from the database rows (app: Dexie mirror; PDF service: Supabase) or from the demo fixture.
import type { Category, Contractor, LocationNode } from './project';

export interface ProjectInfo {
  id: string;
  orgId: string;
  code: string;
  name: string;
  address: string;
  developer: string;
}

export interface ProjectModel {
  project: ProjectInfo;
  locations: LocationNode[];
  /** Units and common areas in walking order (tree order) — drives "next unit". */
  walkOrder: LocationNode[];
  categories: Category[];
  contractors: Contractor[];
  locationById: (id: string) => LocationNode | undefined;
  locationPath: (id: string) => LocationNode[];
  locationLabel: (id: string) => string;
  isWithin: (locationId: string, ancestorId: string) => boolean;
  categoryById: (id: string) => Category | undefined;
  contractorById: (id: string) => Contractor | undefined;
}

interface Row {
  id: string;
  deleted_at?: string | null;
}

export interface ProjectRows {
  project: Row & { org_id: string; code: string; name: string; address: string; developer: string };
  locations: (Row & { project_id: string; parent_id: string | null; kind: LocationNode['kind']; name: string; code: string; sort_order: number })[];
  categories: (Row & { name: string; phrases: string[]; sort_order: number })[];
  contractors: (Row & { name: string; trade: string })[];
  projectContractors: (Row & { project_id: string; contractor_id: string })[];
  defaults: (Row & { project_id: string; category_id: string; contractor_id: string | null })[];
}

const live = <T extends Row>(rows: T[]) => rows.filter((r) => !r.deleted_at);

export function buildProjectModel(rows: ProjectRows): ProjectModel {
  const pid = rows.project.id;
  const locRows = live(rows.locations)
    .filter((l) => l.project_id === pid)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'he'));
  const locations: LocationNode[] = locRows.map((l) => ({ id: l.id, parentId: l.parent_id, kind: l.kind, name: l.name, code: l.code }));
  const byId = new Map(locations.map((n) => [n.id, n]));

  const children = new Map<string | null, LocationNode[]>();
  for (const n of locations) {
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    children.set(key, [...(children.get(key) ?? []), n]);
  }
  const walkOrder: LocationNode[] = [];
  const visit = (parent: string | null) => {
    for (const n of children.get(parent) ?? []) {
      if (n.kind === 'unit' || n.kind === 'common') walkOrder.push(n);
      visit(n.id);
    }
  };
  visit(null);

  const defaults = new Map(live(rows.defaults).filter((d) => d.project_id === pid).map((d) => [d.category_id, d.contractor_id ?? '']));
  const categories: Category[] = live(rows.categories)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'he'))
    .map((c) => ({ id: c.id, name: c.name, phrases: c.phrases ?? [], defaultContractorId: defaults.get(c.id) ?? '' }));

  // Only the contractors assigned to this project: projects never share a contractor list implicitly.
  const onProject = new Set(live(rows.projectContractors).filter((pc) => pc.project_id === pid).map((pc) => pc.contractor_id));
  const contractors = live(rows.contractors)
    .filter((c) => onProject.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, trade: c.trade }))
    .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  // A default pointing at a contractor no longer on the project is no default.
  for (const c of categories) if (c.defaultContractorId && !onProject.has(c.defaultContractorId)) c.defaultContractorId = '';
  // Lookups also find removed or unassigned contractors and categories, so old findings keep their labels.
  const contractorIndex = new Map(rows.contractors.map((c) => [c.id, { id: c.id, name: c.name, trade: c.trade }]));
  const categoryIndex = new Map<string, Category>([
    ...rows.categories.map((c): [string, Category] => [c.id, { id: c.id, name: c.name, phrases: c.phrases ?? [], defaultContractorId: '' }]),
    ...categories.map((c): [string, Category] => [c.id, c]),
  ]);

  const locationPath = (id: string) => {
    const path: LocationNode[] = [];
    let cur = byId.get(id);
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return path;
  };

  return {
    project: {
      id: pid,
      orgId: rows.project.org_id,
      code: rows.project.code,
      name: rows.project.name,
      address: rows.project.address,
      developer: rows.project.developer,
    },
    locations,
    walkOrder,
    categories,
    contractors,
    locationById: (id) => byId.get(id),
    locationPath,
    locationLabel: (id) => locationPath(id).map((n) => n.name).join(' › '),
    isWithin: (locationId, ancestorId) => locationPath(locationId).some((n) => n.id === ancestorId),
    categoryById: (id) => categoryIndex.get(id),
    contractorById: (id) => contractorIndex.get(id),
  };
}
