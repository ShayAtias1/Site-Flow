// Acceptance tests (Phase 0 + M1 sign-in), run against a real browser engine, a fresh local
// sync server and the local Supabase (`npx supabase start`) for authentication.
// Usage: tsx scripts/poc-tests.ts [chromium|webkit]
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright';

const ENGINE = (process.argv[2] ?? 'chromium') as 'chromium' | 'webkit';
const engine = ENGINE === 'webkit' ? webkit : chromium;
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const ROOT = new URL('../', import.meta.url).pathname;
const OUT = `${ROOT}poc-output/test-${ENGINE}/`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------- local Supabase (auth) ----------
// Keys come from the CLI at runtime; test users exist only in the local stack, with random passwords.
const sb = JSON.parse(execSync('npx supabase status -o json', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
const SB_URL: string = sb.API_URL;
const SB_ANON: string = sb.PUBLISHABLE_KEY ?? sb.ANON_KEY;
const sbAdmin = createClient(SB_URL, sb.SECRET_KEY ?? sb.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const KONG = 'supabase_kong_siteflow';

async function createTestUser(name: string) {
  const email = `${name}-${randomBytes(4).toString('hex')}@siteflow.test`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await sbAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`create ${name}: ${error.message}`);
  return { id: data.user.id, email, password };
}

/** Makes Supabase unreachable / reachable again (a real outage, works the same in every engine). */
async function supabaseDown(down: boolean) {
  execSync(`docker ${down ? 'stop' : 'start'} ${KONG}`, { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${SB_URL}/auth/v1/health`, { headers: { apikey: SB_ANON } }).then((r) => r.ok, () => false);
    if (up !== down) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`supabase did not go ${down ? 'down' : 'up'}`);
}

// The app under test is built against the local Supabase into its own folder. It reaches Supabase
// through the test server's /sb proxy, so one device can be taken offline in every engine.
const DIST = `${ROOT}dist-test`;
function buildApp() {
  execSync(`npx vite build --outDir ${DIST} --emptyOutDir`, {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: `${BASE}/sb`, VITE_SUPABASE_PUBLISHABLE_KEY: SB_ANON, VITE_TEST_HOOKS: "1" },
  });
}

/** An organization with the user as engineer and the demo project, as an admin would set it up. */
async function setupOrg(email: string) {
  const orgName = `ארגון בדיקה ${randomBytes(3).toString('hex')}`;
  const org = await sbAdmin.rpc('admin_add_member', { p_email: email, p_org_name: orgName, p_role: 'engineer' });
  if (org.error) throw new Error(org.error.message);
  const project = await sbAdmin.rpc('admin_seed_demo_project', { p_org_name: orgName });
  if (project.error) throw new Error(project.error.message);
  return { orgId: org.data as string, projectId: project.data as string };
}

/** A signed-in Supabase client for the test user (local stack only). */
async function signedInClient(u: { email: string; password: string }) {
  const c = createClient(SB_URL, SB_ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword(u);
  if (error) throw new Error(error.message);
  return c;
}

let PROJECT_ID = '';
/** The server's view of the test project's findings (service role, bypasses RLS). */
async function serverFindings() {
  const { data, error } = await sbAdmin.from('findings').select('*').eq('project_id', PROJECT_ID).order('display_no');
  if (error) throw new Error(error.message);
  return data as { id: string; description: string; status: string; display_no: number; version: number; deleted_at: string | null }[];
}
const download = async (bucket: string, path: string) =>
  Buffer.from(await (await sbAdmin.storage.from(bucket).download(path)).data!.arrayBuffer());

// ---------- server ----------
let server: ChildProcess | undefined;
async function startServer() {
  const stale = await fetch(`${BASE}/api/health`).then(() => true, () => false);
  if (stale) throw new Error(`port ${PORT} is already in use — a previous test server is still running`);
  server = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      SITEFLOW_TEST: '1',
      SITEFLOW_DIST: DIST,
      SITEFLOW_SUPABASE_URL: SB_URL,
      SITEFLOW_SUPABASE_KEY: SB_ANON,
    },
    stdio: 'ignore',
    // Its own process group, so stopping it also stops the node process npx starts.
    detached: true,
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}
const killServer = (signal: NodeJS.Signals) => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, signal);
    } catch {
      /* already gone */
    }
  }
};
async function stopServer() {
  killServer('SIGTERM');
  for (let i = 0; i < 50; i++) {
    if (!(await fetch(`${BASE}/api/health`).then(() => true, () => false))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Takes one device off the network. Chromium: real offline emulation.
 * WebKit: Playwright's offline mode breaks service-worker pages, so the server
 * drops that device's connections instead (the app sees the same network errors).
 */
async function netOff(ctx: BrowserContext, page: Page) {
  if (ENGINE === 'chromium') return ctx.setOffline(true);
  await setDeviceOffline(page, true);
}
async function netOn(ctx: BrowserContext, page: Page) {
  if (ENGINE === 'chromium') return ctx.setOffline(false);
  await setDeviceOffline(page, false);
}
async function setDeviceOffline(page: Page, offline: boolean | 'data') {
  const device = await page.evaluate(() => localStorage.getItem('sf.installId'));
  await fetch(`${BASE}/api/__test/offline`, { method: 'POST', body: JSON.stringify({ device, offline }) });
}

async function stats() {
  const photos = await sbAdmin.from('photos').select('id', { count: 'exact', head: true }).in('finding_id', (await serverFindings()).map((f) => f.id));
  return { findings: (await serverFindings()).length, photos: photos.count ?? 0 };
}

// ---------- helpers ----------
async function photoFixtures(n: number) {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    await p.setContent(`<body style="margin:0;background:hsl(${i * 70},40%,55%);display:flex;align-items:center;justify-content:center;
      font:bold 120px Arial;color:#fff;height:900px">צילום ${i + 1}</body>`);
    out.push(await p.screenshot({ type: 'jpeg', quality: 85 }));
  }
  await b.close();
  return out;
}

const profiles: BrowserContext[] = [];
async function openProfile(dir: string, offline = false) {
  const ctx = await engine.launchPersistentContext(`${OUT}${dir}`, {
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
    serviceWorkers: 'allow',
  });
  profiles.push(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (offline && ENGINE === 'chromium') await ctx.setOffline(true); // WebKit: the device is still marked offline on the server
  return { ctx, page };
}
async function close(ctx: BrowserContext) {
  await ctx.close();
  profiles.splice(profiles.indexOf(ctx), 1);
}

async function load(page: Page) {
  await page.goto(BASE, { waitUntil: 'load' });
  await appReady(page);
}
const appReady = (page: Page) =>
  page.getByText('שמור והמשך').or(page.getByText('ממצאים במכשיר')).or(page.locator('.settings-screen')).or(page.locator('.login-card')).or(page.locator('.start-tour')).first().waitFor();

/** (M4) Capture starts with a tour: continue an open one, or start one. */
async function ensureTour(page: Page) {
  const form = page.getByText('שמור והמשך');
  const start = page.locator('.start-tour');
  if (!(await form.or(start).first().waitFor({ timeout: 20000 }).then(() => true, () => false))) return;
  if (!(await start.isVisible())) return;
  const cont = start.getByRole('button', { name: /^המשך:/ });
  if (await cont.count()) await cont.first().click();
  else await start.getByRole('button', { name: 'התחל סיור' }).click();
  await form.waitFor();
}
const onLogin = (page: Page) => page.locator('.login-card').isVisible();

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.locator('.login-card input[type=email]').fill(user.email);
  await page.locator('.login-card input[type=password]').fill(user.password);
  await page.locator('.login-card button[type=submit]').click();
  // The app reopens on the last tab, so "signed in" means the main navigation is shown.
  await page.locator('nav.tabs').or(page.locator('.login-card .alert.error')).first().waitFor();
  if (await page.locator('nav.tabs').isVisible()) await ensureTour(page);
}
// With registerType 'prompt' the first service worker does not claim the open page,
// so (as on a real first install) the app is controlled from the next load on.
async function waitForSW(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await load(page);
}
const tab = (page: Page, name: string) => page.locator('nav.tabs button', { hasText: name }).click();

// Capture-form fields, located by id and label rather than by styling classes.
const captureDesc = (page: Page) => page.locator('#capture-desc');
const captureDetail = (page: Page) => page.locator('.capture').getByLabel('מיקום מדויק');

async function addFinding(page: Page, desc: string, opts: { category?: string; photos?: Buffer[]; critical?: boolean } = {}) {
  await page.locator('.chips .chip', { hasText: opts.category ?? 'חשמל' }).first().click();
  await captureDesc(page).fill(desc);
  await captureDetail(page).fill('חדר שינה הורים');
  if (opts.critical) await page.locator('.seg.cls button.critical').click();
  if (opts.photos?.length) {
    const before = await page.locator('.photos .thumb').count();
    await page.locator('input[type=file][accept="image/*"]').setInputFiles(
      opts.photos.map((buffer, i) => ({ name: `p${i}.jpg`, mimeType: 'image/jpeg', buffer })),
    );
    await page.locator('.photos .thumb').nth(before + opts.photos.length - 1).waitFor();
  }
  const t0 = Date.now();
  await page.getByRole('button', { name: 'שמור והמשך' }).click();
  await page.locator('.toast').waitFor();
  const ms = Date.now() - t0;
  await page.locator('.toast').waitFor({ state: 'detached' });
  return ms;
}

async function syncUI(page: Page) {
  await tab(page, 'הגדרות');
  const n = await page.locator('.log div').count();
  await page.getByRole('button', { name: 'סנכרן עכשיו' }).click();
  await page.locator('.log div').nth(n).waitFor({ timeout: 60000 });
  return (await page.locator('.log div').first().textContent()) ?? '';
}

const localState = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ findings: { id: string; dirty: number; displayNo: number | null; description: string; status: string; conflict: unknown; version: number; syncError: { attempts: number; blocked: boolean } | null }[]; photos: { id: string; uploaded: number; size: number; sha256: string }[] }>(
        (resolve, reject) => {
          const req = indexedDB.open('siteflow');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['findings', 'photos'], 'readonly');
            const f = tx.objectStore('findings').getAll();
            const p = tx.objectStore('photos').getAll();
            tx.oncomplete = () => {
              resolve({
                findings: f.result.map((x) => ({ id: x.id, dirty: x.dirty, displayNo: x.displayNo, description: x.description, status: x.status, conflict: x.conflict, version: x.version, syncError: x.syncError ?? null })),
                photos: p.result.map((x) => ({ id: x.id, uploaded: x.uploaded, size: x.size, sha256: x.sha256 })),
              });
              db.close();
            };
          };
        },
      ),
  );

async function editFinding(page: Page, id: string, patch: { description?: string; status?: string }) {
  await tab(page, 'ממצאים');
  await page.locator(`.item[data-id="${id}"]`).click();
  if (patch.description !== undefined) await page.locator('.sheet textarea.desc').fill(patch.description);
  if (patch.status) await page.locator('.sheet .field', { hasText: 'סטטוס' }).locator('select').selectOption(patch.status);
  await page.getByRole('button', { name: 'שמור שינויים' }).click();
  await page.locator('.sheet').waitFor({ state: 'detached' });
}

// ---------- tests ----------
async function main() {
  console.log(`\n=== SiteFlow tests (PoC + M1 sign-in) — engine: ${ENGINE} ===\n`);
  buildApp();
  await startServer();
  const photos = await photoFixtures(6);
  const user = await createTestUser('engineer');
  const otherUser = await createTestUser('other');
  PROJECT_ID = (await setupOrg(user.email)).projectId;

  // 0. Sign-in (M1): nothing without an account; first sign-in needs the network.
  let { ctx: A, page: a } = await openProfile('profile-A');
  await load(a);
  check('בלי כניסה מוצג מסך התחברות בלבד', (await onLogin(a)) && !(await a.locator('nav.tabs').isVisible()));
  await signIn(a, { email: user.email, password: 'wrong-password-123' });
  const badLogin = await a.locator('.login-card .alert.error').textContent();
  check('סיסמה שגויה נדחית', !!badLogin?.includes('שגויים') && (await onLogin(a)), badLogin ?? '');
  await signIn(a, user);
  check('כניסה במייל וסיסמה', await a.locator('nav.tabs').isVisible() && !(await onLogin(a)));
  // (M2) The project's setup comes from Supabase on the first sync after sign-in.
  const setupArrived = await a.getByText('שמור והמשך').waitFor({ timeout: 20000 }).then(() => true, () => false);
  const unitsShown = await a.locator('.locbar .loc-name').textContent().catch(() => '');
  check('הגדרות הפרויקט נמשכו מהשרת למכשיר', setupArrived && !!unitsShown, unitsShown ?? '');

  // 1. Install: service worker takes control, then the app loads with no network.
  await waitForSW(a);
  const persisted = await a.evaluate(async () => (navigator.storage?.persist ? navigator.storage.persist() : null));
  check('Service Worker נרשם ושולט בדף', await a.evaluate(() => !!navigator.serviceWorker.controller));
  // Informational only: browsers grant persistence by their own heuristics; the iPhone result is what matters.
  console.log(`INFO  בקשת אחסון קבוע: persist() → ${persisted} (נבדק בפועל רק באייפון)`);
  // Cold start with the server unreachable: the shell must come from the service worker cache.
  await stopServer();
  await a.reload();
  const shell = await a.getByText('שמור והמשך').waitFor({ timeout: 10000 }).then(() => true, () => false);
  check('האפליקציה נטענת מחדש כשהשרת לא זמין', shell, 'השרת כבוי לגמרי בזמן הטעינה');
  await startServer();
  await netOff(A, a);

  // 2. Capture 20 findings offline, 4 of them with photos.
  const times: number[] = [];
  for (let i = 1; i <= 20; i++) {
    if (i % 4 === 0) await a.getByRole('button', { name: 'היחידה הבאה' }).click();
    times.push(
      await addFinding(a, `ממצא בדיקה ${i} — חסר שקע 16A (120 ס״מ)`, {
        category: i % 2 ? 'חשמל' : 'אינסטלציה',
        photos: i % 5 === 0 ? [photos[i % 6], photos[(i + 1) % 6]] : undefined,
        critical: i === 7,
      }),
    );
  }
  let st = await localState(a);
  times.sort((x, y) => x - y);
  check('20 ממצאים נשמרו ב-IndexedDB ללא אינטרנט', st.findings.length === 20, `${st.findings.length} ממצאים, ${st.photos.length} תמונות`);
  check('זמן שמירה (חציון / מקסימום)', times[10] < 1000, `${times[10]}ms / ${times[19]}ms כולל רינדור המסך`);
  check('כל הממצאים ממתינים לסנכרון וללא מספר', st.findings.every((f) => f.dirty === 1 && f.displayNo === null));

  // 3. Draft survives an abrupt close (typed text + attached photo, closed ~immediately).
  await a.locator('.chips .chip', { hasText: 'ריצוף' }).first().click();
  await captureDesc(a).fill('טיוטה שלא נשמרה — חסר רובה');
  await a.locator('input[type=file][accept="image/*"]').setInputFiles({ name: 'd.jpg', mimeType: 'image/jpeg', buffer: photos[0] });
  await a.locator('.photos .thumb').first().waitFor();
  await captureDesc(a).fill('טיוטה שלא נשמרה — חסר רובה ליד האמבטיה');
  await a.waitForTimeout(60); // less than the 250ms debounce: relies on the pagehide/visibility flush
  await close(A);

  ({ ctx: A, page: a } = await openProfile('profile-A', true));
  await load(a);
  const restored = await captureDesc(a).inputValue();
  check('טיוטה שוחזרה אחרי סגירת הדפדפן', restored.includes('ליד האמבטיה'), `"${restored}"`);
  check('תמונת הטיוטה שוחזרה', (await a.locator('.photos .thumb').count()) === 1);
  st = await localState(a);
  check('כל 20 הממצאים קיימים אחרי פתיחה מחדש offline', st.findings.length === 20);

  // 3b. (M1) Expired access token and no way to reach Supabase: the app must stay usable.
  await a.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('sf.auth')!);
    s.expires_at = Math.floor(Date.now() / 1000) - 600;
    localStorage.setItem('sf.auth', JSON.stringify(s));
  });
  await supabaseDown(true);
  await a.reload();
  await appReady(a);
  const offlineBanner = await a.locator('.alert.info', { hasText: 'עובד ללא חיבור' }).isVisible();
  check('אחרי כניסה קודמת: נפתח ללא חיבור גם עם טוקן שפג', !(await onLogin(a)) && offlineBanner);
  check('הטיוטה נשמרה גם בפתיחה זו', (await captureDesc(a).inputValue()).includes('ליד האמבטיה'));

  // 4. A failed write keeps the user's text and reports the error. (Still offline, unverified session.)
  await a.evaluate(() => localStorage.setItem('sf.debug.failWrites', '1'));
  await a.getByRole('button', { name: 'שמור והמשך' }).click();
  const err = await a.locator('main .alert.error').textContent();
  const kept = await captureDesc(a).inputValue();
  check('כשל שמירה (סימולציה) מוצג למשתמש', !!err?.includes('אין מספיק מקום'), err ?? '');
  check('הטקסט נשאר בטופס אחרי כשל', kept.includes('ליד האמבטיה'));
  check('לא נוצר ממצא חלקי', (await localState(a)).findings.length === 20);
  await a.evaluate(() => localStorage.removeItem('sf.debug.failWrites'));
  await a.getByRole('button', { name: 'שמור והמשך' }).click();
  await a.locator('.toast').waitFor();
  check('השמירה מצליחה אחרי שהכשל הוסר', (await localState(a)).findings.length === 21);
  check('תיעוד ממשיך ללא חיבור עם סשן שלא אומת', (await localState(a)).findings.length === 21);

  // 4b. (M1) Sign-out is refused while work exists only on this device.
  await tab(a, 'הגדרות');
  await a.getByRole('button', { name: 'יציאה מהחשבון' }).click();
  const refused = await a.locator('.log div', { hasText: 'יציאה נחסמה' }).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('יציאה נחסמת כשיש נתונים שלא סונכרנו', refused && !(await onLogin(a)));

  // 4c. (M1) Supabase reachable again: the session is refreshed and verified.
  await supabaseDown(false);
  // Only sign-in comes back here; data stays unreachable so the next steps still start unsynced.
  if (ENGINE === 'chromium') await A.setOffline(false);
  await setDeviceOffline(a, 'data');
  await a.reload();
  await appReady(a);
  const verified = await a.locator('.alert.info', { hasText: 'עובד ללא חיבור' }).waitFor({ state: 'detached', timeout: 15000 }).then(() => true, () => false);
  const expiresAt = await a.evaluate(() => JSON.parse(localStorage.getItem('sf.auth')!).expires_at as number);
  check('כשהחיבור חוזר הסשן מתחדש ומאומת', verified && expiresAt > Date.now() / 1000);
  // Back to fully offline (Chromium: browser offline; WebKit: the proxy drops this device).
  if (ENGINE === 'chromium') await A.setOffline(true);
  await setDeviceOffline(a, ENGINE === 'chromium' ? false : true);
  await tab(a, 'תיעוד');

  // 5. One photo's upload is cut off mid-way (every attempt, until released); it must stay pending
  // and succeed on retry. (A "sync now" also re-runs after an automatic sync already in progress.)
  let cutId: string | null = null;
  let cutting = true;
  const PHOTO_UPLOADS = '**/sb/storage/v1/object/photos/**';
  await a.route(PHOTO_UPLOADS, async (route) => {
    const name = route.request().url().split('/').pop() ?? '';
    if (route.request().method() === 'POST' && cutting && (cutId ??= name) === name) return route.abort('connectionreset');
    return route.continue();
  });
  await netOn(A, a);
  let log = await syncUI(a);
  st = await localState(a);
  // Request interception doesn't reach service-worker pages in Playwright's WebKit.
  if (ENGINE === 'chromium') {
    check('העלאה שנקטעה לא מסומנת כהועלתה', st.photos.some((p) => !p.uploaded), log);
    check('תמונה שנכשלה לא עוצרת את סנכרון הממצאים', st.findings.every((f) => !f.dirty && f.displayNo !== null));
  }
  else console.log('INFO  העלאה שנקטעה: נבדק ב-Chromium בלבד (מגבלת כלי הבדיקה ב-WebKit)');
  cutting = false;
  log = await syncUI(a);
  st = await localState(a);
  const s1 = await stats();
  check('סנכרון אחרי חזרת חיבור: כל הממצאים בשרת', s1.findings === 21 && st.findings.every((f) => !f.dirty), `שרת: ${s1.findings} ממצאים, ${s1.photos} תמונות · ${log}`);
  check('כל התמונות הועלו ואומתו (sha256)', st.photos.every((p) => p.uploaded) && s1.photos === st.photos.length);
  const nos = st.findings.map((f) => f.displayNo!).sort((x, y) => x - y);
  check('מספרים רצים וייחודיים הוקצו בשרת', nos.join() === Array.from({ length: 21 }, (_, i) => i + 1).join(), `1..${nos.at(-1)}`);
  const sample = st.photos[0];
  const stored = (await sbAdmin.from('photos').select('storage_path, sha256').eq('id', sample.id).single()).data!;
  const served = await download('photos', stored.storage_path);
  check('התמונה בשרת זהה ביט-לביט', createHash('sha256').update(served).digest('hex') === sample.sha256 && stored.sha256 === sample.sha256);
  await a.unroute(PHOTO_UPLOADS);

  // 6. Lost push response: the server applied the change but the phone never heard back.
  await tab(a, 'תיעוד');
  await addFinding(a, 'ממצא שתשובת הסנכרון שלו אבדה');
  let dropped = false;
  const PUSH = '**/sb/rest/v1/rpc/push_findings';
  await a.route(PUSH, async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch(); // reaches the server…
    return route.abort('connectionreset'); // …but the response is lost
  });
  await syncUI(a);
  await a.unroute(PUSH);
  await syncUI(a);
  st = await localState(a);
  const s2 = await stats();
  if (ENGINE !== 'chromium') console.log('INFO  תשובה שאבדה: ההשמטה מתבצעת רק ב-Chromium; כאן נבדק סנכרון רגיל');
  check(ENGINE === 'chromium' ? 'תשובה שאבדה לא יוצרת כפילות' : 'ממצא נוסף סונכרן ללא כפילות', s2.findings === 22 && st.findings.length === 22 && st.findings.every((f) => !f.dirty && !f.conflict), `שרת: ${s2.findings}`);

  // 7. Two devices: phone (A, offline) and desktop (B, online).
  const { ctx: B, page: b } = await openProfile('profile-B');
  await load(b);
  await signIn(b, user);
  await syncUI(b);
  check('המחשב קיבל את כל הממצאים', (await localState(b)).findings.length === 22);
  const target = st.findings.find((f) => f.displayNo === 3)!;
  const other = st.findings.find((f) => f.displayNo === 4)!;

  await netOff(A, a);
  await editFinding(a, target.id, { description: 'נוסח מהאייפון' });
  await editFinding(a, other.id, { status: 'reported_done' }); // different field from B's edit
  await editFinding(b, target.id, { description: 'נוסח מהמחשב' });
  await editFinding(b, other.id, { description: 'תיאור שעודכן במחשב' });
  await syncUI(b);
  await netOn(A, a);
  log = await syncUI(a);
  st = await localState(a);
  const serverTarget = (await serverFindings()).find((r) => r.id === target.id)!;
  const tA = st.findings.find((f) => f.id === target.id)!;
  check('עריכה סותרת מזוהה כהתנגשות', !!tA.conflict, log);
  check('אין דריסה שקטה: השרת שומר את נוסח המחשב', serverTarget.description === 'נוסח מהמחשב');
  check('האייפון שומר את הנוסח שלו עד להחלטה', tA.description === 'נוסח מהאייפון');
  const oA = st.findings.find((f) => f.id === other.id)!;
  check('עריכות בשדות שונים מוזגו אוטומטית', oA.status === 'reported_done' && oA.description === 'תיאור שעודכן במחשב' && !oA.dirty, `סטטוס: ${oA.status}, תיאור: ${oA.description}`);
  await tab(a, 'ממצאים');
  const shown = await a.locator('.tag.danger').first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('ההתנגשות מוצגת למשתמש', shown);
  await a.locator(`.item[data-id="${target.id}"]`).click();
  await a.locator('.conflict-field[data-field="description"] .opt').first().click();
  await a.getByRole('button', { name: 'שמור החלטה' }).click();
  await syncUI(a);
  await syncUI(b);
  const tB = (await localState(b)).findings.find((f) => f.id === target.id)!;
  check('אחרי החלטה: הנוסח שנבחר הגיע לשרת ולמחשב', tB.description === 'נוסח מהאייפון' && !tB.conflict, `גרסה ${tB.version}`);

  // 8. Reports — issued from the app (Reports tab), stored in Supabase, frozen at issue time.
  await tab(b, 'דוחות');
  const issueFromApp = async (button: string) => {
    const before = await b.locator('.reports a.item').count();
    // UX-04: choose the report type, then the single "הפק דוח" action.
    await b.getByRole('radio', { name: new RegExp(button) }).click();
    await b.getByRole('button', { name: 'הפק דוח' }).click();
    await b.locator('.reports a.item').nth(before).waitFor({ timeout: 120000 });
    const latest = await sbAdmin.from('reports').select('*').eq('project_id', PROJECT_ID).order('issued_at', { ascending: false }).limit(1).single();
    return latest.data as { id: string; number: string; finding_count: number; pdf_path: string; pdf_sha256: string; snapshot: unknown };
  };
  const t0 = Date.now();
  const rt = await issueFromApp('דוח טבלאי מרוכז');
  const rd = await issueFromApp('פרוטוקול מפורט');
  const genMs = Date.now() - t0;
  const pdfT = await download('reports', rt.pdf_path);
  const pdfD = await download('reports', rd.pdf_path);
  writeFileSync(`${OUT}report-table.pdf`, pdfT);
  writeFileSync(`${OUT}report-detailed.pdf`, pdfD);
  check('שני הדוחות הופקו מהאפליקציה מנתוני Supabase', rt.finding_count === 22 && rd.finding_count === 22, `${rt.number}, ${rd.number}, ${genMs}ms`);
  const links = await b.locator('.reports a.item').evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href));
  const linkOk = links.length >= 2 && links.every((h) => h.includes('/storage/v1/object/sign/reports/'));
  const viaLink = linkOk ? Buffer.from(await (await fetch(links[0].replace(`${BASE}/sb`, SB_URL))).arrayBuffer()) : Buffer.alloc(0);
  check('רשימת הדוחות באפליקציה מציגה קישור חתום ל-PDF', linkOk && viaLink.subarray(0, 4).toString() === '%PDF');
  const txtT = await pdfText(pdfT);
  const txtD = await pdfText(pdfD);
  const hebrew = (t: { pages: number; text: string }) =>
    t.pages >= 2 && ['עמוד', 'מתוך', 'מגדלי', 'בדיקה', 'הבהרה', 'חתימה', 'פרוטוקול'].every((w) => t.text.includes(w));
  check('PDF טבלאי: עברית, מספור עמודים, הצהרה וחתימה', hebrew(txtT) && txtT.text.includes('ליקויים'), `${txtT.pages} עמודים`);
  check('PDF מפורט: עברית, מספור עמודים, הצהרה וחתימה', hebrew(txtD), `${txtD.pages} עמודים`);
  // Chromium stores identical images once, so count images drawn on the pages, not image objects.
  const snapD = rd.snapshot as { findings: { photoIds: string[] }[] };
  const photoRefs = snapD.findings.reduce((n, f) => n + f.photoIds.length, 0);
  // No report settings in this organization: no logo or signature, so every drawn image is a finding photo.
  check('PDF מפורט כולל את כל תמונות הממצאים (מהאחסון הפרטי)', photoRefs > 0 && txtD.images === photoRefs, `${txtD.images} תמונות שצוירו, ${photoRefs} בדוח`);
  check('PDF טבלאי ללא תמונות', txtT.images === 0);
  const snapBefore = JSON.stringify(rd.snapshot);
  await editFinding(b, target.id, { description: 'שינוי אחרי הפקת הדוח' });
  await syncUI(b);
  const pdfD2 = await download('reports', rd.pdf_path);
  const snapAfter = JSON.stringify((await sbAdmin.from('reports').select('snapshot').eq('id', rd.id).single()).data!.snapshot);
  const sha = (x: Buffer) => createHash('sha256').update(x).digest('hex');
  check('עריכה מאוחרת לא שינתה את ה-PDF שהונפק', sha(pdfD) === sha(pdfD2) && sha(pdfD) === rd.pdf_sha256);
  check('תמונת המצב של הדוח לא השתנתה', snapBefore === snapAfter && !snapAfter.includes('שינוי אחרי הפקת הדוח'));
  const tamper = await sbAdmin.from('reports').update({ title: 'x' }).eq('id', rd.id);
  check('מסד הנתונים חוסם שינוי של דוח שהונפק (גם למפתח שירות)', !!tamper.error, tamper.error?.message);
  const userSb = await signedInClient(user);
  const pdfOverwrite = await userSb.storage.from('reports').upload(rd.pdf_path, new Blob([pdfT], { type: 'application/pdf' }), { upsert: true });
  check('אי אפשר לדרוס PDF שהונפק', !!pdfOverwrite.error);
  const noAuth = await fetch(`${BASE}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: PROJECT_ID, format: 'table', scope: { type: 'project' } }) });
  check('שירות הדוחות דורש כניסה', noAuth.status === 401);

  // 9. Backup rescues work that exists only on one device: A records a finding offline, exports a
  //    backup; device C (signed in, synced) restores it, and from C it reaches the server.
  await netOff(A, a);
  await tab(a, 'תיעוד');
  await addFinding(a, 'ממצא שקיים רק בגיבוי', { photos: [photos[2]] });
  const onlyInBackup = (await localState(a)).findings.find((f) => f.description === 'ממצא שקיים רק בגיבוי')!;
  await tab(a, 'הגדרות');
  await a.evaluate(() => {
    (navigator as unknown as { canShare?: unknown }).canShare = undefined;
  });
  const [dl] = await Promise.all([a.waitForEvent('download'), a.getByRole('button', { name: 'ייצוא גיבוי' }).click()]);
  const backupPath = `${OUT}${dl.suggestedFilename()}`;
  await dl.saveAs(backupPath);
  const { ctx: C, page: c } = await openProfile('profile-C');
  await load(c);
  await signIn(c, user);
  await waitForSW(c);
  await syncUI(c);
  const beforeRestore = (await localState(c)).findings.length;
  await netOff(C, c); // the restore itself needs no connection
  await c.locator('input[type=file][accept*="json"]').setInputFiles(backupPath);
  await c.locator('.log div', { hasText: 'שחזור' }).first().waitFor();
  const restored9 = (await localState(c)).findings.find((f) => f.id === onlyInBackup.id);
  check('שחזור מגיבוי מוסיף ממצא שלא היה בשרת (ללא חיבור)', !!restored9 && restored9.dirty === 1 && (await localState(c)).findings.length === beforeRestore + 1,
    (await c.locator('.log div', { hasText: 'שחזור' }).first().textContent()) ?? '');
  await netOn(C, c);
  await syncUI(c);
  const rescued = (await serverFindings()).find((f) => f.id === onlyInBackup.id);
  const rescuedPhoto = await sbAdmin.from('photos').select('id').eq('finding_id', onlyInBackup.id);
  check('הממצא והתמונה מהגיבוי הגיעו לשרת', !!rescued && (rescuedPhoto.data?.length ?? 0) === 1, `#${rescued?.display_no}`);

  // 10. Storage wiped behind the app's back is detected, and synced data comes back from the server.
  await c.evaluate(() => new Promise((r) => {
    const req = indexedDB.deleteDatabase('siteflow');
    req.onsuccess = req.onerror = req.onblocked = () => r(null);
  }));
  await netOn(C, c);
  await c.reload();
  await c.locator('.alert.error', { hasText: 'נתוני המכשיר נמחקו' }).waitFor({ timeout: 10000 });
  check('מחיקת IndexedDB מזוהה ומוצגת אזהרה', true);
  await syncUI(c);
  check('נתונים מסונכרנים שוחזרו מהשרת', (await localState(c)).findings.length === (await serverFindings()).length, `${(await localState(c)).findings.length} ממצאים`);

  // 11. One bad record must not sink the batch. (Run last: it adds findings to the server.)
  const before = (await stats()).findings;
  const sampleRow = (await serverFindings())[0] as unknown as Record<string, string | null>;
  // A valid finding in the client's shape, built from a real server row.
  const data = {
    projectId: sampleRow.project_id, tourId: null, batchId: null, locationId: sampleRow.location_id,
    locationDetail: sampleRow.location_detail, categoryId: sampleRow.category_id ?? '', contractorId: sampleRow.contractor_id ?? '',
    classification: 'missing', description: 'רשומת בדיקה', status: 'open', photoIds: [], deletedAt: null,
  };
  const wire = { ...data, categoryId: data.categoryId || null, contractorId: data.contractorId || null };
  const change = (id: string, baseVersion: number) => ({ id, baseVersion, createdAt: new Date().toISOString(), data: wire });
  const rpc = await userSb.rpc('push_findings', { p_changes: [change(randomUUID(), 0), change(randomUUID(), 4), change(randomUUID(), 0)] });
  const pushRes = { results: (rpc.data ?? []) as { status: string }[] };
  check(
    'רשומה פגומה לא מבטלת את האצווה (שרת)',
    pushRes.results.map((r) => r.status).join() === 'ok,error,ok' && (await stats()).findings === before + 2,
    pushRes.results.map((r) => r.status).join(', '),
  );

  // Same through the app: a record the server rejects stays pending; a good edit next to it still syncs.
  const badId = randomUUID();
  await b.evaluate(
    ({ badId, row }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('siteflow');
        req.onsuccess = () => {
          const tx = req.result.transaction('findings', 'readwrite');
          tx.objectStore('findings').put({
            ...row, id: badId, version: 4, base: null, dirty: 1, rev: 1, conflict: null, displayNo: null,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          });
          tx.oncomplete = () => { req.result.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { badId, row: data },
  );
  await editFinding(b, other.id, { description: 'עריכה שנשלחה לצד רשומה פגומה' });
  log = await syncUI(b);
  const stB = await localState(b);
  const serverOther = (await serverFindings()).find((r) => r.id === other.id)!;
  check('עריכה תקינה סונכרנה למרות רשומה פגומה באותה אצווה', serverOther.description === 'עריכה שנשלחה לצד רשומה פגומה', log);
  check('הרשומה הפגומה נשארה ממתינה במכשיר', stB.findings.find((f) => f.id === badId)?.dirty === 1);
  const warned = await b.locator('.alert', { hasText: 'השרת דחה' }).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('המשתמש רואה שרשומה נדחתה', warned);

  // 11b. (M1) A permanently rejected record is not resent without limit.
  const rejection = async () => (await localState(b)).findings.find((f) => f.id === badId)?.syncError;
  for (let i = 0; i < 3 && !(await rejection())?.blocked; i++) await syncUI(b);
  const blockedState = await rejection();
  check('אחרי 3 דחיות הרשומה נחסמת', blockedState?.blocked === true && blockedState.attempts === 3, JSON.stringify(blockedState));
  await syncUI(b);
  await syncUI(b);
  check('רשומה חסומה לא נשלחת שוב', (await rejection())?.attempts === 3);
  const blockedAlert = await b.locator('.alert', { hasText: 'נדחו בסנכרון' }).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('המשתמש רואה שהרשומה חסומה', blockedAlert);
  await editFinding(b, badId, { description: 'ניסיון חוזר אחרי עריכה' });
  check('עריכה משחררת את החסימה', !(await rejection()));
  await syncUI(b);
  const retried = await rejection();
  check('אחרי עריכה הרשומה נשלחת שוב (וסופרת מחדש)', !!retried && !retried.blocked && retried.attempts < 3, JSON.stringify(retried));

  // 12. (M1) Session revoked on the server: back to sign-in, nothing on the device is lost.
  const beforeRelogin = (await localState(c)).findings;
  const countBefore = beforeRelogin.length;
  const token = await c.evaluate(() => JSON.parse(localStorage.getItem('sf.auth')!).access_token as string);
  await sbAdmin.auth.admin.signOut(token, 'global');
  await c.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('sf.auth')!);
    s.expires_at = Math.floor(Date.now() / 1000) - 600;
    localStorage.setItem('sf.auth', JSON.stringify(s));
  });
  await c.reload();
  await appReady(c);
  const revokedMsg = await c.locator('.login-card .alert.warn').textContent().catch(() => '');
  check('סשן שבוטל בשרת מחזיר למסך כניסה', (await onLogin(c)) && !!revokedMsg?.includes('הסתיים'), revokedMsg ?? '');
  check('הנתונים במכשיר נשמרו אחרי ביטול הסשן', (await localState(c)).findings.length === countBefore);
  await signIn(c, user);
  const reLogin = await onLogin(c);
  const after = (await localState(c)).findings;
  const ids = new Set(after.map((f) => f.id));
  // Same data: every finding the device had is still there (the sync after sign-in may add newer ones from the server).
  check('כניסה מחדש מחזירה לאותם נתונים', !reLogin && beforeRelogin.every((f) => ids.has(f.id)), `${after.length} ממצאים (לפני: ${countBefore})`);

  // 13. (M1) The device's data belongs to its user: another account cannot open it.
  await tab(c, 'הגדרות');
  await c.getByRole('button', { name: 'יציאה מהחשבון' }).click();
  await c.locator('.login-card').waitFor();
  await signIn(c, otherUser);
  const guard = await c.locator('.login-card .alert.error').textContent().catch(() => '');
  check('משתמש אחר לא נכנס למכשיר עם נתונים של משתמש קודם', (await onLogin(c)) && !!guard?.includes('משתמש אחר'), guard ?? '');

  for (const p of [...profiles]) await close(p);
  for (const u of [user, otherUser]) await sbAdmin.auth.admin.deleteUser(u.id);
}

/** Text of every page, via pdf.js. Hebrew comes out in visual word order, so checks look for single words. */
async function pdfText(pdf: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  const parts: string[] = [];
  const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject]);
  let images = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
    images += (await page.getOperatorList()).fnArray.filter((op) => imageOps.has(op)).length;
  }
  return { pages: doc.numPages, text: parts.join('\n'), images };
}

try {
  await main();
} catch (e) {
  check('הרצת הבדיקות', false, (e as Error).stack ?? String(e));
} finally {
  for (const p of [...profiles]) await p.close().catch(() => {});
  killServer('SIGKILL');
  const failed = results.filter((r) => !r.ok);
  writeFileSync(`${OUT}results.json`, JSON.stringify({ engine: ENGINE, at: new Date().toISOString(), results }, null, 1));
  console.log(`\n${results.length - failed.length}/${results.length} passed (${ENGINE})`);
  process.exit(failed.length ? 1 : 0);
}
