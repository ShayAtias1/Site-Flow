// Project setup writes (M3). Setup is edited online, straight against Supabase; every write is
// mirrored into Dexie at once so the screens (and capture, offline afterwards) see it immediately.
// Updates carry the version they were based on — a change made elsewhere in the meantime is
// reported, never overwritten.
import type { PostgrestError } from '@supabase/supabase-js';
import type { BuildingSpec, FloorSpec, GeneratedNode } from '../shared/structure';
import { generateBuilding, generateFloors } from '../shared/structure';
import { supabase } from './auth';
import {
  db,
  setMeta,
  getMeta,
  type CategoryDefaultRow,
  type CategoryRow,
  type ContractorRow,
  type LocationRow,
  type ProjectContractorRow,
  type ProjectRow,
  type ReferenceTable,
} from './db';

export class SetupError extends Error {}

export type Role = 'owner' | 'engineer' | 'viewer';
export interface Membership {
  orgId: string;
  orgName: string;
  role: Role;
}

function explain(e: PostgrestError | Error): SetupError {
  const pg = e as PostgrestError;
  const msg = e.message ?? String(e);
  if (pg.hint === 'has_findings' || /has findings/.test(msg)) return new SetupError('יש ממצאים במיקום הזה או ביחידות שתחתיו, ולכן אי אפשר למחוק אותו.');
  if (pg.code === '23505' && /projects_org_code/.test(msg)) return new SetupError('קוד הפרויקט כבר בשימוש בפרויקט אחר בארגון.');
  if (pg.code === '42501' || /row-level security|permission denied/i.test(msg)) return new SetupError('אין לך הרשאת עריכה בארגון הזה.');
  if (/fetch|network|Failed to fetch|Load failed/i.test(msg)) return new SetupError('אין חיבור לשרת. עריכת הגדרות הפרויקט דורשת חיבור.');
  return new SetupError(msg);
}

const now = () => new Date().toISOString();

async function mirror<T extends { id: string }>(table: ReferenceTable, rows: T[]) {
  if (rows.length) await db.table(table).bulkPut(rows);
  return rows;
}

async function insertRows<T extends { id: string }>(table: ReferenceTable, rows: object[]): Promise<T[]> {
  if (!rows.length) return [];
  const { data, error } = await supabase.from(table).insert(rows).select();
  if (error) throw explain(error);
  return mirror(table, data as T[]);
}

/** Versioned update: applies only if the row is still at the version the screen showed. */
async function updateRow<T extends { id: string; version: number }>(table: ReferenceTable, row: T, patch: Partial<T>): Promise<T> {
  const res = await supabase.from(table).update(patch as Record<string, unknown>).eq('id', row.id).eq('version', row.version).select();
  if (res.error) throw explain(res.error);
  if (!res.data.length) {
    const fresh = await supabase.from(table).select('*').eq('id', row.id).maybeSingle();
    if (fresh.data) await mirror(table, [fresh.data]);
    throw new SetupError('הנתון שונה בינתיים במכשיר אחר. המסך עודכן לגרסה החדשה — בדוק ונסה שוב.');
  }
  return (await mirror(table, res.data as T[]))[0];
}

async function softDelete<T extends { id: string }>(table: ReferenceTable, ids: string[]): Promise<T[]> {
  if (!ids.length) return [];
  const { data, error } = await supabase.from(table).update({ deleted_at: now() }).in('id', ids).is('deleted_at', null).select();
  if (error) throw explain(error);
  return mirror(table, data as T[]);
}

const wrap = async <T>(p: () => Promise<T>): Promise<T> => {
  try {
    return await p();
  } catch (e) {
    throw e instanceof SetupError ? e : explain(e as Error);
  }
};

// ---------- Organization membership ----------

/** The user's organizations and roles. Cached on the device for offline display. */
export async function loadMemberships(): Promise<Membership[]> {
  const { data, error } = await supabase
    .from('memberships')
    .select('org_id, role, orgs(name)')
    .then((r) => r, (e: Error) => ({ data: null, error: e as unknown as PostgrestError }));
  if (error || !data) {
    const cached = await getMeta<Membership[]>('memberships');
    if (cached) return cached;
    throw explain(error);
  }
  const list = (data as unknown as { org_id: string; role: Role; orgs: { name: string } | null }[]).map((m) => ({
    orgId: m.org_id,
    orgName: m.orgs?.name ?? '',
    role: m.role,
  }));
  await setMeta('memberships', list);
  return list;
}

export const canWrite = (role: Role | undefined) => role === 'owner' || role === 'engineer';

// ---------- Projects ----------

export async function setCurrentProject(id: string) {
  await setMeta('currentProjectId', id);
}

export type ProjectFields = Pick<ProjectRow, 'code' | 'name' | 'address' | 'developer'>;

export function validateProject(p: ProjectFields): string | null {
  if (!p.name.trim()) return 'יש להזין שם פרויקט';
  if (!p.code.trim()) return 'יש להזין קוד פרויקט';
  if (!/^[A-Za-z0-9-]{1,12}$/.test(p.code.trim())) return 'קוד הפרויקט: אותיות לועזיות, ספרות ומקף בלבד, עד 12 תווים (מופיע במספרי הדוחות)';
  return null;
}

const clean = (p: ProjectFields): ProjectFields => ({
  code: p.code.trim().toUpperCase(),
  name: p.name.trim(),
  address: p.address.trim(),
  developer: p.developer.trim(),
});

export const createProject = (orgId: string, fields: ProjectFields) =>
  wrap(async () => {
    const [row] = await insertRows<ProjectRow>('projects', [{ id: crypto.randomUUID(), org_id: orgId, status: 'active', ...clean(fields) }]);
    await setCurrentProject(row.id);
    return row;
  });

export const updateProject = (row: ProjectRow, patch: Partial<ProjectFields> & { status?: ProjectRow['status'] }) =>
  wrap(() => {
    const { status, ...fields } = patch;
    return updateRow<ProjectRow>('projects', row, { ...clean({ ...row, ...fields }), ...(status ? { status } : {}) });
  });

// ---------- Locations ----------

const nextOrder = async (projectId: string) =>
  (await db.locations.where('project_id').equals(projectId).toArray()).reduce((m, l) => Math.max(m, l.sort_order), 0) + 1;

/** Generated nodes → location rows with fresh ids, under `parentId` (null: project level). */
async function insertNodes(project: ProjectRow, nodes: GeneratedNode[], parentId: string | null) {
  const ids = new Map(nodes.map((n) => [n.key, crypto.randomUUID()]));
  let order = await nextOrder(project.id);
  const rows = nodes.map((n) => ({
    id: ids.get(n.key)!,
    org_id: project.org_id,
    project_id: project.id,
    parent_id: n.parentKey === null ? parentId : (ids.get(n.parentKey) ?? parentId),
    kind: n.kind,
    name: n.name,
    code: n.code,
    sort_order: order++,
  }));
  // One request: the whole building is created, or nothing is.
  return insertRows<LocationRow>('locations', rows);
}

export const createBuilding = (project: ProjectRow, spec: BuildingSpec) => wrap(() => insertNodes(project, generateBuilding(spec), null));

export const addFloors = (project: ProjectRow, building: LocationRow, spec: FloorSpec) =>
  wrap(() => insertNodes(project, generateFloors(spec, 'parent', building.code), building.id));

export const addLocation = (project: ProjectRow, parentId: string | null, kind: LocationRow['kind'], name: string, code = '') =>
  wrap(async () => {
    if (!name.trim()) throw new SetupError('יש להזין שם');
    const [row] = await insertRows<LocationRow>('locations', [
      { id: crypto.randomUUID(), org_id: project.org_id, project_id: project.id, parent_id: parentId, kind, name: name.trim(), code: code.trim(), sort_order: await nextOrder(project.id) },
    ]);
    return row;
  });

/** Several units on one floor at once (names and codes already chosen), in this order. */
export const addUnits = (project: ProjectRow, floor: LocationRow, units: { name: string; code: string }[]) =>
  wrap(async () => {
    if (!units.length) throw new SetupError('אין דירות להוספה');
    const taken = new Set((await db.locations.where('project_id').equals(project.id).toArray()).filter((l) => l.parent_id === floor.id && !l.deleted_at).map((l) => l.name));
    const dup = units.find((u) => taken.has(u.name.trim()));
    if (dup) throw new SetupError(`"${dup.name}" כבר קיימת ב${floor.name}`);
    let order = await nextOrder(project.id);
    return insertRows<LocationRow>(
      'locations',
      units.map((u) => ({ id: crypto.randomUUID(), org_id: project.org_id, project_id: project.id, parent_id: floor.id, kind: 'unit', name: u.name.trim(), code: u.code.trim(), sort_order: order++ })),
    );
  });

export const renameLocation = (row: LocationRow, name: string, code: string) =>
  wrap(() => {
    if (!name.trim()) throw new SetupError('יש להזין שם');
    return updateRow('locations', row, { name: name.trim(), code: code.trim() });
  });

/** Moves a location one place up or down among its siblings (swaps sort order). */
export const moveLocation = (row: LocationRow, siblings: LocationRow[], dir: -1 | 1) =>
  wrap(async () => {
    const i = siblings.findIndex((s) => s.id === row.id);
    const other = siblings[i + dir];
    if (!other) return;
    await updateRow('locations', row, { sort_order: other.sort_order });
    await updateRow('locations', other, { sort_order: row.sort_order });
  });

/** The location and everything under it (live rows only). */
export function subtree(all: LocationRow[], id: string): LocationRow[] {
  const live = all.filter((l) => !l.deleted_at);
  const out: LocationRow[] = [];
  const walk = (pid: string) => {
    for (const l of live) if (l.parent_id === pid) (out.push(l), walk(l.id));
  };
  const self = live.find((l) => l.id === id);
  if (self) (out.push(self), walk(id));
  return out;
}

/** Findings on this device recorded in the location or under it (including ones not yet synced). */
export async function findingsUnder(projectId: string, locationIds: string[]) {
  const ids = new Set(locationIds);
  return db.findings.where('locationId').anyOf([...ids]).filter((f) => !f.deletedAt && f.projectId === projectId).count();
}

export const deleteLocation = (projectId: string, id: string) =>
  wrap(async () => {
    const tree = subtree(await db.locations.where('project_id').equals(projectId).toArray(), id);
    if (await findingsUnder(projectId, tree.map((l) => l.id))) throw new SetupError('יש ממצאים במיקום הזה או ביחידות שתחתיו, ולכן אי אפשר למחוק אותו.');
    // The server re-checks against every finding, including ones recorded on other devices.
    return softDelete<LocationRow>('locations', tree.map((l) => l.id));
  });

// ---------- Contractors ----------

export type ContractorFields = Pick<ContractorRow, 'name' | 'trade' | 'contact_name' | 'phone' | 'email'>;

const cleanContractor = (c: ContractorFields): ContractorFields => ({
  name: c.name.trim(),
  trade: c.trade.trim(),
  contact_name: c.contact_name.trim(),
  phone: c.phone.trim(),
  email: c.email.trim(),
});

export function validateContractor(c: ContractorFields): string | null {
  if (!c.name.trim()) return 'יש להזין שם קבלן';
  if (c.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email.trim())) return 'כתובת האימייל אינה תקינה';
  return null;
}

/** Adds the contractor to the project, reviving an earlier assignment if there was one. */
async function assign(project: ProjectRow, contractorId: string) {
  const existing = (await db.project_contractors.where('project_id').equals(project.id).toArray()).find((pc) => pc.contractor_id === contractorId);
  if (existing && !existing.deleted_at) return existing;
  if (existing) return updateRow<ProjectContractorRow>('project_contractors', existing, { deleted_at: null });
  const [row] = await insertRows<ProjectContractorRow>('project_contractors', [
    { id: crypto.randomUUID(), org_id: project.org_id, project_id: project.id, contractor_id: contractorId },
  ]);
  return row;
}

export const createContractor = (project: ProjectRow, fields: ContractorFields) =>
  wrap(async () => {
    const [row] = await insertRows<ContractorRow>('contractors', [{ id: crypto.randomUUID(), org_id: project.org_id, ...cleanContractor(fields) }]);
    await assign(project, row.id);
    return row;
  });

export const assignContractor = (project: ProjectRow, contractorId: string) => wrap(() => assign(project, contractorId));

export const updateContractor = (row: ContractorRow, fields: ContractorFields) => wrap(() => updateRow('contractors', row, cleanContractor(fields)));

/** Removes the contractor from this project only; past findings keep their contractor. */
export const unassignContractor = (project: ProjectRow, pc: ProjectContractorRow) =>
  wrap(async () => {
    await softDelete('project_contractors', [pc.id]);
    // Category defaults in this project that pointed at the contractor are cleared.
    const defaults = (await db.project_category_defaults.where('project_id').equals(project.id).toArray()).filter(
      (d) => !d.deleted_at && d.contractor_id === pc.contractor_id,
    );
    for (const d of defaults) await updateRow<CategoryDefaultRow>('project_category_defaults', d, { contractor_id: null });
  });

// ---------- Categories (shared by the organization's projects) ----------

export const normalizePhrases = (phrases: string[]) => [...new Set(phrases.map((p) => p.trim()).filter(Boolean))];

export const createCategory = (orgId: string, name: string, phrases: string[]) =>
  wrap(async () => {
    if (!name.trim()) throw new SetupError('יש להזין שם קטגוריה');
    const order = (await db.categories.toArray()).filter((c) => c.org_id === orgId).reduce((m, c) => Math.max(m, c.sort_order), 0) + 1;
    const [row] = await insertRows<CategoryRow>('categories', [
      { id: crypto.randomUUID(), org_id: orgId, name: name.trim(), phrases: normalizePhrases(phrases), sort_order: order },
    ]);
    return row;
  });

export const updateCategory = (row: CategoryRow, patch: { name?: string; phrases?: string[] }) =>
  wrap(() => {
    if (patch.name !== undefined && !patch.name.trim()) throw new SetupError('יש להזין שם קטגוריה');
    return updateRow('categories', row, {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.phrases ? { phrases: normalizePhrases(patch.phrases) } : {}),
    });
  });

/** Hides the category from capture in every project; findings that use it keep their category. */
export const deleteCategory = (row: CategoryRow) => wrap(() => softDelete('categories', [row.id]));

/** The default contractor for a category in one project (null: no default). */
export const setCategoryDefault = (project: ProjectRow, categoryId: string, contractorId: string | null) =>
  wrap(async () => {
    const existing = (await db.project_category_defaults.where('project_id').equals(project.id).toArray()).find((d) => d.category_id === categoryId);
    if (existing) return updateRow<CategoryDefaultRow>('project_category_defaults', existing, { contractor_id: contractorId, deleted_at: null });
    const [row] = await insertRows<CategoryDefaultRow>('project_category_defaults', [
      { id: crypto.randomUUID(), org_id: project.org_id, project_id: project.id, category_id: categoryId, contractor_id: contractorId },
    ]);
    return row;
  });
