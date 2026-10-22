// M3 acceptance tests: project setup from the app — projects, structure generator, manual structure
// editing, contractors, categories and per-project defaults, project switching and isolation, delete
// protection, offline use after sync. Runs against the local Supabase (`npx supabase start`) with a
// throwaway user, like poc-tests.ts.
// Usage: tsx scripts/m3-tests.ts [chromium|webkit]
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright';

const ENGINE = (process.argv[2] ?? 'chromium') as 'chromium' | 'webkit';
const engine = ENGINE === 'webkit' ? webkit : chromium;
const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const ROOT = new URL('../', import.meta.url).pathname;
const OUT = `${ROOT}poc-output/m3-${ENGINE}/`;
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

const DIST = `${ROOT}dist-test-m3`;
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
  await page.evaluate((o) => window.dispatchEvent(new Event(o ? 'offline' : 'online')), offline);
}

/** (M4) Capture starts with a tour: continue an open one, or start one. */
async function captureReady(p: Page, timeout = 30000) {
  const form = p.getByText('שמור והמשך');
  const start = p.locator('.start-tour');
  await form.or(start).first().waitFor({ timeout });
  if (await start.isVisible()) {
    const cont = start.getByRole('button', { name: /^המשך:/ });
    if (await cont.count()) await cont.first().click();
    else await start.getByRole('button', { name: 'התחל סיור' }).click();
    await form.waitFor();
  }
}

const tab = (p: Page, name: string) => p.locator('nav.tabs button', { hasText: name }).click();
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
const section = (p: Page, name: string) => p.locator('.setup-tabs button', { hasText: name }).click();
const sheet = (p: Page) => p.locator('.setup-sheet');
const closeSheet = (p: Page) => p.locator('.sheet .icon-btn[aria-label="סגירה"]').click();
const shot = (p: Page, name: string) => p.screenshot({ path: `${OUT}${name}.png`, fullPage: true });

async function server_<T>(table: string, q: (b: ReturnType<typeof sbAdmin.from>) => PromiseLike<{ data: T[] | null }>) {
  return (await q(sbAdmin.from(table))).data ?? [];
}

async function main() {
  console.log(`\n=== SiteFlow M3 tests (project setup) — engine: ${ENGINE} ===\n`);
  execSync(`npx vite build --outDir ${DIST} --emptyOutDir`, { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: `${BASE}/sb`, VITE_SUPABASE_PUBLISHABLE_KEY: SB_ANON, VITE_TEST_HOOKS: "1" } });
  await startServer();

  const email = `m3-${randomBytes(4).toString('hex')}@siteflow.test`;
  const password = randomBytes(18).toString('base64url');
  const created = await sbAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const orgName = `ארגון M3 ${randomBytes(3).toString('hex')}`;
  const orgId = (await sbAdmin.rpc('admin_add_member', { p_email: email, p_org_name: orgName, p_role: 'engineer' })).data as string;
  const demoId = (await sbAdmin.rpc('admin_seed_demo_project', { p_org_name: orgName })).data as string;

  const ctx = await engine.launchPersistentContext(`${OUT}profile`, { viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow' });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(`${e.message} @ ${e.stack?.split('\n').slice(0, 4).join(' < ')}`));
  await p.goto(BASE);
  await p.locator('.login-card input[type=email]').fill(email);
  await p.locator('.login-card input[type=password]').fill(password);
  await p.locator('.login-card button[type=submit]').click();
  await captureReady(p);

  // A finding in the demo project — existing data that M3 must leave untouched.
  await p.locator('.chips .chip', { hasText: 'חשמל' }).first().click();
  await p.locator('#capture-desc').fill('ממצא בפרויקט ההדגמה');
  await p.getByRole('button', { name: 'שמור והמשך' }).click();
  await p.locator('.toast').waitFor();
  const demoLocation = (await p.locator('.locbar .loc-name').textContent()) ?? '';

  // 1. Project management: create, validation, edit.
  await manageProject(p, 'מגדלי הפארק');
  await p.locator('.st-root').first().waitFor();
  check('מסך הפרויקט מציג את מבנה פרויקט ההדגמה', (await p.locator('.st-root').count()) === 3);
  await projectsHome(p);
  await p.getByRole('button', { name: '+ פרויקט חדש' }).click();
  await sheet(p).getByLabel('שם הפרויקט').fill('מגדלי הים');
  await sheet(p).getByLabel('קוד').fill('DEMO');
  await sheet(p).getByRole('button', { name: 'צור פרויקט' }).click();
  const dupMsg = await sheet(p).locator('.alert.error').textContent();
  check('קוד פרויקט כפול נדחה עם הסבר', !!dupMsg?.includes('כבר בשימוש'), dupMsg ?? '');
  await sheet(p).getByLabel('קוד').fill('YAM');
  await sheet(p).getByLabel('כתובת').fill('שד׳ הים 3');
  await sheet(p).getByRole('button', { name: 'צור פרויקט' }).click();
  await sheet(p).waitFor({ state: 'detached' });
  await p.locator('.setup-tabs').waitFor();
  const current = await p.locator('.pb-name').first().textContent();
  check('פרויקט חדש נוצר ונבחר כפעיל', !!current?.includes('מגדלי הים'), current ?? '');
  const yam = (await server_<{ id: string; code: string; org_id: string }>('projects', (b) => b.select('*').eq('org_id', orgId).eq('code', 'YAM')))[0];
  check('הפרויקט נשמר ב-Supabase בארגון הנכון', !!yam, yam?.id);

  // 2. Structure generator: 12 floors × 6 units, continuous numbering.
  await p.getByRole('button', { name: '+ בניין (מחולל)' }).click();
  await sheet(p).getByLabel('שם הבניין').fill('בניין צפוני');
  await sheet(p).getByLabel('קוד').fill('N');
  await sheet(p).getByLabel('עד קומה').fill('12');
  await sheet(p).getByLabel('דירות בקומה').fill('6');
  const preview = await sheet(p).locator('.preview-head').textContent();
  check('תצוגה מקדימה: 12 קומות · 72 יחידות', !!preview?.includes('12 קומות') && preview.includes('72 יחידות'), preview ?? '');
  await sheet(p).getByLabel('עד קומה').fill('2');
  await sheet(p).getByLabel('מקומה').fill('5');
  const invalid = await sheet(p).locator('.alert.warn').textContent().catch(() => '');
  check('טווח קומות הפוך נחסם עם הסבר', !!invalid?.includes('נמוכה'), invalid ?? '');
  await sheet(p).getByLabel('מקומה').fill('1');
  await sheet(p).getByLabel('עד קומה').fill('12');
  await shot(p, '1-generator');
  await sheet(p).getByRole('button', { name: /^צור / }).click();
  await sheet(p).waitFor({ state: 'detached' });
  const locs = await server_<{ kind: string; name: string; code: string; parent_id: string | null }>('locations', (b) => b.select('*').eq('project_id', yam.id).is('deleted_at', null));
  const units = locs.filter((l) => l.kind === 'unit');
  check('המחולל יצר בניין, 12 קומות ו-72 דירות בשרת', locs.filter((l) => l.kind === 'building').length === 1 && locs.filter((l) => l.kind === 'floor').length === 12 && units.length === 72, `${locs.length} מיקומים`);
  check('מספור רציף וקודי יחידות', units.some((u) => u.name === 'דירה 1' && u.code === 'N-01-01') && units.some((u) => u.name === 'דירה 72' && u.code === 'N-12-72'));
  check('שטחים משותפים ברירת מחדל נוצרו (לובי, מדרגות, גג)', locs.filter((l) => l.kind === 'common').length === 3);

  // By-floor numbering, second building.
  await p.getByRole('button', { name: '+ בניין (מחולל)' }).click();
  await sheet(p).getByLabel('עד קומה').fill('3');
  await sheet(p).getByLabel('דירות בקומה').fill('2');
  await sheet(p).getByRole('radio', { name: /לפי קומה/ }).click();
  await sheet(p).getByRole('button', { name: /^צור / }).click();
  await sheet(p).waitFor({ state: 'detached' });
  const byFloor = (await server_<{ name: string }>('locations', (b) => b.select('name').eq('project_id', yam.id).eq('kind', 'unit'))).map((u) => u.name);
  check('מספור לפי קומה (101, 102, 201…)', ['דירה 101', 'דירה 102', 'דירה 301', 'דירה 302'].every((n) => byFloor.includes(n)), byFloor.filter((n) => /\d{3}/.test(n)).join(', '));

  // Add floors to an existing building: numbering continues.
  await p.locator('.st-root', { hasText: 'בניין צפוני' }).locator('.st-head').click();
  await sheet(p).getByRole('button', { name: '+ הוסף קומות (מחולל)' }).click();
  const nextFloor = await sheet(p).getByLabel('מקומה').inputValue();
  const nextNo = await sheet(p).getByLabel('מספר הדירה הראשונה').inputValue();
  check('הוספת קומות ממשיכה מהקומה והמספר הבאים', nextFloor === '13' && nextNo === '73', `קומה ${nextFloor}, דירה ${nextNo}`);
  await sheet(p).getByRole('button', { name: /^הוסף \(/ }).click();
  await sheet(p).waitFor({ state: 'detached' });
  check('קומה 13 עם דירות 73–78 נוספה', (await p.locator('.st-root', { hasText: 'בניין צפוני' }).locator('.st-floor', { hasText: 'קומה 13' }).locator('.st-chip:not(.st-add)').count()) === 6);

  // 3. Manual editing: rename, add a common area to a floor, add an area, delete an empty unit.
  await p.locator('.st-root', { hasText: 'בניין צפוני' }).getByRole('button', { name: 'דירה 1', exact: true }).click();
  await sheet(p).getByLabel('שם').fill('דירה 1 (דופלקס)');
  await sheet(p).getByRole('button', { name: 'שמור שם' }).click();
  await p.locator('.st-root', { hasText: 'בניין צפוני' }).getByRole('button', { name: 'דירה 1 (דופלקס)' }).waitFor();
  await closeSheet(p);
  check('שינוי שם יחידה', (await server_('locations', (b) => b.select('id').eq('project_id', yam.id).eq('name', 'דירה 1 (דופלקס)'))).length === 1);
  await p.locator('.st-root', { hasText: 'בניין צפוני' }).locator('.st-floor-name', { hasText: 'קומה 3' }).click();
  await sheet(p).locator('.inline-add input').fill('מחסן קומתי');
  await sheet(p).getByRole('button', { name: '+ שטח משותף' }).click();
  await p.locator('.st-root', { hasText: 'בניין צפוני' }).getByRole('button', { name: 'מחסן קומתי' }).waitFor();
  await closeSheet(p);
  check('הוספת שטח משותף בקומה', true);
  await p.getByRole('button', { name: '+ אזור / פיתוח' }).click();
  await sheet(p).getByRole('button', { name: 'צור אזור' }).click();
  await sheet(p).waitFor({ state: 'detached' });
  await p.locator('.st-root', { hasText: 'פיתוח ושטחים משותפים' }).locator('.st-head').click();
  await sheet(p).locator('.inline-add input').fill('חניון תת-קרקעי');
  await sheet(p).getByRole('button', { name: '+ שטח משותף' }).click();
  await p.locator('.st-root', { hasText: 'פיתוח' }).getByRole('button', { name: 'חניון תת-קרקעי' }).waitFor();
  await closeSheet(p);
  check('אזור פיתוח עם שטח מיוחד נוצר', true);
  await p.locator('.st-root', { hasText: 'בניין צפוני' }).getByRole('button', { name: 'דירה 78', exact: true }).click();
  await sheet(p).getByRole('button', { name: 'מחק את דירה 78' }).click();
  await sheet(p).getByRole('button', { name: 'כן, מחק את דירה 78' }).click();
  await sheet(p).waitFor({ state: 'detached' });
  const del78 = await server_<{ deleted_at: string | null }>('locations', (b) => b.select('deleted_at').eq('project_id', yam.id).eq('name', 'דירה 78'));
  check('מחיקת יחידה ריקה (אחרי אישור) — מחיקה רכה בשרת', del78.length === 1 && !!del78[0].deleted_at);

  // 4. Contractors per project, with contact details.
  await section(p, 'קבלנים');
  check('פרויקט חדש מתחיל בלי קבלנים (לא יורש מפרויקט אחר)', (await p.locator('.contractor-card').count()) === 0);
  await p.getByRole('button', { name: '+ הוסף קבלן' }).click();
  await sheet(p).locator('.row-line', { hasText: 'לוי חשמל' }).getByRole('button').click();
  await sheet(p).locator('.row-line', { hasText: 'לוי חשמל' }).waitFor({ state: 'detached' });
  await sheet(p).getByLabel('שם החברה / הקבלן').fill('גבס הים בע״מ');
  await sheet(p).getByLabel('מקצוע').fill('גבס');
  await sheet(p).getByLabel('איש קשר').fill('משה');
  await sheet(p).getByLabel('טלפון').fill('050-1234567');
  await sheet(p).getByLabel('אימייל').fill('not-an-email');
  await sheet(p).getByRole('button', { name: 'צור והוסף לפרויקט' }).click();
  check('אימייל לא תקין נחסם', !!(await sheet(p).locator('.alert.error').textContent())?.includes('אימייל'));
  await sheet(p).getByLabel('אימייל').fill('office@gypsum.example');
  await sheet(p).getByRole('button', { name: 'צור והוסף לפרויקט' }).click();
  await sheet(p).waitFor({ state: 'detached' });
  const cards = await p.locator('.contractor-card').allTextContents();
  check('שני קבלנים בפרויקט: קיים מהארגון וחדש עם פרטי קשר', cards.length === 2 && cards.some((c) => c.includes('050-1234567') && c.includes('משה')), cards.join(' | '));
  await p.locator('.contractor-card', { hasText: 'גבס הים' }).click();
  await sheet(p).getByLabel('טלפון').fill('050-7654321');
  await sheet(p).getByRole('button', { name: 'שמור' }).click();
  await sheet(p).waitFor({ state: 'detached' });
  const gypsum = (await server_<{ id: string; phone: string }>('contractors', (b) => b.select('*').eq('org_id', orgId).eq('name', 'גבס הים בע״מ')))[0];
  check('עריכת פרטי קבלן נשמרת', gypsum?.phone === '050-7654321');

  // 5. Categories, phrases and per-project default contractor.
  await section(p, 'קטגוריות');
  await p.locator('.categories input[placeholder^="קטגוריה חדשה"]').fill('גבס');
  await p.getByRole('button', { name: '+ קטגוריה' }).click();
  const gCard = p.locator('.category-card').filter({ has: p.locator('input.cat-name[value="גבס"]') });
  await gCard.waitFor();
  await gCard.getByLabel('ביטוי חדש לגבס').fill('חסר פרופיל פינה');
  await gCard.getByRole('button', { name: 'הוסף' }).click();
  await p.locator('.category-card').filter({ has: p.locator('input.cat-name[value="גבס"]') }).getByText('חסר פרופיל פינה').waitFor();
  await p.getByLabel('קבלן ברירת מחדל לגבס').selectOption({ label: 'גבס הים בע״מ' });
  await p.getByLabel('קבלן ברירת מחדל לחשמל').selectOption({ label: 'לוי חשמל ותקשורת' });
  await p.waitForTimeout(800);
  const defaults = await server_<{ project_id: string; contractor_id: string | null; category_id: string }>('project_category_defaults', (b) => b.select('*').eq('org_id', orgId));
  const gypsumCat = (await server_<{ id: string; phrases: string[] }>('categories', (b) => b.select('*').eq('org_id', orgId).eq('name', 'גבס')))[0];
  check('קטגוריה חדשה עם ביטוי מוכן נשמרה', gypsumCat?.phrases.includes('חסר פרופיל פינה'), gypsumCat?.phrases.join());
  check('קבלן ברירת מחדל לקטגוריה נשמר לפרויקט החדש', defaults.some((d) => d.project_id === yam.id && d.category_id === gypsumCat.id && d.contractor_id === gypsum.id));
  const demoElec = defaults.filter((d) => d.project_id === demoId);
  check('ברירות המחדל של פרויקט ההדגמה לא השתנו', demoElec.length === 9 && demoElec.every((d) => d.contractor_id !== gypsum.id));
  await shot(p, '2-categories');

  // 6. Capture uses the selected project: its structure, contractors and defaults.
  await tab(p, 'תיעוד');
  await captureReady(p);
  const locName = await p.locator('.locbar .loc-name').textContent();
  const projTag = await p.locator('.locbar .loc-project').textContent().catch(() => '');
  check('התיעוד עבר לפרויקט שנבחר (מיקום ראשון של הבניין החדש, קוד הפרויקט מוצג)', locName === 'לובי כניסה' && projTag === 'YAM', `${projTag} · ${locName}`);
  const contractorOptions = await p.locator('.drow-select option').allTextContents();
  check('רשימת הקבלנים בתיעוד מכילה רק את קבלני הפרויקט', contractorOptions.length === 3 && contractorOptions.includes('גבס הים בע״מ') && !contractorOptions.includes('אינסטלציה כהן בע״מ'), contractorOptions.join(', '));
  await p.locator('.locbar .loc').click();
  await p.getByLabel('חיפוש מיקום').fill('34');
  const results34 = await p.locator('.picker-result').allTextContents();
  check('חיפוש מהיר בבורר המיקומים ("34" → דירה 34)', results34.length === 1 && results34[0].includes('דירה 34'), results34.join(' | '));
  await p.locator('.picker-result').first().click();
  await p.locator('.chips .chip', { hasText: 'גבס' }).first().click();
  const autoContractor = await p.locator('.drow-select option:checked').textContent();
  check('קבלן ברירת המחדל של הפרויקט נבחר אוטומטית', autoContractor === 'גבס הים בע״מ', autoContractor ?? '');
  await p.locator('#capture-desc').fill('חסר פרופיל פינה בסלון');
  await p.getByRole('button', { name: 'שמור והמשך' }).click();
  await p.locator('.toast').waitFor();
  await p.locator('.toast').waitFor({ state: 'detached' });

  // 7. Isolation between the two projects.
  await tab(p, 'ממצאים');
  // Wide screens open on the management table (M6); this checks the list view.
  await p.locator('.view-tabs button', { hasText: /^ממצאים$/ }).click();
  await p.locator('.item').first().waitFor();
  const yamFindings = await p.locator('.item').allTextContents();
  check('ברשימת הממצאים רק ממצאי הפרויקט הנבחר', yamFindings.length === 1 && yamFindings[0].includes('דירה 34'), yamFindings.join(' | '));
  await manageProject(p, 'מגדלי הפארק');
  await tab(p, 'ממצאים');
  // Wide screens open on the management table (M6); this checks the list view.
  await p.locator('.view-tabs button', { hasText: /^ממצאים$/ }).click();
  await p.locator('.item').first().waitFor();
  const demoFindings = await p.locator('.item').allTextContents();
  check('בפרויקט ההדגמה רק הממצא שלו (נשמר מלפני M3)', demoFindings.length === 1 && demoFindings[0].includes('ממצא בפרויקט ההדגמה'), demoFindings.join(' | '));
  await tab(p, 'תיעוד');
  await captureReady(p);
  const demoContractors = await p.locator('.drow-select option').allTextContents();
  check('בפרויקט ההדגמה קבלני ההדגמה בלבד', demoContractors.length === 10 && !demoContractors.includes('גבס הים בע״מ'), `${demoContractors.length - 1} קבלנים`);
  await tab(p, 'דוחות');
  await p.locator('.reports select option').first().waitFor({ state: 'attached' });
  const scopes = await p.locator('.reports select option').allTextContents();
  check('היקפי הדוח מהפרויקט הנבחר בלבד', scopes.includes('בניין A') && !scopes.includes('בניין צפוני'), scopes.slice(0, 4).join(', '));
  await p.waitForTimeout(2500); // auto-sync
  const srvFindings = await server_<{ project_id: string; description: string; contractor_id: string }>('findings', (b) => b.select('*').in('project_id', [demoId, yam.id]));
  check('בשרת: כל ממצא בפרויקט שלו, עם הקבלן הנכון', srvFindings.length === 2 && srvFindings.some((f) => f.project_id === yam.id && f.contractor_id === gypsum.id) && srvFindings.some((f) => f.project_id === demoId), `${srvFindings.length} ממצאים`);

  // 8. Delete protection.
  await manageProject(p, 'מגדלי הים');
  await section(p, 'מבנה');
  await p.locator('.st-root', { hasText: 'בניין צפוני' }).getByRole('button', { name: 'דירה 34', exact: true }).click();
  const blocked = await sheet(p).locator('.alert.warn').textContent();
  check('אין אפשרות למחוק יחידה עם ממצאים', !!blocked?.includes('לא ניתן למחוק') && (await sheet(p).getByRole('button', { name: /^מחק/ }).count()) === 0, blocked ?? '');
  await closeSheet(p);
  await p.locator('.st-root', { hasText: 'בניין צפוני' }).locator('.st-head').click();
  check('אין אפשרות למחוק בניין שיש ממצאים באחת מדירותיו', !!(await sheet(p).locator('.alert.warn').textContent())?.includes('לא ניתן למחוק'));
  await closeSheet(p);

  // 9. Offline after sync: the new project's setup is on the device; editing waits for a connection.
  await setOffline(ctx, p, true);
  await p.reload();
  await p.locator('nav.tabs').waitFor({ timeout: 20000 });
  await tab(p, 'תיעוד');
  await captureReady(p);
  await p.locator('.locbar .loc').click();
  await p.getByLabel('חיפוש מיקום').fill('302');
  await p.locator('.picker-result').first().click();
  await p.locator('.chips .chip', { hasText: 'חשמל' }).first().click();
  const offContractor = await p.locator('.drow-select option:checked').textContent();
  await p.locator('#capture-desc').fill('ממצא ללא חיבור בפרויקט החדש');
  await p.getByRole('button', { name: 'שמור והמשך' }).click();
  await p.locator('.toast').waitFor();
  check('ללא חיבור: מבנה הפרויקט החדש, הקבלנים וברירות המחדל זמינים בתיעוד', offContractor === 'לוי חשמל ותקשורת', offContractor ?? '');
  await manageProject(p, 'מגדלי הים');
  if (ENGINE === 'chromium') {
    const offNote = await p.locator('.setup .alert.info').first().textContent();
    check('ללא חיבור: מסך הפרויקט לקריאה בלבד עם הסבר', !!offNote?.includes('דורשת חיבור') && (await p.getByRole('button', { name: '+ בניין (מחולל)' }).count()) === 0, offNote ?? '');
  } else {
    // WebKit's offline is a dropped connection while the browser still reports "online" — like Wi-Fi
    // without internet. An edit must then fail with a clear message and change nothing.
    await p.getByRole('button', { name: '+ אזור / פיתוח' }).click();
    await sheet(p).getByRole('button', { name: 'צור אזור' }).click();
    const msg = await sheet(p).locator('.alert.error').textContent();
    await closeSheet(p);
    check('חיבור שנפל באמצע עריכה: הודעה ברורה, בלי שינוי', !!msg?.includes('אין חיבור'), msg ?? '');
  }
  await setOffline(ctx, p, false);
  await tab(p, 'הגדרות');
  await p.getByRole('button', { name: 'סנכרן עכשיו' }).click();
  await p.locator('.log div').first().waitFor({ timeout: 30000 });
  const offSynced = await server_('findings', (b) => b.select('id').eq('project_id', yam.id));
  check('הממצא שנרשם ללא חיבור סונכרן לפרויקט הנכון', offSynced.length === 2);

  // 10. Archive.
  await manageProject(p, 'מגדלי הים');
  await section(p, 'פרטי פרויקט');
  await p.getByRole('button', { name: 'העבר לארכיון' }).click();
  await p.locator('.archived summary').waitFor();
  const afterArchive = await p.locator('.ph-card.is-current h3').textContent();
  check('פרויקט בארכיון יוצא מהתיעוד והפרויקט הפעיל מתחלף', !!afterArchive?.includes('הדגמה'), afterArchive ?? '');
  await p.locator('.archived summary').click();
  await p.locator('.archived').getByRole('button', { name: 'החזר לפעילות' }).click();
  await p.locator('.archived').waitFor({ state: 'detached' });
  check('החזרה מארכיון', (await server_<{ status: string }>('projects', (b) => b.select('status').eq('id', yam.id)))[0]?.status === 'active');

  // WebKit also reports a request whose connection was dropped (the offline step) as a page error,
  // even when the app catches the failure; only those network reports are excluded here.
  const jsErrors = errors.filter((e) => !(ENGINE === 'webkit' && /^Fetch API cannot load .* due to access control checks/.test(e.split(' @ ')[1] ?? '')));
  check('אין שגיאות JavaScript בדף', jsErrors.length === 0, jsErrors.join(' | ') || `${errors.length - jsErrors.length} דיווחי רשת מהשלב ללא חיבור`);
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
