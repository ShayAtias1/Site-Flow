// M4 acceptance tests: tours, finding history, full editing, soft delete/restore, offline work — and the
// two M3 follow-ups (a draft per project; no new finding with a contractor that is not active).
// Runs against the local Supabase (`npx supabase start`) with throwaway users, like poc-tests.ts.
// Usage: tsx scripts/m4-tests.ts [chromium|webkit]
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright';

const ENGINE = (process.argv[2] ?? 'chromium') as 'chromium' | 'webkit';
const engine = ENGINE === 'webkit' ? webkit : chromium;
const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const ROOT = new URL('../', import.meta.url).pathname;
const OUT = `${ROOT}poc-output/m4-${ENGINE}/`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sb = JSON.parse(execSync('npx supabase status -o json', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
const SB_URL: string = sb.API_URL;
const SB_ANON: string = sb.PUBLISHABLE_KEY ?? sb.ANON_KEY;
const sbAdmin = createClient(SB_URL, sb.SECRET_KEY ?? sb.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const DIST = `${ROOT}dist-test-m4`;
let server: ChildProcess | undefined;
async function startServer() {
  if (await fetch(`${BASE}/api/health`).then(() => true, () => false)) throw new Error(`port ${PORT} is already in use`);
  server = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SITEFLOW_TEST: '1', SITEFLOW_DIST: DIST, SITEFLOW_SUPABASE_URL: SB_URL, SITEFLOW_SUPABASE_KEY: SB_ANON },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}

/** WebKit cannot emulate offline for service-worker pages; the test server drops the device instead. */
async function setOffline(ctx: BrowserContext, page: Page, offline: boolean) {
  const device = await page.evaluate(() => localStorage.getItem('sf.installId'));
  await fetch(`${BASE}/api/__test/offline`, { method: 'POST', body: JSON.stringify({ device, offline }) });
  if (ENGINE === 'chromium') await ctx.setOffline(offline);
}

const tab = (p: Page, name: string) => p.locator('nav.tabs button', { hasText: name }).click();
const view = (p: Page, name: string) => p.locator('.view-tabs button', { hasText: name }).click();
const shot = (p: Page, name: string) => p.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
const toastDone = async (p: Page) => {
  await p.locator('.toast').waitFor();
  await p.locator('.toast').waitFor({ state: 'detached' });
};
async function sync(p: Page) {
  await tab(p, 'הגדרות');
  const n = await p.locator('.log div').count();
  await p.getByRole('button', { name: 'סנכרן עכשיו' }).click();
  await p.locator('.log div').nth(n).waitFor({ timeout: 60000 });
  return (await p.locator('.log div').first().textContent()) ?? '';
}
async function capture(p: Page, desc: string, category = 'חשמל') {
  await p.locator('.chips .chip', { hasText: category }).first().click();
  await p.locator('#capture-desc').fill(desc);
  await p.getByRole('button', { name: 'שמור והמשך' }).click();
  await toastDone(p);
}
const findingsOnServer = async (projectId: string) =>
  ((await sbAdmin.from('findings').select('*').eq('project_id', projectId).order('display_no')).data ?? []) as {
    id: string; description: string; tour_id: string | null; status: string; category_id: string | null; contractor_id: string | null;
    location_id: string; classification: string; deleted_at: string | null; display_no: number;
  }[];


/** "הפרויקטים שלי" (the projects home), and a project's management view from it. */
async function projectsHome(p: Page) {
  await p.locator('nav.tabs button', { hasText: 'פרויקטים' }).click();
  await p.locator('.projects-home, .back-link').first().waitFor();
  const back = p.locator('.back-link');
  if (await back.isVisible().catch(() => false)) await back.click();
  await p.locator('.projects-home').waitFor();
}
async function manageProject(p: Page, name: string) {
  await projectsHome(p);
  await p.locator('.ph-card', { hasText: name }).getByRole('button', { name: /^ניהול/ }).click();
  await p.locator('.setup-tabs').waitFor();
}
async function main() {
  console.log(`\n=== SiteFlow M4 tests (tours, history) — engine: ${ENGINE} ===\n`);
  execSync(`npx vite build --outDir ${DIST} --emptyOutDir`, { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: `${BASE}/sb`, VITE_SUPABASE_PUBLISHABLE_KEY: SB_ANON, VITE_TEST_HOOKS: "1" } });
  await startServer();

  const email = `m4-${randomBytes(4).toString('hex')}@siteflow.test`;
  const password = randomBytes(18).toString('base64url');
  const created = await sbAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const orgName = `ארגון M4 ${randomBytes(3).toString('hex')}`;
  const orgId = (await sbAdmin.rpc('admin_add_member', { p_email: email, p_org_name: orgName, p_role: 'engineer' })).data as string;
  const demoId = (await sbAdmin.rpc('admin_seed_demo_project', { p_org_name: orgName })).data as string;
  // A second project with one location and one contractor, set up as an admin would (M3 screens are tested elsewhere).
  const otherId = randomUUID();
  await sbAdmin.from('projects').insert({ id: otherId, org_id: orgId, code: 'OTH', name: 'פרויקט שני' });
  const otherBuilding = randomUUID();
  await sbAdmin.from('locations').insert([
    { id: otherBuilding, org_id: orgId, project_id: otherId, kind: 'building', name: 'בניין יחיד', sort_order: 1 },
    { id: randomUUID(), org_id: orgId, project_id: otherId, parent_id: otherBuilding, kind: 'common', name: 'לובי', sort_order: 2 },
  ]);
  // A finding recorded before tours existed (an older app version: no tour, no events).
  const loc = (await sbAdmin.from('locations').select('id').eq('project_id', demoId).eq('kind', 'unit').limit(1)).data![0].id;
  const userClient = createClient(SB_URL, SB_ANON, { auth: { persistSession: false } });
  await userClient.auth.signInWithPassword({ email, password });
  const oldId = randomUUID();
  await userClient.rpc('push_findings', {
    p_changes: [{ id: oldId, baseVersion: 0, createdAt: new Date().toISOString(), data: { projectId: demoId, tourId: null, batchId: null, locationId: loc, locationDetail: '', categoryId: null, contractorId: null, classification: 'missing', status: 'open', description: 'ממצא מלפני הסיורים', photoIds: [], deletedAt: null } }],
  });

  const ctx = await engine.launchPersistentContext(`${OUT}profile-a`, { viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow' });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  await p.goto(BASE);
  await p.locator('.login-card input[type=email]').fill(email);
  await p.locator('.login-card input[type=password]').fill(password);
  await p.locator('.login-card button[type=submit]').click();

  // Two projects and none chosen yet: the app opens on "הפרויקטים שלי"; open the demo project.
  await p.locator('.projects-home').waitFor({ timeout: 30000 });
  await p.locator('.ph-card', { hasText: 'מגדלי הפארק' }).getByRole('button', { name: /^פתח/ }).click();

  // 1. Capture starts with a tour.
  await p.locator('.start-tour').waitFor({ timeout: 30000 });
  check('אין תיעוד בלי סיור: מוצג טופס פתיחת סיור', (await p.getByText('שמור והמשך').count()) === 0);
  const kind = await p.locator('.start-tour .seg button.on').textContent();
  check('סיור ראשון בפרויקט מוצע כ"סיור ראשוני" עם תאריך היום', kind === 'סיור ראשוני' && !!(await p.locator('.start-tour input[type=date]').inputValue()), kind ?? '');
  await p.locator('.start-tour').getByRole('button', { name: '+ משתתף' }).click();
  await p.getByLabel('משתתף 1: שם').fill('דני כהן');
  await p.getByLabel('משתתף 1: תפקיד').fill('מפקח');
  await p.locator('.start-tour').getByRole('button', { name: '+ משתתף' }).click();
  await p.getByLabel('משתתף 2: שם').fill('רונית לוי');
  await p.getByLabel('משתתף 2: תפקיד').fill('נציג היזם');
  await p.locator('.start-tour textarea').fill('סיור לפני מסירה');
  await shot(p, '1-start-tour');
  await p.getByRole('button', { name: 'התחל סיור' }).click();
  await p.getByText('שמור והמשך').waitFor();
  const strip = await p.locator('.tour-strip').textContent();
  check('סיור נפתח והתיעוד מציג את הסיור הפעיל', !!strip?.includes('סיור ראשוני') && strip.includes('0 ממצאים בסיור'), strip ?? '');

  // 2. Findings belong to the tour.
  await capture(p, 'חסר שקע בסלון');
  await capture(p, 'חסר רובה במטבח', 'ריצוף');
  check('מונה הממצאים בסיור', !!(await p.locator('.tour-strip').textContent())?.includes('2 ממצאים בסיור'));
  await sync(p);
  const tourRow = (await sbAdmin.from('tours').select('*').eq('project_id', demoId)).data![0];
  check('הסיור נשמר בשרת עם תאריך, סוג, משתתפים והערות', tourRow?.kind === 'initial' && tourRow.participants.length === 2 && tourRow.participants[0].name === 'דני כהן' && tourRow.notes === 'סיור לפני מסירה', JSON.stringify(tourRow?.participants));
  let srv = await findingsOnServer(demoId);
  const inTour = srv.filter((f) => f.tour_id === tourRow.id);
  check('כל ממצא חדש משויך לסיור שבו נוצר', inTour.length === 2, `${inTour.length}/2`);
  check('ממצא מלפני הסיורים נשאר ללא סיור (לא שויך בדיעבד)', srv.find((f) => f.id === oldId)?.tour_id === null);
  const createdEv = (await sbAdmin.from('finding_events').select('*').in('finding_id', inTour.map((f) => f.id)).eq('type', 'created')).data ?? [];
  check('אירוע "נוצר" לכל ממצא, עם הסיור והמשתמש', createdEv.length === 2 && createdEv.every((e) => e.tour_id === tourRow.id && e.actor_id === created.data.user.id));

  // 3. Full edit: description, category, location, contractor, classification, status.
  await tab(p, 'ממצאים');
  await view(p, 'ממצאים');
  const target = srv.find((f) => f.description === 'חסר שקע בסלון')!;
  await p.locator(`.item[data-id="${target.id}"]`).click();
  await p.locator('.sheet textarea.desc').fill('חסר שקע כפול בסלון');
  await p.locator('.sheet .field', { hasText: 'קטגוריה' }).locator('select').selectOption({ label: 'אינסטלציה' });
  await p.locator('.sheet .field', { hasText: 'קבלן' }).locator('select').selectOption({ label: 'אינסטלציה כהן בע״מ' });
  await p.locator('.sheet .field', { hasText: 'סיווג' }).locator('select').selectOption('critical');
  await p.locator('.sheet .field', { hasText: 'סטטוס' }).locator('select').selectOption('reported_done');
  await p.locator('.sheet .loc-btn').click();
  await p.getByLabel('חיפוש מיקום').fill('7');
  await p.locator('.picker-result', { hasText: 'בניין B' }).first().click();
  await shot(p, '2-edit');
  await p.getByRole('button', { name: 'שמור שינויים' }).click();
  await p.locator('.sheet').waitFor({ state: 'detached' });
  await sync(p);
  srv = await findingsOnServer(demoId);
  const edited = srv.find((f) => f.id === target.id)!;
  const plumbingCat = (await sbAdmin.from('categories').select('id').eq('org_id', orgId).eq('name', 'אינסטלציה').single()).data!.id;
  const newLoc = (await sbAdmin.from('locations').select('name, parent_id').eq('id', edited.location_id).single()).data!;
  check('עריכה מלאה נשמרה בשרת (תיאור, קטגוריה, מיקום, קבלן, סיווג, סטטוס)',
    edited.description === 'חסר שקע כפול בסלון' && edited.category_id === plumbingCat && newLoc.name === 'דירה 7' && edited.classification === 'critical' && edited.status === 'reported_done' && !!edited.contractor_id,
    `${edited.description} · ${newLoc.name} · ${edited.classification} · ${edited.status}`);
  const editEv = (await sbAdmin.from('finding_events').select('*').eq('finding_id', target.id).order('seq')).data ?? [];
  const fieldEv = editEv.find((e) => e.type === 'field_changed');
  check('היסטוריה: שינוי סטטוס ושינוי שדות נרשמו עם הסיור',
    editEv.some((e) => e.type === 'status_changed' && e.from_value.status === 'open' && e.to_value.status === 'reported_done' && e.tour_id === tourRow.id) &&
      !!fieldEv && ['description', 'category_id', 'location_id', 'contractor_id', 'classification'].every((k) => k in fieldEv.to_value),
    editEv.map((e) => e.type).join(', '));
  await tab(p, 'ממצאים');
  await p.locator(`.item[data-id="${target.id}"]`).click();
  await p.locator('.history-row').nth(2).waitFor({ timeout: 10000 }).catch(() => {});
  const historyRows = await p.locator('.history-row').count();
  check('ההיסטוריה מוצגת במסך הממצא', historyRows === 3, `${historyRows} שורות`);
  await p.locator('.sheet .link', { hasText: 'סגור' }).click();

  // 4. Soft delete and restore.
  const other = srv.find((f) => f.description === 'חסר רובה במטבח')!;
  await p.locator(`.item[data-id="${other.id}"]`).click();
  await p.getByRole('button', { name: 'מחק ממצא' }).click();
  await p.getByRole('button', { name: 'כן, מחק ממצא' }).click();
  await p.locator('.sheet').waitFor({ state: 'detached' });
  check('ממצא שנמחק יוצא מהרשימה', (await p.locator(`.item[data-id="${other.id}"]`).count()) === 0);
  await p.getByRole('button', { name: 'נמחקו (1)' }).click();
  await p.locator(`.item[data-id="${other.id}"]`).click();
  await p.getByRole('button', { name: 'שחזר ממצא' }).click();
  await p.locator('.sheet').waitFor({ state: 'detached' });
  await p.getByRole('button', { name: 'חזרה לממצאים' }).click();
  check('שחזור מחזיר את הממצא לרשימה', (await p.locator(`.item[data-id="${other.id}"]`).count()) === 1);
  await sync(p);
  const delEv = ((await sbAdmin.from('finding_events').select('type').eq('finding_id', other.id)).data ?? []).map((e) => e.type);
  check('מחיקה ושחזור נרשמו בהיסטוריה, והממצא פעיל בשרת', delEv.includes('deleted') && delEv.includes('restored') && (await findingsOnServer(demoId)).find((f) => f.id === other.id)?.deleted_at === null, delEv.join(', '));
  await tab(p, 'ממצאים');
  const oldItem = p.locator(`.item[data-id="${oldId}"]`);
  await oldItem.click();
  const oldNote = await p.locator('.sheet .muted').first().textContent();
  check('ממצא ישן מוצג כ"תועד לפני הגדרת סיורים"', !!oldNote?.includes('לפני הגדרת סיורים'), oldNote ?? '');
  await p.locator('.sheet .link', { hasText: 'סגור' }).click();

  // 5. Offline: a new tour, findings, an edit and a delete — then sync with nothing lost.
  await tab(p, 'ממצאים');
  await view(p, 'סיורים');
  await p.locator('.tour-item').first().click();
  await p.getByRole('button', { name: 'סגור סיור' }).click();
  await p.getByRole('button', { name: 'כן, סגור סיור' }).click();
  await p.locator('.sheet').waitFor({ state: 'detached' });
  await setOffline(ctx, p, true);
  await tab(p, 'תיעוד');
  await p.locator('.start-tour').waitFor();
  const kind2 = await p.locator('.start-tour .seg button.on').textContent();
  check('אחרי סגירת סיור: התיעוד מבקש סיור חדש, מוצע "סיור חוזר"', kind2 === 'סיור חוזר', kind2 ?? '');
  await p.getByRole('button', { name: 'התחל סיור' }).click();
  await p.getByText('שמור והמשך').waitFor();
  const offlineStart = Date.now();
  await capture(p, 'ממצא חדש ללא חיבור');
  await tab(p, 'ממצאים');
  await view(p, 'ממצאים');
  await p.locator(`.item[data-id="${target.id}"]`).click();
  await p.locator('.sheet .field', { hasText: 'סטטוס' }).locator('select').selectOption('closed');
  await p.getByRole('button', { name: 'שמור שינויים' }).click();
  await p.locator('.sheet').waitFor({ state: 'detached' });
  await p.locator(`.item[data-id="${other.id}"]`).click();
  await p.getByRole('button', { name: 'מחק ממצא' }).click();
  await p.getByRole('button', { name: 'כן, מחק ממצא' }).click();
  await p.locator('.sheet').waitFor({ state: 'detached' });
  await p.waitForTimeout(1500);
  await setOffline(ctx, p, false);
  const syncMsg = await sync(p);
  const tours = (await sbAdmin.from('tours').select('*').eq('project_id', demoId).order('created_at')).data ?? [];
  const offTour = tours.find((t) => t.kind === 'follow_up');
  srv = await findingsOnServer(demoId);
  const offFinding = srv.find((f) => f.description === 'ממצא חדש ללא חיבור');
  check('ללא חיבור: הסיור החדש, הממצא, העריכה והמחיקה הגיעו לשרת', !!offTour && tours.find((t) => t.kind === 'initial')?.status === 'closed' && offFinding?.tour_id === offTour.id && srv.find((f) => f.id === target.id)?.status === 'closed' && !!srv.find((f) => f.id === other.id)?.deleted_at, syncMsg);
  const closeEv = (await sbAdmin.from('finding_events').select('*').eq('finding_id', target.id).eq('type', 'status_changed').order('seq')).data ?? [];
  const last = closeEv[closeEv.length - 1];
  check('האירוע שנרשם ללא חיבור נושא את זמן הפעולה ואת הסיור החדש (לא את זמן הסנכרון)',
    !!last && last.to_value.status === 'closed' && last.tour_id === offTour?.id && new Date(last.at).getTime() >= offlineStart - 1000 && new Date(last.at).getTime() < new Date(last.recorded_at).getTime(),
    last ? `נרשם ${last.at} · סונכרן ${last.recorded_at}` : '');
  const pendingLeft = await p.evaluate(() => new Promise<number>((res) => {
    const r = indexedDB.open('siteflow');
    r.onsuccess = () => {
      const q = r.result.transaction('events').objectStore('events').index('pending').count(1);
      q.onsuccess = () => res(q.result);
    };
  }));
  check('אין היסטוריה שנשארה ממתינה במכשיר אחרי הסנכרון', pendingLeft === 0, `${pendingLeft}`);

  // 6. A second device sees the tours and the history, and can continue the open tour.
  const ctxB = await engine.launchPersistentContext(`${OUT}profile-b`, { viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  const b = ctxB.pages()[0] ?? (await ctxB.newPage());
  await b.goto(BASE);
  await b.locator('.login-card input[type=email]').fill(email);
  await b.locator('.login-card input[type=password]').fill(password);
  await b.locator('.login-card button[type=submit]').click();
  await b.locator('.projects-home').waitFor({ timeout: 30000 });
  await b.locator('.ph-card', { hasText: 'מגדלי הפארק' }).getByRole('button', { name: /^פתח|^המשך/ }).click();
  await b.locator('.start-tour').waitFor({ timeout: 30000 });
  const cont = b.locator('.start-tour').getByRole('button', { name: /^המשך:/ });
  await cont.first().waitFor({ timeout: 20000 });
  check('מכשיר שני מציע להמשיך את הסיור הפתוח', (await cont.count()) === 1 && !!(await cont.textContent())?.includes('סיור חוזר'));
  await cont.click();
  await b.getByText('שמור והמשך').waitFor();
  await shot(b, '3-phone-capture');
  await tab(b, 'ממצאים');
  await view(b, 'ממצאים');
  await b.locator(`.item[data-id="${target.id}"]`).click();
  await b.locator('.history-row').nth(3).waitFor({ timeout: 10000 }).catch(() => {});
  const bHistory = await b.locator('.history-row').count();
  check('ההיסטוריה המלאה מוצגת גם במכשיר השני', bHistory === 4, `${bHistory} שורות`);
  await shot(b, '4-phone-history');
  await b.locator('.sheet .link', { hasText: 'סגור' }).click();
  await view(b, 'סיורים');
  await b.locator('.tour-item').nth(1).waitFor({ timeout: 10000 }).catch(() => {});
  const tourCards = await b.locator('.tour-item').allTextContents();
  check('רשימת הסיורים: שני סיורים, אחד סגור ואחד בעבודה', tourCards.length === 2 && tourCards.some((t) => t.includes('נסגר')) && tourCards.some((t) => t.includes('בעבודה במכשיר')), tourCards.join(' | '));
  await b.locator('.tour-item', { hasText: 'סיור ראשוני' }).click();
  await b.locator('.sheet .row-line').nth(2).waitFor({ timeout: 10000 }).catch(() => {});
  const tourDetail = await b.locator('.sheet').textContent();
  check('פרטי סיור: הממצאים שתועדו בו (בלי שנמחקו) ושינויי הסטטוס שנעשו בו', !!tourDetail?.includes('ממצאים שתועדו בסיור (1)') && tourDetail.includes('שינויי סטטוס בסיור (1)'), '');
  await shot(b, '5-phone-tour');
  await b.locator('.sheet .icon-btn').click();
  await ctxB.close();

  // 7. M3 follow-up: each project keeps its own draft.
  await tab(p, 'תיעוד');
  await p.locator('.chips .chip', { hasText: 'חשמל' }).first().click();
  await p.locator('#capture-desc').fill('טיוטה של פרויקט ההדגמה');
  await p.waitForTimeout(400);
  await manageProject(p, 'פרויקט שני');
  await tab(p, 'תיעוד');
  await p.locator('.start-tour').waitFor();
  await p.getByRole('button', { name: 'התחל סיור' }).click();
  await p.getByText('שמור והמשך').waitFor();
  const otherDraft = await p.locator('#capture-desc').inputValue();
  check('טיוטה לא עוברת לפרויקט אחר', otherDraft === '', otherDraft);
  await p.locator('#capture-desc').fill('טיוטה של הפרויקט השני');
  await p.waitForTimeout(400);
  await manageProject(p, 'מגדלי הפארק');
  await tab(p, 'תיעוד');
  await p.getByText('שמור והמשך').waitFor();
  const backDraft = await p.locator('#capture-desc').inputValue();
  check('בחזרה לפרויקט, הטיוטה שלו מחכה', backDraft === 'טיוטה של פרויקט ההדגמה', backDraft);

  // 8. M3 follow-up: a contractor removed from the project is no longer offered, but old findings keep it.
  const elecCon = (await sbAdmin.from('contractors').select('id').eq('org_id', orgId).eq('name', 'לוי חשמל ותקשורת').single()).data!.id;
  const firstFinding = srv.find((f) => f.contractor_id === elecCon);
  await sbAdmin.from('project_contractors').update({ deleted_at: new Date().toISOString() }).eq('project_id', demoId).eq('contractor_id', elecCon);
  await sync(p);
  await tab(p, 'תיעוד');
  await p.getByText('שמור והמשך').waitFor();
  const offered = await p.locator('.drow-select option').allTextContents();
  await p.locator('.chips .chip', { hasText: 'חשמל' }).first().click();
  const autoAfter = await p.locator('.drow-select option:checked').textContent();
  check('קבלן שהוסר מהפרויקט לא מוצע בתיעוד ולא נבחר אוטומטית', !offered.includes('לוי חשמל ותקשורת') && autoAfter === 'בחר', `${autoAfter}`);
  if (firstFinding) {
    await tab(p, 'ממצאים');
    await view(p, 'ממצאים');
    await p.locator(`.item[data-id="${firstFinding.id}"]`).click();
    const kept = await p.locator('.sheet .field', { hasText: 'קבלן' }).locator('select option:checked').textContent();
    check('ממצא היסטורי שומר את הקבלן שהוסר (מסומן "לא פעיל בפרויקט")', !!kept?.includes('לא פעיל בפרויקט'), kept ?? '');
    await p.locator('.sheet .link', { hasText: 'סגור' }).click();
  } else check('ממצא היסטורי שומר את הקבלן שהוסר', false, 'no finding with that contractor');

  await ctx.close();
  await sbAdmin.auth.admin.deleteUser(created.data.user.id);
}

try {
  await main();
} catch (e) {
  check('הרצת הבדיקות', false, (e as Error).stack ?? String(e));
} finally {
  server?.kill();
  rmSync(DIST, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  writeFileSync(`${OUT}results.json`, JSON.stringify({ engine: ENGINE, at: new Date().toISOString(), results }, null, 1));
  console.log(`\n${results.length - failed.length}/${results.length} passed (${ENGINE})`);
  process.exit(failed.length ? 1 : 0);
}
