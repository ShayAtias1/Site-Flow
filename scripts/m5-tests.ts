// M5 acceptance tests: one finding per location from a single capture (shared batch id), offline batch
// creation without duplicates, photos added to existing findings (also on a follow-up tour), and issued
// reports staying unchanged. Runs against the local Supabase with a throwaway user, like poc-tests.ts.
// Usage: tsx scripts/m5-tests.ts [chromium|webkit]
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright';

const ENGINE = (process.argv[2] ?? 'chromium') as 'chromium' | 'webkit';
const engine = ENGINE === 'webkit' ? webkit : chromium;
const PORT = 8796;
const BASE = `http://localhost:${PORT}`;
const ROOT = new URL('../', import.meta.url).pathname;
const OUT = `${ROOT}poc-output/m5-${ENGINE}/`;
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

const DIST = `${ROOT}dist-test-m5`;
let server: ChildProcess | undefined;
async function startServer() {
  if (await fetch(`${BASE}/api/health`).then(() => true, () => false)) throw new Error(`port ${PORT} is already in use`);
  server = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SITEFLOW_TEST: '1', SITEFLOW_DIST: DIST, SITEFLOW_SUPABASE_URL: SB_URL, SITEFLOW_SUPABASE_KEY: SB_ANON },
    stdio: 'ignore',
    // Its own process group, so stopping it also stops the node process npx starts.
    detached: true,
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
async function sync(p: Page) {
  await tab(p, 'הגדרות');
  const n = await p.locator('.log div').count();
  await p.getByRole('button', { name: 'סנכרן עכשיו' }).click();
  await p.locator('.log div').nth(n).waitFor({ timeout: 60000 });
  return (await p.locator('.log div').first().textContent()) ?? '';
}
async function photo(i: number) {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 800, height: 600 } });
  await pg.setContent(`<body style="margin:0;background:hsl(${i * 90},45%,50%);height:600px;font:bold 90px Arial;color:#fff;display:flex;align-items:center;justify-content:center">צילום ${i}</body>`);
  const buf = await pg.screenshot({ type: 'jpeg', quality: 85 });
  await b.close();
  return buf;
}
interface Row { id: string; batch_id: string | null; location_id: string; display_no: number; status: string; contractor_id: string | null; photo_ids: string[]; tour_id: string | null; description: string }
const findingsOnServer = async (projectId: string) => ((await sbAdmin.from('findings').select('*').eq('project_id', projectId).order('display_no')).data ?? []) as Row[];

/** pdf.js: page count and number of drawn images (photos; the logo and signature are vectors). */
async function pdfImages(pdf: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  const ops = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject]);
  let images = 0;
  for (let i = 1; i <= doc.numPages; i++) images += (await (await doc.getPage(i)).getOperatorList()).fnArray.filter((op) => ops.has(op)).length;
  return images;
}
const download = async (path: string) => Buffer.from(await (await sbAdmin.storage.from('reports').download(path)).data!.arrayBuffer());
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function main() {
  console.log(`\n=== SiteFlow M5 tests (several locations, photos on existing findings) — engine: ${ENGINE} ===\n`);
  execSync(`npx vite build --outDir ${DIST} --emptyOutDir`, { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: `${BASE}/sb`, VITE_SUPABASE_PUBLISHABLE_KEY: SB_ANON, VITE_TEST_HOOKS: "1" } });
  await startServer();
  const photos = [await photo(1), await photo(2), await photo(3)];

  const email = `m5-${randomBytes(4).toString('hex')}@siteflow.test`;
  const password = randomBytes(18).toString('base64url');
  const created = await sbAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const orgName = `ארגון M5 ${randomBytes(3).toString('hex')}`;
  const orgId = (await sbAdmin.rpc('admin_add_member', { p_email: email, p_org_name: orgName, p_role: 'engineer' })).data as string;
  const demoId = (await sbAdmin.rpc('admin_seed_demo_project', { p_org_name: orgName })).data as string;
  const elec = (await sbAdmin.from('contractors').select('id').eq('org_id', orgId).eq('name', 'לוי חשמל ותקשורת').single()).data!.id;

  const ctx = await engine.launchPersistentContext(`${OUT}profile`, { viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  await p.goto(BASE);
  await p.locator('.login-card input[type=email]').fill(email);
  await p.locator('.login-card input[type=password]').fill(password);
  await p.locator('.login-card button[type=submit]').click();
  await p.locator('.start-tour').waitFor({ timeout: 30000 });
  await p.getByRole('button', { name: 'התחל סיור' }).click();
  await p.getByText('שמור והמשך').waitFor();

  // 1. One capture, several locations: a whole floor plus one more unit.
  await p.locator('.locbar .loc').click();
  await p.getByRole('radio', { name: 'כמה מיקומים' }).click();
  const lobby = p.locator('.sheet .chips.commons').getByRole('button', { name: 'לובי כניסה' });
  check('במעבר לבחירה מרובה, המיקום הנוכחי כבר מסומן', (await lobby.getAttribute('aria-pressed')) === 'true');
  await lobby.click();
  await p.getByRole('button', { name: 'כל קומה 1' }).first().click();
  await p.locator('.picker-floor', { hasText: 'קומה 2' }).first().getByRole('button', { name: 'דירה 6', exact: true }).click();
  await shot(p, '1-picker-multi');
  await p.locator('.picker-done .primary').click();
  const strip = await p.locator('.multi-strip').textContent();
  check('בחירה מרובה: קומה שלמה ועוד דירה — 5 מיקומים מוצגים לפני השמירה', !!strip?.includes('5 המיקומים') && strip.includes('דירה 6'), strip ?? '');
  check('החצים (יחידה הבאה/קודמת) מושבתים בבחירה מרובה', await p.getByRole('button', { name: 'היחידה הבאה' }).isDisabled());
  await p.locator('.chips .chip', { hasText: 'חשמל' }).first().click();
  const auto = await p.locator('.drow-select option:checked').textContent();
  await p.locator('#capture-desc').fill('חסרים כיסויי שקעים');
  await p.locator('input[type=file][accept="image/*"]').first().setInputFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: photos[0] });
  await p.locator('.photos .thumb').first().waitFor();
  await shot(p, '2-capture-multi');
  await p.getByRole('button', { name: 'שמור 5 ממצאים' }).click();
  const toast = await p.locator('.toast').textContent();
  await p.locator('.toast').waitFor({ state: 'detached' });
  check('שמירה אחת יוצרת 5 ממצאים, עם קבלן ברירת המחדל', !!toast?.includes('נשמרו 5 ממצאים') && auto === 'לוי חשמל ותקשורת', `${toast} · ${auto}`);
  check('אחרי השמירה חוזרים למיקום אחד', (await p.locator('.multi-strip').count()) === 0 && !(await p.getByRole('button', { name: 'היחידה הבאה' }).isDisabled()));
  await sync(p);
  let srv = await findingsOnServer(demoId);
  const batch = srv.filter((f) => f.batch_id);
  const ids = new Set(batch.map((f) => f.id));
  check('בשרת: 5 ממצאים עם batch_id משותף, מזהה, מיקום ומספר משלהם',
    batch.length === 5 && new Set(batch.map((f) => f.batch_id)).size === 1 && ids.size === 5 && new Set(batch.map((f) => f.location_id)).size === 5 && new Set(batch.map((f) => f.display_no)).size === 5,
    batch.map((f) => f.display_no).join(','));
  check('כולם עם קבלן ברירת המחדל ובאותו סיור', batch.every((f) => f.contractor_id === elec && !!f.tour_id && f.tour_id === batch[0].tour_id));
  const photoRows = (await sbAdmin.from('photos').select('*').eq('org_id', orgId)).data ?? [];
  check('התמונה הועלתה פעם אחת ומוצגת בכל 5 הממצאים', photoRows.length === 1 && batch.every((f) => f.photo_ids.includes(photoRows[0].id)), `${photoRows.length} קבצים`);
  const createdEv = (await sbAdmin.from('finding_events').select('finding_id').in('finding_id', [...ids]).eq('type', 'created')).data ?? [];
  check('לכל ממצא בקבוצה היסטוריה משלו (אירוע "נוצר")', new Set(createdEv.map((e) => e.finding_id)).size === 5);

  // Each finding has its own completion workflow.
  await tab(p, 'ממצאים');
  await view(p, 'ממצאים');
  const first = batch[0];
  await p.locator(`.item[data-id="${first.id}"]`).click();
  check('הממצא מסומן כחלק מקבוצה', !!(await p.locator('.sheet').textContent())?.includes('נוצר יחד עם 4 ממצאים נוספים'));
  await p.locator('.sheet .field', { hasText: 'סטטוס' }).locator('select').selectOption('closed');
  await p.getByRole('button', { name: 'שמור שינויים' }).click();
  await p.locator('.sheet').waitFor({ state: 'detached' });
  await sync(p);
  srv = await findingsOnServer(demoId);
  check('סגירת ממצא אחד בקבוצה לא משנה את האחרים', srv.filter((f) => ids.has(f.id) && f.status === 'closed').length === 1 && srv.filter((f) => ids.has(f.id) && f.status === 'open').length === 4);

  // 2. Offline batch, app closed and reopened before syncing: no losses, no duplicates.
  await tab(p, 'תיעוד');
  await setOffline(ctx, p, true);
  await p.locator('.locbar .loc').click();
  await p.getByRole('radio', { name: 'כמה מיקומים' }).click();
  for (const q of ['גג', 'לובי כניסה']) {
    await p.getByLabel('חיפוש מיקום').fill(q);
    for (const r of await p.locator('.picker-result').all()) if (!(await r.getAttribute('aria-pressed'))?.includes('true')) await r.click();
  }
  await p.getByLabel('חיפוש מיקום').fill('');
  await p.locator('.picker-done .primary').click();
  await p.locator('.chips .chip', { hasText: 'כללי' }).first().click();
  await p.locator('#capture-desc').fill('פסולת בניין לפינוי');
  await p.getByRole('button', { name: 'שמור 5 ממצאים' }).click();
  const offToast = await p.locator('.toast').textContent();
  await p.locator('.toast').waitFor({ state: 'detached' });
  await p.reload();
  await p.locator('nav.tabs').waitFor({ timeout: 20000 });
  await setOffline(ctx, p, false);
  await sync(p);
  await sync(p);
  srv = await findingsOnServer(demoId);
  const off = srv.filter((f) => f.description === 'פסולת בניין לפינוי');
  // The current location (pre-selected) plus two roofs and two lobbies found by search.
  check('ללא חיבור: קבוצה (5 מיקומים, בחירה בחיפוש) נשמרה, שרדה פתיחה מחדש וסונכרנה בלי כפילויות', !!offToast?.includes('נשמרו 5 ממצאים') && off.length === 5 && new Set(off.map((f) => f.batch_id)).size === 1, `${offToast} · ${off.length} בשרת`);

  // 3. A report issued now must never change afterwards.
  await tab(p, 'דוחות');
  await p.getByRole('radio', { name: /פרוטוקול מפורט/ }).click();
  await p.getByRole('button', { name: 'הפק דוח' }).click();
  await p.locator('.reports .item').first().waitFor({ timeout: 120000 });
  const report = (await sbAdmin.from('reports').select('*').eq('project_id', demoId).single()).data!;
  const before = await download(report.pdf_path);
  const imagesBefore = await pdfImages(before);

  // 4. Photos added to an existing finding — with the original photo kept as it was.
  const target = batch[1];
  const origPhoto = photoRows[0];
  await tab(p, 'ממצאים');
  await view(p, 'ממצאים');
  await p.locator(`.item[data-id="${target.id}"]`).click();
  await p.getByLabel('קובץ תמונה לממצא').setInputFiles({ name: 'b.jpg', mimeType: 'image/jpeg', buffer: photos[1] });
  await p.locator('.edit-photos .thumb').nth(1).waitFor();
  await p.locator('.history-row[data-type="photo_added"]').waitFor();
  await shot(p, '3-edit-photo');
  check('הוספת תמונה לממצא קיים: התמונה המקורית נשמרה ונוספה תמונה, והפעולה מופיעה בהיסטוריה', (await p.locator('.edit-photos .thumb').count()) === 2);
  await p.locator('.sheet .link', { hasText: 'סגור' }).click();
  await sync(p);
  srv = await findingsOnServer(demoId);
  const t1 = srv.find((f) => f.id === target.id)!;
  const added = (await sbAdmin.from('photos').select('*').eq('finding_id', target.id)).data ?? [];
  const origAfter = (await sbAdmin.from('photos').select('*').eq('id', origPhoto.id).single()).data!;
  check('בשרת: התמונה החדשה (סוג progress) נוספה לממצא, והתמונה המקורית לא השתנתה',
    t1.photo_ids.length === 2 && t1.photo_ids[0] === origPhoto.id && added.length === 1 && added[0].kind === 'progress' && JSON.stringify(origAfter) === JSON.stringify(origPhoto),
    `${t1.photo_ids.length} תמונות · שורות לממצא: ${added.length} (${added.map((x) => x.kind).join(',')}) · מקורית זהה: ${JSON.stringify(origAfter) === JSON.stringify(origPhoto)} · ${t1.photo_ids[0] === origPhoto.id}`);
  check('הממצאים האחרים בקבוצה לא קיבלו את התמונה החדשה', srv.filter((f) => ids.has(f.id) && f.id !== target.id).every((f) => f.photo_ids.length === 1));

  // 5. On a follow-up tour.
  await tab(p, 'ממצאים');
  await view(p, 'סיורים');
  await p.locator('.tour-item').first().click();
  await p.getByRole('button', { name: 'סגור סיור' }).click();
  await p.getByRole('button', { name: 'כן, סגור סיור' }).click();
  await p.locator('.sheet').waitFor({ state: 'detached' });
  await tab(p, 'תיעוד');
  await p.getByRole('button', { name: 'התחל סיור' }).click();
  await p.getByText('שמור והמשך').waitFor();
  await setOffline(ctx, p, true);
  await tab(p, 'ממצאים');
  await view(p, 'ממצאים');
  await p.locator(`.item[data-id="${target.id}"]`).click();
  await p.getByLabel('קובץ תמונה לממצא').setInputFiles({ name: 'c.jpg', mimeType: 'image/jpeg', buffer: photos[2] });
  await p.locator('.edit-photos .thumb').nth(2).waitFor();
  await p.locator('.sheet .link', { hasText: 'סגור' }).click();
  await setOffline(ctx, p, false);
  await sync(p);
  const followUp = (await sbAdmin.from('tours').select('id').eq('project_id', demoId).eq('kind', 'follow_up').single()).data!;
  const photoEvents = (await sbAdmin.from('finding_events').select('tour_id, to_value').eq('finding_id', target.id).eq('type', 'photo_added').order('seq')).data ?? [];
  const thirdRow = (await sbAdmin.from('photos').select('id').eq('id', photoEvents[1]?.to_value?.photo_id ?? '')).data ?? [];
  check('תמונה בסיור חוזר (ללא חיבור): נרשמה בהיסטוריה עם הסיור החוזר והועלתה', photoEvents.length === 2 && photoEvents[1].tour_id === followUp.id && photoEvents[0].tour_id !== followUp.id && thirdRow.length === 1);

  // 6. The issued report is unchanged; a new report shows the new photos.
  const reportAfter = (await sbAdmin.from('reports').select('*').eq('id', report.id).single()).data!;
  const after = await download(report.pdf_path);
  check('דוח שהונפק לפני הוספת התמונות לא השתנה (רשומה, snapshot ו-PDF)',
    JSON.stringify(reportAfter) === JSON.stringify(report) && sha(after) === report.pdf_sha256 && sha(after) === sha(before), `sha ${report.pdf_sha256.slice(0, 10)}`);
  await tab(p, 'דוחות');
  await p.getByRole('radio', { name: /פרוטוקול מפורט/ }).click();
  await p.getByRole('button', { name: 'הפק דוח' }).click();
  await p.locator('.reports .item').nth(1).waitFor({ timeout: 120000 });
  const second = (await sbAdmin.from('reports').select('*').eq('project_id', demoId).neq('id', report.id).single()).data!;
  const imagesAfter = await pdfImages(await download(second.pdf_path));
  check('דוח חדש כולל את התמונות שנוספו', imagesAfter === imagesBefore + 2, `${imagesBefore} → ${imagesAfter} תמונות`);
  check('מספר דוח חדש, הדוח הקודם נשאר ברשימה', second.number !== report.number && (await p.locator('.reports .item').count()) === 2, `${report.number} · ${second.number}`);

  await ctx.close();
  await sbAdmin.auth.admin.deleteUser(created.data.user.id);
}

try {
  await main();
} catch (e) {
  check('הרצת הבדיקות', false, (e as Error).stack ?? String(e));
} finally {
  if (server?.pid) process.kill(-server.pid, 'SIGKILL');
  rmSync(DIST, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  writeFileSync(`${OUT}results.json`, JSON.stringify({ engine: ENGINE, at: new Date().toISOString(), results }, null, 1));
  console.log(`\n${results.length - failed.length}/${results.length} passed (${ENGINE})`);
  process.exit(failed.length ? 1 : 0);
}
