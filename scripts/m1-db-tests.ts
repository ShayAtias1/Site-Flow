// M1 database tests: schema, RLS, storage and push_findings.
//   tsx scripts/m1-db-tests.ts local    — full suite against the local Supabase (`npx supabase start`).
//                                         Test users are created there with the local service key,
//                                         read from the CLI at runtime and never stored.
//   tsx scripts/m1-db-tests.ts hosted   — anonymous-only checks against VITE_SUPABASE_URL (.env.local).
import { execSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const TARGET = (process.argv[2] ?? 'local') as 'local' | 'hosted';
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const TABLES = [
  'orgs', 'memberships', 'projects', 'locations', 'categories', 'contractors', 'project_contractors',
  'project_category_defaults', 'tours', 'findings', 'finding_events', 'photos', 'reports', 'report_distributions',
];

function localEnv() {
  const s = JSON.parse(execSync('npx supabase status -o json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  return { url: s.API_URL as string, anon: (s.PUBLISHABLE_KEY ?? s.ANON_KEY) as string, service: (s.SECRET_KEY ?? s.SERVICE_ROLE_KEY) as string };
}

function hostedEnv() {
  const env = Object.fromEntries(
    readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
  return { url: env.VITE_SUPABASE_URL, anon: env.VITE_SUPABASE_PUBLISHABLE_KEY };
}

const client = (url: string, key: string) => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function anonymousChecks(url: string, anonKey: string) {
  const anon = client(url, anonKey);
  const readable: string[] = [];
  for (const t of TABLES) {
    const { data, error } = await anon.from(t).select('*').limit(1);
    if (!error && data && data.length > 0) readable.push(t);
  }
  check('אנונימי: אין קריאה מאף טבלה', readable.length === 0, readable.join(', '));
  const ins = await anon.from('projects').insert({ id: randomUUID(), org_id: randomUUID(), code: 'X', name: 'X' });
  check('אנונימי: אין כתיבה', !!ins.error, ins.error?.message);
  const rpc = await anon.rpc('push_findings', { p_changes: [] });
  check('אנונימי: אין גישה ל-push_findings', !!rpc.error, rpc.error?.message);
  const adm = await anon.rpc('admin_add_member', { p_email: 'x@example.com', p_org_name: 'x', p_role: 'owner' });
  check('אנונימי: אין גישה ל-admin_add_member', !!adm.error, adm.error?.message);
  const seed = await anon.rpc('admin_seed_demo_project', { p_org_name: 'x' });
  check('אנונימי: אין גישה ל-admin_seed_demo_project', !!seed.error, seed.error?.message);
  for (const [bucket, type, ext] of [['photos', 'image/jpeg', 'jpg'], ['reports', 'application/pdf', 'pdf']]) {
    const up = await anon.storage.from(bucket).upload(`${randomUUID()}/x.${ext}`, new Blob(['x'], { type }));
    check(`אנונימי: אין העלאה ל-${bucket}`, !!up.error && !/mime/i.test(up.error.message), up.error?.message);
  }
  const settings = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey } }).then((r) => r.json());
  check('הרשמה עצמית חסומה', settings.disable_signup === true, `disable_signup=${settings.disable_signup}`);
}

async function signedIn(url: string, anonKey: string, email: string, password: string) {
  const c = client(url, anonKey);
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return c;
}

async function seedOrg(c: SupabaseClient, org: string) {
  const ids = { project: randomUUID(), building: randomUUID(), unit: randomUUID(), category: randomUUID(), contractor: randomUUID(), tour: randomUUID() };
  const must = (r: { error: { message: string } | null }, what: string) => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
  };
  // Project codes are unique per organization (M3), and test organizations are reused between runs.
  must(await c.from('projects').insert({ id: ids.project, org_id: org, code: `T${randomBytes(3).toString('hex')}`, name: 'פרויקט בדיקה' }), 'project');
  must(await c.from('locations').insert({ id: ids.building, org_id: org, project_id: ids.project, kind: 'building', name: 'בניין A' }), 'building');
  must(await c.from('locations').insert({ id: ids.unit, org_id: org, project_id: ids.project, parent_id: ids.building, kind: 'unit', name: 'דירה 1' }), 'unit');
  must(await c.from('categories').insert({ id: ids.category, org_id: org, name: 'חשמל', phrases: ['חסר שקע'] }), 'category');
  must(await c.from('contractors').insert({ id: ids.contractor, org_id: org, name: 'לוי חשמל' }), 'contractor');
  // (M4) New findings may only name a contractor that is active in the project.
  must(await c.from('project_contractors').insert({ id: randomUUID(), org_id: org, project_id: ids.project, contractor_id: ids.contractor }), 'project contractor');
  must(await c.from('tours').insert({ id: ids.tour, org_id: org, project_id: ids.project, tour_date: '2026-10-22' }), 'tour');
  return ids;
}

const finding = (ids: Awaited<ReturnType<typeof seedOrg>>, extra: Record<string, unknown> = {}) => ({
  projectId: ids.project, tourId: ids.tour, locationId: ids.unit, locationDetail: 'מטבח', categoryId: ids.category,
  contractorId: ids.contractor, classification: 'missing', status: 'open', description: 'חסר שקע 16A', photoIds: [], deletedAt: null, ...extra,
});
const change = (id: string, baseVersion: number, data: Record<string, unknown>) => ({ id, baseVersion, createdAt: new Date().toISOString(), data });

async function localSuite() {
  const { url, anon: anonKey, service } = localEnv();
  await anonymousChecks(url, anonKey);

  // Test users exist only in the local stack; passwords are random per run.
  const admin = client(url, service);
  const users: Record<string, { email: string; password: string }> = {};
  for (const name of ['engineerA', 'ownerB', 'viewerA', 'outsider']) {
    const email = `${name.toLowerCase()}-${randomBytes(4).toString('hex')}@siteflow.test`;
    const password = randomBytes(18).toString('base64url');
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`create ${name}: ${error.message}`);
    users[name] = { email, password };
  }
  // Fresh organizations per run, so counts and numbers never depend on earlier runs.
  const run = randomBytes(3).toString('hex');
  const ORG_A = `ארגון A ${run}`;
  const orgA = (await admin.rpc('admin_add_member', { p_email: users.engineerA.email, p_org_name: ORG_A, p_role: 'engineer' })).data as string;
  await admin.rpc('admin_add_member', { p_email: users.viewerA.email, p_org_name: ORG_A, p_role: 'viewer' });
  const orgB = (await admin.rpc('admin_add_member', { p_email: users.ownerB.email, p_org_name: `ארגון B ${run}`, p_role: 'owner' })).data as string;
  check('admin_add_member יוצר ארגון וחברות', !!orgA && !!orgB && orgA !== orgB);
  const demo = await admin.rpc('admin_seed_demo_project', { p_org_name: ORG_A });
  const demoAgain = await admin.rpc('admin_seed_demo_project', { p_org_name: ORG_A });
  const demoLocs = await admin.from('locations').select('id', { count: 'exact', head: true }).eq('project_id', demo.data);
  const demoDefaults = await admin.from('project_category_defaults').select('id', { count: 'exact', head: true }).eq('project_id', demo.data);
  check('פרויקט הדגמה נוצר (52 מיקומים, 9 ברירות מחדל) והרצה חוזרת לא משכפלת',
    !demo.error && demo.data === demoAgain.data && demoLocs.count === 52 && demoDefaults.count === 9,
    `${demoLocs.count} מיקומים, ${demoDefaults.count} ברירות מחדל`);

  const signup = await client(url, anonKey).auth.signUp({ email: `new-${randomBytes(3).toString('hex')}@siteflow.test`, password: randomBytes(12).toString('hex') });
  check('signUp נחסם בפועל', !!signup.error, signup.error?.message);

  const A = await signedIn(url, anonKey, users.engineerA.email, users.engineerA.password);
  const V = await signedIn(url, anonKey, users.viewerA.email, users.viewerA.password);
  const B = await signedIn(url, anonKey, users.ownerB.email, users.ownerB.password);
  const X = await signedIn(url, anonKey, users.outsider.email, users.outsider.password);

  const seedByUser = await A.rpc('admin_seed_demo_project', { p_org_name: ORG_A });
  check('משתמש רגיל לא יכול להריץ admin_seed_demo_project', !!seedByUser.error, seedByUser.error?.message);
  const ids = await seedOrg(A, orgA);
  const idsB = await seedOrg(B, orgB);
  check('מהנדס יוצר פרויקט, מיקומים, קטגוריה, קבלן וסיור בארגון שלו', true);

  // push_findings: numbering, versions, conflicts, per-record errors.
  const f1 = randomUUID();
  const f2 = randomUUID();
  let r = (await A.rpc('push_findings', { p_changes: [change(f1, 0, finding(ids)), change(f2, 0, finding(ids, { description: 'שני' }))] })).data;
  check('push_findings: יצירה ומספור רץ מהשרת', r?.[0]?.status === 'ok' && r[0].row.displayNo === 1 && r[1].row.displayNo === 2, JSON.stringify(r?.map((x: { row: { displayNo: number } }) => x.row?.displayNo)));
  r = (await A.rpc('push_findings', { p_changes: [change(f1, 1, finding(ids, { status: 'reported_done' }))] })).data;
  check('עדכון עם גרסה נכונה מעלה גרסה', r?.[0]?.status === 'ok' && r[0].row.version === 2);
  r = (await A.rpc('push_findings', { p_changes: [change(f1, 1, finding(ids, { description: 'עריכה ישנה' }))] })).data;
  check('עדכון על גרסה ישנה מחזיר התנגשות בלי לדרוס', r?.[0]?.status === 'conflict' && r[0].row.description === 'חסר שקע 16A' && r[0].row.version === 2);
  const good1 = randomUUID();
  const good2 = randomUUID();
  r = (await A.rpc('push_findings', {
    p_changes: [
      change(good1, 0, finding(ids)),
      change(randomUUID(), 4, finding(ids)), // unknown record with a base version
      change(randomUUID(), 0, finding(ids, { locationId: idsB.unit })), // location of another org
      change(good2, 0, finding(ids)),
    ],
  })).data;
  check('רשומות פגומות לא מבטלות את האצווה', r?.map((x: { status: string }) => x.status).join() === 'ok,error,error,ok', r?.map((x: { status: string; error?: string }) => x.error ?? x.status).join(' | '));
  const nums = (await A.from('findings').select('display_no').order('display_no')).data?.map((x) => x.display_no);
  check('אין חורים או כפילויות במספור אחרי שגיאות', nums?.join() === '1,2,3,4', nums?.join());
  const events = (await A.from('finding_events').select('type').eq('finding_id', f1)).data?.map((e) => e.type);
  check('היסטוריה: יצירה ושינוי סטטוס נרשמו', !!events?.includes('created') && !!events?.includes('status_changed'), events?.join());
  r = (await A.rpc('push_findings', { p_changes: [change(f1, 2, finding(ids, { status: 'closed' }))] })).data;
  const closed = (await A.from('findings').select('closed_at, closed_by').eq('id', f1).single()).data;
  check('סגירה נרשמת עם מי ומתי', !!closed?.closed_at && !!closed?.closed_by);

  // Direct writes that would bypass versioning or numbering.
  const direct = await A.from('findings').insert({ id: randomUUID(), org_id: orgA, project_id: ids.project, display_no: 99, location_id: ids.unit, description: 'x', created_at: new Date().toISOString() });
  check('אין כתיבה ישירה לטבלת findings', !!direct.error, direct.error?.message);
  const directUpd = await A.from('findings').update({ description: 'דריסה' }).eq('id', f1).select();
  check('אין עדכון ישיר לטבלת findings', !!directUpd.error || directUpd.data?.length === 0, directUpd.error?.message);
  const tamper = await A.from('project_counters').update({ next_finding_no: 1 }).eq('project_id', ids.project);
  const peek = await A.from('project_counters').select('*');
  check('אי אפשר לקרוא או לשנות את מונה המספור', !!tamper.error && !!peek.error, tamper.error?.message);
  const projVersion = (await A.from('projects').select('version').eq('id', ids.project).single()).data?.version;
  check('יצירת ממצאים לא משנה את גרסת הפרויקט', projVersion === 1, `version=${projVersion}`);
  const del = await A.from('locations').delete().eq('id', ids.unit).select();
  check('אין מחיקה פיזית', !!del.error || del.data?.length === 0, del.error?.message);

  // Optimistic lock on setup tables.
  const p1 = await A.from('projects').update({ name: 'שם חדש' }).eq('id', ids.project).eq('version', 1).select('version').single();
  const p2 = await A.from('projects').update({ name: 'עריכה ישנה' }).eq('id', ids.project).eq('version', 1).select();
  check('נעילה אופטימית: עריכה ישנה של פרויקט לא מתבצעת', p1.data?.version === 2 && p2.data?.length === 0, JSON.stringify({ p1: p1.data ?? p1.error?.message, p2: p2.data ?? p2.error?.message }));

  // M3 — project setup rules.
  const code = (await A.from('projects').select('code').eq('id', ids.project).single()).data!.code as string;
  const dupCode = await A.from('projects').insert({ id: randomUUID(), org_id: orgA, code: code.toLowerCase(), name: 'כפילות' });
  check('M3: קוד פרויקט ייחודי בארגון (גם באותיות קטנות)', dupCode.error?.code === '23505', dupCode.error?.message);
  const otherOrgSameCode = await B.from('projects').insert({ id: randomUUID(), org_id: orgB, code, name: 'אותו קוד בארגון אחר' });
  check('M3: אותו קוד מותר בארגון אחר', !otherOrgSameCode.error, otherOrgSameCode.error?.message);
  const proj2 = randomUUID();
  await A.from('projects').insert({ id: proj2, org_id: orgA, code: `P${randomBytes(3).toString('hex')}`, name: 'פרויקט שני' });
  const b2 = randomUUID();
  const f1b = randomUUID();
  const gen = await A.from('locations').insert([
    { id: b2, org_id: orgA, project_id: proj2, kind: 'building', name: 'בניין C', sort_order: 1 },
    { id: f1b, org_id: orgA, project_id: proj2, parent_id: b2, kind: 'floor', name: 'קומה 1', sort_order: 2 },
    ...[1, 2, 3, 4].map((n) => ({ id: randomUUID(), org_id: orgA, project_id: proj2, parent_id: f1b, kind: 'unit', name: `דירה ${n}`, sort_order: 2 + n })),
  ]).select('id');
  check('M3: בניין שלם נוצר בבקשה אחת (הורים וילדים יחד)', !gen.error && gen.data?.length === 6, gen.error?.message);
  const badBatch = await A.from('locations').insert([
    { id: randomUUID(), org_id: orgA, project_id: proj2, kind: 'building', name: 'בניין D' },
    { id: randomUUID(), org_id: orgA, project_id: proj2, parent_id: ids.building, kind: 'floor', name: 'קומה זרה' },
  ]);
  const dLeft = (await A.from('locations').select('id').eq('project_id', proj2).eq('name', 'בניין D')).data ?? [];
  check('M3: מיקום לא יכול להיות תחת הורה מפרויקט אחר, והבקשה כולה נדחית', !!badBatch.error && dLeft.length === 0, badBatch.error?.message);
  const moveProj = await A.from('locations').update({ project_id: proj2 }).eq('id', ids.unit).select();
  check('M3: מיקום לא עובר בין פרויקטים', !!moveProj.error || moveProj.data?.length === 0, moveProj.error?.message);
  const delUnit = await A.from('locations').update({ deleted_at: new Date().toISOString() }).eq('id', ids.unit).select();
  check('M3: אי אפשר למחוק מיקום שיש בו ממצאים', delUnit.error?.hint === 'has_findings', delUnit.error?.message);
  const delBuilding = await A.from('locations').update({ deleted_at: new Date().toISOString() }).in('id', [ids.building, ids.unit]).select();
  check('M3: אי אפשר למחוק בניין שיש ממצאים ביחידות שלו', !!delBuilding.error, delBuilding.error?.message);
  const stillLive = (await A.from('locations').select('deleted_at').in('id', [ids.building, ids.unit])).data ?? [];
  check('M3: אחרי סירוב, הבניין והיחידה נשארו פעילים', stillLive.length === 2 && stillLive.every((l) => !l.deleted_at));
  const proj2Locs = (await A.from('locations').select('id').eq('project_id', proj2)).data!.map((l) => l.id);
  const delEmpty = await A.from('locations').update({ deleted_at: new Date().toISOString() }).in('id', proj2Locs).select('id');
  check('M3: מחיקת בניין ריק (כולל קומות ודירות) מצליחה', !delEmpty.error && delEmpty.data?.length === 6, delEmpty.error?.message);
  const vLoc = await V.from('locations').update({ name: 'צופה משנה' }).eq('id', ids.unit).select();
  const vProj = await V.from('projects').insert({ id: randomUUID(), org_id: orgA, code: `V${randomBytes(3).toString('hex')}`, name: 'x' });
  check('M3: צופה לא יכול לשנות מבנה או ליצור פרויקט', (vLoc.data?.length ?? 0) === 0 && !!vProj.error);

  // M4 — tours, history, active contractors.
  const outsiderCon = randomUUID();
  await A.from('contractors').insert({ id: outsiderCon, org_id: orgA, name: 'קבלן שלא בפרויקט' });
  const nf = randomUUID();
  r = (await A.rpc('push_findings', { p_changes: [change(nf, 0, finding(ids, { contractorId: outsiderCon }))] })).data;
  check('M4: ממצא חדש עם קבלן שאינו פעיל בפרויקט נדחה', r?.[0]?.status === 'error' && /אינו פעיל/.test(r[0].error), r?.[0]?.error?.slice(0, 60));
  const hist = randomUUID();
  const tourEv = randomUUID();
  const at = new Date(Date.now() - 3 * 3600_000).toISOString();
  r = (await A.rpc('push_findings', {
    p_changes: [{ ...change(hist, 0, finding(ids)), events: [{ id: tourEv, type: 'created', at, tourId: ids.tour, from: null, to: { status: 'open' }, note: '' }] }],
  })).data;
  let ev = (await A.from('finding_events').select('*').eq('finding_id', hist)).data ?? [];
  check('M4: אירוע מהמכשיר נשמר עם הזמן שבו קרה, הסיור והמשתמש', ev.length === 1 && ev[0].id === tourEv && new Date(ev[0].at).toISOString() === at && ev[0].tour_id === ids.tour && !!ev[0].actor_id, JSON.stringify(ev[0] ?? {}).slice(0, 120));
  // The contractor leaves the project; the finding keeps it when edited for anything else.
  await A.from('project_contractors').update({ deleted_at: new Date().toISOString() }).eq('project_id', ids.project).eq('contractor_id', ids.contractor);
  const future = new Date(Date.now() + 86400_000).toISOString();
  const evStatus = randomUUID();
  r = (await A.rpc('push_findings', {
    p_changes: [{ ...change(hist, 1, finding(ids, { status: 'reported_done' })), events: [{ id: evStatus, type: 'status_changed', at: future, tourId: idsB.tour, from: { status: 'open' }, to: { status: 'reported_done' }, note: '' }] }],
  })).data;
  check('M4: עריכת ממצא קיים שומרת קבלן היסטורי שהוסר מהפרויקט', r?.[0]?.status === 'ok' && r[0].row.contractorId === ids.contractor, r?.[0]?.error);
  ev = (await A.from('finding_events').select('*').eq('id', evStatus)).data ?? [];
  check('M4: זמן עתידי נחתך לזמן השרת, וסיור של פרויקט אחר לא נרשם', ev.length === 1 && new Date(ev[0].at).getTime() < Date.now() + 60_000 && ev[0].tour_id === null, JSON.stringify({ at: ev[0]?.at, now: new Date().toISOString(), tour: ev[0]?.tour_id }));
  r = (await A.rpc('push_findings', { p_changes: [change(hist, 2, finding(ids, { status: 'reported_done', contractorId: outsiderCon }))] })).data;
  check('M4: החלפת קבלן לקבלן שאינו פעיל בפרויקט נדחית', r?.[0]?.status === 'error');
  await A.from('project_contractors').update({ deleted_at: null }).eq('project_id', ids.project).eq('contractor_id', ids.contractor);
  // A lost response: the same events are sent again with the next version — stored once.
  r = (await A.rpc('push_findings', {
    p_changes: [{ ...change(hist, 2, finding(ids, { status: 'reported_done', description: 'תיאור מעודכן' })), events: [{ id: evStatus, type: 'status_changed', at, tourId: ids.tour, from: null, to: null, note: '' }] }],
  })).data;
  ev = (await A.from('finding_events').select('id').eq('finding_id', hist)).data ?? [];
  check('M4: אירוע שנשלח פעמיים נשמר פעם אחת', r?.[0]?.status === 'ok' && ev.length === 2, `${ev.length} אירועים`);
  // An older app version sends no events: the server derives them.
  r = (await A.rpc('push_findings', { p_changes: [change(hist, 3, finding(ids, { status: 'reported_done', description: 'תיאור מעודכן', deletedAt: new Date().toISOString() }))] })).data;
  const derived = ((await A.from('finding_events').select('type').eq('finding_id', hist)).data ?? []).map((e) => e.type);
  check('M4: לקוח ישן — השרת גוזר היסטוריה (מחיקה)', r?.[0]?.status === 'ok' && derived.includes('deleted'), derived.join());
  r = (await A.rpc('push_findings', { p_changes: [change(hist, 4, finding(ids, { status: 'reported_done', description: 'תיאור מעודכן' }))] })).data;
  const restored = ((await A.from('finding_events').select('type').eq('finding_id', hist)).data ?? []).map((e) => e.type);
  check('M4: שחזור ממצא שנמחק נרשם בהיסטוריה', r?.[0]?.status === 'ok' && r[0].row.deletedAt === null && restored.includes('restored'), restored.join());
  const seqs = ((await A.from('finding_events').select('seq').eq('finding_id', hist).order('seq')).data ?? []).map((e) => e.seq);
  check('M4: לאירועים יש סמן משיכה עולה', seqs.length >= 4 && seqs.every((x, i) => i === 0 || x > seqs[i - 1]));
  const t1 = (await A.from('tours').update({ notes: 'הערה' }).eq('id', ids.tour).eq('version', 1).select('version')).data;
  const t2 = (await A.from('tours').update({ notes: 'ישנה' }).eq('id', ids.tour).eq('version', 1).select('version')).data;
  check('M4: סיור — נעילה אופטימית', t1?.[0]?.version === 2 && t2?.length === 0);
  const vTour = await V.from('tours').insert({ id: randomUUID(), org_id: orgA, project_id: ids.project, tour_date: '2026-10-23' });
  check('M4: צופה לא יכול לפתוח סיור', !!vTour.error);
  const evDirect = await A.from('finding_events').insert({ org_id: orgA, finding_id: hist, type: 'comment' });
  check('M4: אין כתיבה ישירה להיסטוריה (רק דרך push_findings)', !!evDirect.error);

  // M5 — one finding per location in a batch; photos added later.
  const unit2 = randomUUID();
  await A.from('locations').insert({ id: unit2, org_id: orgA, project_id: ids.project, parent_id: ids.building, kind: 'unit', name: 'דירה 2' });
  const batch = randomUUID();
  const bf1 = randomUUID();
  const bf2 = randomUUID();
  const batchChanges = [change(bf1, 0, finding(ids, { batchId: batch })), change(bf2, 0, finding(ids, { batchId: batch, locationId: unit2 }))];
  r = (await A.rpc('push_findings', { p_changes: batchChanges })).data;
  const again = (await A.rpc('push_findings', { p_changes: batchChanges })).data;
  const inBatch = (await A.from('findings').select('id, display_no, location_id').eq('batch_id', batch)).data ?? [];
  check('M5: קבוצה — ממצא לכל מיקום, עם מספר משלו', r?.every((x: { status: string }) => x.status === 'ok') && inBatch.length === 2 && inBatch[0].display_no !== inBatch[1].display_no && inBatch[0].location_id !== inBatch[1].location_id);
  check('M5: שליחה חוזרת של אותה קבוצה (תשובה שאבדה) לא יוצרת כפילויות', again?.every((x: { status: string }) => x.status === 'conflict') && inBatch.length === 2, again?.map((x: { status: string }) => x.status).join());
  const photoId = randomUUID();
  const ppath = `${orgA}/${ids.project}/${photoId}.jpg`;
  await A.storage.from('photos').upload(ppath, new Blob([randomBytes(1024)], { type: 'image/jpeg' }));
  r = (await A.rpc('push_findings', {
    p_changes: [{ ...change(bf2, 1, finding(ids, { batchId: batch, locationId: unit2, photoIds: [photoId] })), events: [{ id: randomUUID(), type: 'photo_added', at: new Date().toISOString(), tourId: ids.tour, from: null, to: { photo_id: photoId }, note: '' }] }],
  })).data;
  const prow = await A.from('photos').insert({ id: photoId, org_id: orgA, finding_id: bf2, storage_path: ppath, size: 1024, sha256: 'x', kind: 'progress' }).select('kind').single();
  const pev = (await A.from('finding_events').select('type, tour_id').eq('finding_id', bf2).eq('type', 'photo_added')).data ?? [];
  const sibling = (await A.from('findings').select('photo_ids').eq('id', bf1).single()).data;
  check('M5: תמונה שנוספה לממצא קיים — נרשמה בהיסטוריה עם הסיור, ולא שינתה את הממצא האח בקבוצה',
    r?.[0]?.status === 'ok' && prow.data?.kind === 'progress' && pev.length === 1 && pev[0].tour_id === ids.tour && (sibling?.photo_ids ?? []).length === 0);

  // Isolation between organizations and roles.
  const bSees = (await B.from('findings').select('id').eq('project_id', ids.project)).data ?? [];
  const bProj = (await B.from('projects').select('id').eq('id', ids.project)).data ?? [];
  check('ארגון B לא רואה נתונים של ארגון A', bSees.length === 0 && bProj.length === 0);
  const bUpd = await B.from('projects').update({ name: 'פריצה' }).eq('id', ids.project).select();
  check('ארגון B לא יכול לשנות פרויקט של ארגון A', (bUpd.data?.length ?? 0) === 0);
  r = (await B.rpc('push_findings', { p_changes: [change(randomUUID(), 0, finding(ids))] })).data;
  check('ארגון B לא יכול ליצור ממצא בפרויקט של A', r?.[0]?.status === 'error', r?.[0]?.error);
  r = (await B.rpc('push_findings', { p_changes: [change(f2, 1, finding(ids, { description: 'פריצה' }))] })).data;
  check('ארגון B לא יכול לערוך ממצא של A', r?.[0]?.status === 'error');
  const bInsertIntoA = await B.from('locations').insert({ id: randomUUID(), org_id: orgA, project_id: ids.project, kind: 'unit', name: 'x' });
  check('ארגון B לא יכול להוסיף מיקום לארגון A', !!bInsertIntoA.error);
  const bSmuggle = await B.from('locations').insert({ id: randomUUID(), org_id: orgB, project_id: ids.project, kind: 'unit', name: 'x' });
  check('אי אפשר לשייך מיקום לפרויקט של ארגון אחר', !!bSmuggle.error, bSmuggle.error?.message);
  const xAll = await Promise.all(TABLES.map((t) => X.from(t).select('*').limit(1)));
  check('משתמש מחובר ללא ארגון לא רואה כלום', xAll.every((q) => (q.data?.length ?? 0) === 0));
  const vRead = (await V.from('findings').select('id')).data ?? [];
  r = (await V.rpc('push_findings', { p_changes: [change(randomUUID(), 0, finding(ids))] })).data;
  const vIns = await V.from('contractors').insert({ id: randomUUID(), org_id: orgA, name: 'x' });
  check('צופה: קורא את נתוני הארגון', vRead.length === 7);
  check('צופה: לא יכול לכתוב', r?.[0]?.status === 'error' && !!vIns.error);

  // Storage: private, org-scoped, write-once.
  const jpeg = new Blob([randomBytes(2048)], { type: 'image/jpeg' });
  const path = `${orgA}/${ids.project}/${randomUUID()}.jpg`;
  const up = await A.storage.from('photos').upload(path, jpeg);
  check('העלאת תמונה לנתיב הארגון', !up.error, up.error?.message);
  const own = await A.storage.from('photos').download(path);
  check('בעל הארגון מוריד את התמונה', !own.error && (own.data?.size ?? 0) === 2048);
  const other = await B.storage.from('photos').download(path);
  check('ארגון אחר לא יכול להוריד את התמונה', !!other.error);
  const signedB = await B.storage.from('photos').createSignedUrl(path, 60);
  check('ארגון אחר לא יכול ליצור קישור חתום', !!signedB.error || !signedB.data?.signedUrl);
  const overwrite = await A.storage.from('photos').upload(path, jpeg, { upsert: true });
  check('אי אפשר לדרוס תמונה קיימת', !!overwrite.error, overwrite.error?.message);
  const rm = await A.storage.from('photos').remove([path]);
  const stillThere = await A.storage.from('photos').download(path);
  check('אי אפשר למחוק תמונה', (rm.data?.length ?? 0) === 0 && !stillThere.error);
  const bIntoA = await B.storage.from('photos').upload(`${orgA}/${randomUUID()}.jpg`, jpeg);
  check('ארגון אחר לא יכול להעלות לנתיב של A', !!bIntoA.error);
  const pub = await fetch(`${url}/storage/v1/object/public/photos/${path}`);
  check('הדלי אינו ציבורי', pub.status >= 400, `HTTP ${pub.status}`);

  // Reports: insert once, never change.
  const reportId = randomUUID();
  const rep = await A.from('reports').insert({
    id: reportId, org_id: orgA, project_id: ids.project, number: 'T-T-001', format: 'table', title: 'דוח', scope: { type: 'project' },
    finding_count: 4, snapshot: { findings: [] }, pdf_path: `${orgA}/${reportId}.pdf`, pdf_sha256: 'x', pdf_bytes: 1,
  });
  check('הנפקת דוח', !rep.error, rep.error?.message);
  const repUpd = await A.from('reports').update({ title: 'שונה' }).eq('id', reportId).select();
  check('אי אפשר לשנות דוח שהונפק', !!repUpd.error || repUpd.data?.length === 0);
  const pdf = new Blob([randomBytes(512)], { type: 'application/pdf' });
  await A.storage.from('reports').upload(`${orgA}/${reportId}.pdf`, pdf);
  const pdfOver = await A.storage.from('reports').upload(`${orgA}/${reportId}.pdf`, pdf, { upsert: true });
  check('אי אפשר לדרוס PDF שהונפק', !!pdfOver.error);

  // Session revocation: a signed-out refresh token no longer works.
  const session = (await A.auth.getSession()).data.session!;
  await admin.auth.admin.signOut(session.access_token, 'global');
  const fresh = client(url, anonKey);
  const refresh = await fresh.auth.refreshSession({ refresh_token: session.refresh_token });
  check('טוקן רענון שבוטל לא מחדש סשן', !!refresh.error, refresh.error?.message);

  for (const u of Object.values(users)) {
    const id = (await admin.auth.admin.listUsers()).data.users.find((x) => x.email === u.email)?.id;
    if (id) await admin.auth.admin.deleteUser(id, true);
  }
}

try {
  if (TARGET === 'hosted') {
    const { url, anon } = hostedEnv();
    console.log(`\n=== M1 hosted checks (anonymous only) — ${new URL(url).host} ===\n`);
    await anonymousChecks(url, anon);
  } else {
    console.log('\n=== M1 database tests — local Supabase ===\n');
    await localSuite();
  }
} catch (e) {
  check('הרצת הבדיקות', false, (e as Error).stack ?? String(e));
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed (${TARGET})`);
process.exit(failed ? 1 : 0);
