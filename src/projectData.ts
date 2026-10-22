import { useLiveQuery } from 'dexie-react-hooks';
import { buildProjectModel, type ProjectModel } from '../shared/projectModel';
import { db, getMeta, type ProjectRow } from './db';

const byName = (a: ProjectRow, b: ProjectRow) => a.name.localeCompare(b.name, 'he');

/** The project chosen on this device (meta 'currentProjectId'), else the first active one. */
async function currentProject(): Promise<ProjectRow | null> {
  const projects = (await db.projects.toArray()).filter((p) => !p.deleted_at && p.status === 'active').sort(byName);
  if (!projects.length) return null;
  const chosen = await getMeta<string>('currentProjectId');
  return projects.find((p) => p.id === chosen) ?? projects[0];
}

/**
 * The current project's setup, from the local mirror of the server's data.
 * undefined while loading; null when no project has synced to this device yet.
 */
export function useProjectModel(): ProjectModel | null | undefined {
  return useLiveQuery(async () => {
    const project = await currentProject();
    if (!project) return null;
    const sameOrg = <T extends { org_id: string }>(rows: T[]) => rows.filter((r) => r.org_id === project.org_id);
    const [locations, categories, contractors, projectContractors, defaults] = await Promise.all([
      db.locations.where('project_id').equals(project.id).toArray(),
      db.categories.toArray().then(sameOrg),
      db.contractors.toArray().then(sameOrg),
      db.project_contractors.where('project_id').equals(project.id).toArray(),
      db.project_category_defaults.where('project_id').equals(project.id).toArray(),
    ]);
    return buildProjectModel({ project, locations, categories, contractors, projectContractors, defaults });
  }, []);
}

/** All projects on the device (archived included) and which one is current. */
export function useProjects() {
  return useLiveQuery(async () => {
    const all = (await db.projects.toArray()).filter((p) => !p.deleted_at).sort(byName);
    return { all, current: await currentProject() };
  }, []);
}
