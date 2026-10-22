// M6–M9 acceptance tests on a realistic dataset (hundreds of findings, real-size photos, long Hebrew and
// mixed Hebrew/English text, several contractors, tours and statuses):
//   M6 findings management table — search, filters, sorting, inline and bulk editing with history,
//      concurrent changes during a bulk edit, delete/restore, details, project isolation, performance;
//   M7 reports — branding settings, both formats with scope/filters/grouping, revisions, archive,
//      download, distribution log, immutability;
//   M8 Excel export — filtered and selected rows, RTL sheet, types, formula injection;
//   M9 security — RLS isolation, viewer limits, private storage, no secrets in the bundle.
// Runs against the local Supabase with throwaway users and organizations.
// Usage: tsx scripts/m9-tests.ts [chromium|webkit]
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { chromium, webkit, type BrowserContext, type Locator, type Page } from 'playwright';

const ENGINE = (process.argv[2] ?? 'chromium') as 'chromium' | 'webkit';
const engine = ENGINE === 'webkit' ? webkit : chromium;
const PORT = 8795;
const BASE = `http://localhost:${PORT}`;
const ROOT = new URL('../', import.meta.url).pathname;
const OUT = `${ROOT}poc-output/m9-${ENGINE}/`;
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
const SB_SECRET: string = sb.SECRET_KEY ?? sb.SERVICE_ROLE_KEY;
const sbAdmin = createClient(SB_URL, SB_SECRET, { auth: { persistSession: false } });

const DIST = `${ROOT}dist-test-m9`;
let server: ChildProcess | undefined;
async function startServer() {
  if (await fetch(`${BASE}/api/health`).then(() => true, () => false)) throw new Error(`port ${PORT} is already in use`);
  server = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SITEFLOW_TEST: '1', SITEFLOW_DIST: DIST, SITEFLOW_SUPABASE_URL: SB_URL, SITEFLOW_SUPABASE_KEY: SB_ANON },
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}

async function setOffline(ctx: BrowserContext, page: Page, offline: boolean) {
  const device = await page.evaluate(() => localStorage.getItem('sf.installId'));
  await fetch(`${BASE}/api/__test/offline`, { method: 'POST', body: JSON.stringify({ device, offline }) });
  if (ENGINE === 'chromium') await ctx.setOffline(offline);
}

const tab = (p: Page, name: string) => p.locator('nav.tabs button', { hasText: name }).click();
const shot = (p: Page, name: string) => p.screenshot({ path: `${OUT}${name}.png`, fullPage: false });
async function sync(p: Page) {
  await tab(p, 'הגדרות');
  const n = await p.locator('.log div').count();
  await p.getByRole('button', { name: 'סנכרן עכשיו' }).click();
  await p.locator('.log div').nth(n).waitFor({ timeout: 120000 });
  return (await p.locator('.log div').first().textContent()) ?? '';
}
async function until(fn: () => Promise<boolean>, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function signedIn(email: string, password: string) {
  const c = createClient(SB_URL, SB_ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { c, token: data.session!.access_token };
}

async function newUser(prefix: string) {
  const email = `${prefix}-${randomBytes(4).toString('hex')}@siteflow.test`;
  const password = randomBytes(18).toString('base64url');
  const created = await sbAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  return { email, password, id: created.data.user.id };
}

/** Realistic site photos: 1600×1200 JPEG with texture (≈300–600 KB, like a phone photo after resizing). */
async function makePhotos(n: number) {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: 1600, height: 1200 } });
  const out: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    await pg.setContent(`<canvas id=c width=1600 height=1200></canvas><script>{
      const c=document.getElementById('c').getContext('2d');const g=c.createLinearGradient(0,0,1600,1200);
      g.addColorStop(0,'hsl(${(i * 37) % 360},30%,60%)');g.addColorStop(1,'hsl(${(i * 37 + 80) % 360},25%,35%)');c.fillStyle=g;c.fillRect(0,0,1600,1200);
      const d=c.getImageData(0,0,1600,1200);let s=${i + 1};for(let k=0;k<d.data.length;k+=4){s=(s*16807)%2147483647;const v=(s%40)-20;d.data[k]+=v;d.data[k+1]+=v;d.data[k+2]+=v;}
      c.putImageData(d,0,0);c.fillStyle='rgba(255,255,255,.85)';c.font='bold 110px Arial';c.fillText('IMG ${i + 1}',560,640);c.strokeStyle='#fff';c.lineWidth=12;c.strokeRect(${200 + i * 7},200,${600 + i * 5},500);
      }</script><style>body{margin:0}</style>`);
    out.push(await pg.screenshot({ type: 'jpeg', quality: 82 }));
  }
  await b.close();
  return out;
}

async function pngImage(text: string, w: number, h: number) {
  const b = await chromium.launch();
  const pg = await b.newPage({ viewport: { width: w, height: h } });
  await pg.setContent(`<body style="margin:0;width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;font:bold ${Math.round(h / 3)}px Arial;color:#0f2a44;background:transparent">${text}</body>`);
  const buf = await pg.screenshot({ type: 'png', omitBackground: true });
  await b.close();
  return buf;
}

async function pdfInfo(pdf: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  const ops = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject]);
  const parts: string[] = [];
  let images = 0;
  let landscape = true;
  let portrait = true;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const [, , w, h] = page.view;
    if (w <= h) landscape = false;
    if (h <= w) portrait = false;
    parts.push((await page.getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' '));
    images += (await page.getOperatorList()).fnArray.filter((op) => ops.has(op)).length;
  }
  return { pages: doc.numPages, text: parts.join('\n'), images, landscape, portrait };
}

/** The XLSX as openpyxl (an independent reader) sees it. */
function readXlsx(path: string) {
  const py = `
import json, sys, openpyxl, datetime
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb.active
rows = []
for r in ws.iter_rows():
    rows.append([[c.value.isoformat() if isinstance(c.value, datetime.datetime) else c.value, c.data_type, bool(c.quotePrefix), c.number_format] for c in r])
print(json.dumps({"title": ws.title, "rtl": bool(ws.sheet_view.rightToLeft), "freeze": ws.freeze_panes, "filter": ws.auto_filter.ref,
  "widths": [ws.column_dimensions[k].width for k in sorted(ws.column_dimensions.keys())], "rows": rows}, ensure_ascii=False))
`;
  // Run from the output folder (only files this test wrote), with the user's installed openpyxl.
  return JSON.parse(execSync(`python3 -c '${py.replace(/'/g, "'\\''")}' '${path}'`, { cwd: OUT }).toString()) as {
    title: string; rtl: boolean; freeze: string; filter: string; widths: number[]; rows: [unknown, string, boolean, string][][];
  };
}

// ---------- Realistic dataset ----------

const LONG = [
  'בחדר הרחצה של ההורים חסר סיליקון סביב האמבטיה לכל אורכה (כ-170 ס״מ), וקיימים סימני רטיבות על הקיר הסמוך בגובה 40 ס״מ מהרצפה. יש לבדוק את איטום החיבור לפני השלמת הסיליקון ולתעד בצילום לאחר התיקון.',
  'דלת הכניסה הראשית אינה נסגרת עד הסוף: פער של 6 מ״מ בצד הצירים, והמנעול הרב-בריחי לא ננעל בבריח העליון. נדרש כיוון צירים והחלפת לשונית במידת הצורך, כולל בדיקת חותם הגומי.',
  'בלוח החשמל הדירתי (דגם ABB-24) חסר שילוט מעגלים, וממסר הפחת לא נבדק. יש להשלים שילוט בהתאם לתכנית ולמסור דו״ח בדיקה של חשמלאי בודק.',
];
const SHORT = [
  'חסר שקע 16A במטבח, ליד המקרר',
  'חסר סף שיש ביציאה למרפסת (רוחב 120 ס״מ)',
  'חסרה רשת בחלון חדר ילדים (סוג Klil 7300)',
  'אריח סדוק להחלפה בשורה 4 מהקיר הצפוני (30×60)',
  'שכבת צבע אחרונה חסרה; גוון RAL 9010',
  'מעקה מרפסת ללא עיגון — סכנת נפילה, לטיפול מיידי',
  'חסר כיסוי ביקורת לניקוז במרפסת שירות',
  'נזילה בחיבור הסיפון — לבדוק בלחץ 6 בר',
  'יש לתאם עם מנהל העבודה (054-0000000) לפני הפירוק',
  'חסר איטום בחיבור אדנית למעקה; קוד פרט D-17',
];
const DETAILS = ['מטבח', 'חדר רחצה הורים', 'מרפסת שירות', 'סלון, קיר מערבי', 'חדר שינה 2', 'מסדרון', 'ממ״ד', ''];
const STATUSES = ['open', 'open', 'open', 'open', 'open', 'open', 'reported_done', 'reported_done', 'closed', 'closed', 'closed', 'reopened', 'cancelled'] as const;

interface Loc { id: string; parent_id: string | null; kind: string; name: string }
interface SrvFinding {
  id: string; version: number; display_no: number; location_id: string; contractor_id: string | null; category_id: string | null;
  classification: string; status: string; tour_id: string | null; description: string; photo_ids: string[]; deleted_at: string | null;
}

async function pushAll(c: SupabaseClient, changes: object[]) {
  for (let i = 0; i < changes.length; i += 100) {
    const { data, error } = await c.rpc('push_findings', { p_changes: changes.slice(i, i + 100) });
    if (error) throw new Error(`push_findings: ${error.message}`);
    const bad = (data as { status: string; error?: string }[]).filter((r) => r.status !== 'ok');
    if (bad.length) throw new Error(`push_findings: ${bad.length} rejected — ${bad[0].error ?? bad[0].status}`);
  }
}

async function main() {
  console.log(`\n=== SiteFlow M6–M9 tests (management table, reports, Excel, security) — engine: ${ENGINE} ===\n`);
  execSync(`npx vite build --outDir ${DIST} --emptyOutDir`, { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: `${BASE}/sb`, VITE_SUPABASE_PUBLISHABLE_KEY: SB_ANON, VITE_TEST_HOOKS: "1" } });
  await startServer();

  // Organization with the demo project, an engineer (device), a second engineer (other device), a viewer;
  // and a separate organization for isolation checks.
  const eng = await newUser('m9');
  const eng2 = await newUser('m9b');
  const viewer = await newUser('m9v');
  const stranger = await newUser('m9x');
  const orgName = `ארגון M9 ${randomBytes(3).toString('hex')}`;
  const orgId = (await sbAdmin.rpc('admin_add_member', { p_email: eng.email, p_org_name: orgName, p_role: 'engineer' })).data as string;
  await sbAdmin.rpc('admin_add_member', { p_email: eng2.email, p_org_name: orgName, p_role: 'engineer' });
  await sbAdmin.rpc('admin_add_member', { p_email: viewer.email, p_org_name: orgName, p_role: 'viewer' });
  const otherOrg = `ארגון זר ${randomBytes(3).toString('hex')}`;
  const otherOrgId = (await sbAdmin.rpc('admin_add_member', { p_email: stranger.email, p_org_name: otherOrg, p_role: 'owner' })).data as string;
  const projectId = (await sbAdmin.rpc('admin_seed_demo_project', { p_org_name: orgName })).data as string;
  const { c: engApi, token: engToken } = await signedIn(eng.email, eng.password);
  const { c: eng2Api } = await signedIn(eng2.email, eng2.password);
  const { c: viewerApi, token: viewerToken } = await signedIn(viewer.email, viewer.password);
  const { c: strangerApi, token: strangerToken } = await signedIn(stranger.email, stranger.password);

  const locs = ((await sbAdmin.from('locations').select('id, parent_id, kind, name').eq('project_id', projectId).is('deleted_at', null)).data ?? []) as Loc[];
  const byId = new Map(locs.map((l) => [l.id, l]));
  const within = (id: string, anc: string) => {
    for (let cur = byId.get(id); cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) if (cur.id === anc) return true;
    return false;
  };
  const leaves = locs.filter((l) => l.kind === 'unit' || l.kind === 'common');
  const bA = locs.find((l) => l.name === 'בניין A' && !l.parent_id)!;
  const bB = locs.find((l) => l.name === 'בניין B' && !l.parent_id)!;
  const bA2 = locs.find((l) => l.parent_id === bA.id && l.name === 'קומה 2')!;
  const bB1 = locs.find((l) => l.parent_id === bB.id && l.name === 'קומה 1')!;
  const contractors = ((await sbAdmin.from('project_contractors').select('contractor_id, contractors(name)').eq('project_id', projectId)).data ?? []).map(
    (r) => ({ id: r.contractor_id as string, name: (r.contractors as unknown as { name: string }).name }),
  );
  const cByName = (n: string) => contractors.find((c) => c.name === n)!.id;
  const cats = ((await sbAdmin.from('categories').select('id, name').eq('org_id', orgId).is('deleted_at', null)).data ?? []) as { id: string; name: string }[];
  const catByName = (n: string) => cats.find((c) => c.name === n)!.id;
  const defaults = new Map(((await sbAdmin.from('project_category_defaults').select('category_id, contractor_id').eq('project_id', projectId)).data ?? []).map((d) => [d.category_id, d.contractor_id]));

  const tInitial = randomUUID();
  const tFollow = randomUUID();
  const ins = await sbAdmin.from('tours').insert([
    { id: tInitial, org_id: orgId, project_id: projectId, kind: 'initial', tour_date: '2026-10-01', status: 'closed', participants: [{ name: 'דנה לוי', role: 'מפקחת' }] },
    { id: tFollow, org_id: orgId, project_id: projectId, kind: 'follow_up', tour_date: '2026-10-20', status: 'closed', participants: [{ name: 'יוסי כהן', role: 'מנהל עבודה — קבלן ראשי' }, { name: 'Mark Levi', role: 'נציג Alumil' }] },
  ]);
  if (ins.error) throw ins.error;

  // Photos: uploaded to the private bucket as the engineer, as the app does.
  const photoBufs = await makePhotos(24);
  const photoIds: string[] = [];
  for (const buf of photoBufs) {
    const id = randomUUID();
    const path = `${orgId}/${projectId}/${id}.jpg`;
    const up = await engApi.storage.from('photos').upload(path, buf, { contentType: 'image/jpeg' });
    if (up.error) throw up.error;
    const row = await engApi.from('photos').insert({ id, org_id: orgId, storage_path: path, size: buf.length, sha256: sha(buf), width: 1600, height: 1200, kind: 'initial' });
    if (row.error) throw row.error;
    photoIds.push(id);
  }
  const avgKb = Math.round(photoBufs.reduce((n, b) => n + b.length, 0) / photoBufs.length / 1024);

  // 600 findings across both buildings, all contractors, both tours and every status.
  const N = 600;
  const changes: object[] = [];
  let photoCursor = 0;
  for (let i = 0; i < N; i++) {
    const cat = cats[i % cats.length];
    const loc = leaves[(i * 7) % leaves.length];
    const nPhotos = i % 15 === 0 ? 3 : i % 6 === 0 ? 1 : 0;
    const desc =
      i === 5 ? '=HYPERLINK("http://evil.example/x","לחץ כאן")' :
      i === 6 ? '+972-54-0000000 להתקשר לפני הביקור' :
      i === 7 ? '@SUM(A1:A9) נוסחה בתיאור' :
      i < 3 ? `בדיקת-מקביליות ${i + 1}: ${SHORT[i]}` :
      i === 3 || i === 4 ? `למחיקה-בדיקה ${i}: ${SHORT[i]}` :
      i % 11 === 0 ? LONG[i % LONG.length] : SHORT[i % SHORT.length];
    changes.push({
      id: randomUUID(),
      baseVersion: 0,
      createdAt: new Date(Date.UTC(2026, 9, i < 350 ? 1 : 20, 7, 0, i % 60)).toISOString(),
      data: {
        projectId,
        tourId: i < 350 ? tInitial : tFollow,
        batchId: null,
        locationId: loc.id,
        locationDetail: DETAILS[i % DETAILS.length],
        categoryId: cat.id,
        contractorId: defaults.get(cat.id) ?? null,
        classification: i % 20 === 0 ? 'critical' : i % 5 === 0 ? 'defective' : 'missing',
        description: desc,
        status: i < 8 ? 'open' : STATUSES[i % STATUSES.length],
        photoIds: Array.from({ length: nPhotos }, () => photoIds[photoCursor++ % photoIds.length]),
        deletedAt: null,
      },
    });
  }
  await pushAll(engApi, changes);

  // A second project in the same organization, for isolation.
  const p2 = randomUUID();
  const p2b = randomUUID();
  const p2u = randomUUID();
  await sbAdmin.from('projects').insert({ id: p2, org_id: orgId, code: 'SEC', name: 'פרויקט שני לבדיקה' });
  await sbAdmin.from('locations').insert([
    { id: p2b, org_id: orgId, project_id: p2, parent_id: null, kind: 'building', name: 'בניין שני', code: 'S', sort_order: 0 },
    { id: p2u, org_id: orgId, project_id: p2, parent_id: p2b, kind: 'unit', name: 'דירה 99', code: 'S-99', sort_order: 1 },
  ]);
  await pushAll(engApi, Array.from({ length: 5 }, (_, i) => ({
    id: randomUUID(), baseVersion: 0, createdAt: new Date().toISOString(),
    data: { projectId: p2, tourId: null, batchId: null, locationId: p2u, locationDetail: '', categoryId: null, contractorId: null, classification: 'missing', description: `ממצא-פרויקט-שני ${i}`, status: 'open', photoIds: [], deletedAt: null },
  })));

  const serverFindings = async () =>
    ((await sbAdmin.from('findings').select('*').eq('project_id', projectId).order('display_no').range(0, 4999)).data ?? []) as SrvFinding[];
  let srv = await serverFindings();
  check('נתוני בדיקה: 600 ממצאים, 24 תמונות בגודל אמיתי, 2 סיורים, טקסט ארוך ומעורב', srv.length === N, `${srv.length} ממצאים · תמונה ממוצעת ${avgKb} KB`);

  // ---------- M6: management table ----------
  const ctx = await engine.launchPersistentContext(`${OUT}profile`, { viewport: { width: 1440, height: 900 }, serviceWorkers: 'allow', acceptDownloads: true });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  const pageErrors: string[] = [];
  p.on('pageerror', (e) => pageErrors.push(e.message));
  await p.goto(BASE);
  await p.locator('.login-card input[type=email]').fill(eng.email);
  await p.locator('.login-card input[type=password]').fill(eng.password);
  await p.locator('.login-card button[type=submit]').click();
  // Two projects and none chosen yet: the app opens on "הפרויקטים שלי".
  await p.locator('.projects-home').waitFor({ timeout: 60000 });
  await p.locator('.ph-card', { hasText: 'מגדלי הפארק' }).getByRole('button', { name: /^פתח/ }).click();
  await p.locator('.start-tour').waitFor({ timeout: 60000 });
  await p.getByRole('button', { name: 'התחל סיור' }).click();
  await p.getByText('שמור והמשך').waitFor();
  await sync(p);
  const deviceTour = (await sbAdmin.from('tours').select('id').eq('project_id', projectId).eq('status', 'active').single()).data!.id as string;

  const count = p.locator('.ft-count');
  const rows = p.locator('table.ft tbody tr');
  const filter = (label: string) => p.locator(`.ft-filters select[aria-label="${label}"]`);
  const search = p.locator('.ff-search input');
  // Search and filters are kept per project while the app is open (UX-08); start each step from a clean slate.
  const backToTable = async () => {
    await tab(p, 'ממצאים');
    await p.locator('table.ft').waitFor();
    await search.fill('');
    const clear = p.locator('.ff-chips .link', { hasText: 'נקה מסננים' });
    if (await clear.isVisible()) await clear.click();
  };
  const countIs = (n: number) => until(async () => (await count.textContent())?.startsWith(`${n} ממצאים`) ?? false);
  const apply = () => p.getByRole('button', { name: /^החל על \d+ ממצאים$/ }).click();
  const shownCount = async () => Number((await count.textContent())?.match(/^(\d+)/)?.[1] ?? -1);
  const active = (f: SrvFinding) => !f.deleted_at;

  let t0 = Date.now();
  await backToTable();
  await p.locator('table.ft').waitFor({ timeout: 20000 });
  const tableOk = await countIs(N);
  const openMs = Date.now() - t0;
  check('M6: במחשב נפתחת טבלת ניהול עם כל ממצאי הפרויקט', tableOk && (await p.locator('.view-tabs button.on').textContent()) === 'טבלת ניהול', (await count.textContent()) ?? '');
  check('M6: ביצועים — 600 ממצאים נטענים מהר, ומוצגות 200 שורות עם "הצג עוד"', openMs < 5000 && (await rows.count()) === 200 && (await p.locator('.ft-more').isVisible()), `${openMs} ms, ${await rows.count()} שורות`);
  await shot(p, '1-table');

  // Search
  const no = srv[123].display_no;
  await search.fill(`#${no}`);
  check('M6: חיפוש לפי מספר ממצא מדויק', (await countIs(1)) && (await rows.first().locator('.ft-no').textContent()) === `#${no}`);
  await search.fill('לוי חשמל');
  const elec = srv.filter((f) => active(f) && f.contractor_id === cByName('לוי חשמל ותקשורת')).length;
  check('M6: חיפוש לפי שם קבלן', await countIs(elec), `${await shownCount()} / ${elec}`);
  await search.fill('ABB-24');
  check('M6: חיפוש טקסט מעורב עברית/אנגלית', await countIs(srv.filter((f) => f.description.includes('ABB-24')).length));
  // Location codes are searchable: "B-02-" is every unit on floor 2 of building B.
  await search.fill('B-02-');
  const bB2 = locs.find((l) => l.parent_id === bB.id && l.name === 'קומה 2')!;
  const bB2Count = srv.filter((f) => within(f.location_id, bB2.id)).length;
  check('M6: חיפוש לפי קוד מיקום', await countIs(bB2Count), `${await shownCount()} / ${bB2Count}`);
  t0 = Date.now();
  await search.fill('');
  await countIs(N);
  const searchMs = Date.now() - t0;

  // Filters
  t0 = Date.now();
  await filter('בניין').selectOption({ label: 'בניין B' });
  check('M6: סינון לפי בניין', await countIs(srv.filter((f) => within(f.location_id, bB.id)).length));
  const filterMs = Date.now() - t0;
  await filter('קומה').selectOption({ label: 'קומה 1' });
  check('M6: סינון לפי קומה', await countIs(srv.filter((f) => within(f.location_id, bB1.id)).length));
  const unitInB1 = locs.find((l) => l.parent_id === bB1.id && l.kind === 'unit' && srv.some((f) => f.location_id === l.id))!;
  await filter('דירה / חלל').selectOption({ value: unitInB1.id });
  check('M6: סינון לפי דירה', await countIs(srv.filter((f) => f.location_id === unitInB1.id).length));
  await p.locator('.ff-chips .link', { hasText: 'נקה מסננים' }).click();
  await countIs(N);
  const plumb = cByName('אינסטלציה כהן בע״מ');
  await filter('קבלן').selectOption({ value: plumb });
  await filter('סטטוס').selectOption('open');
  await filter('סיור').selectOption({ value: tFollow });
  const combo = srv.filter((f) => f.contractor_id === plumb && f.status === 'open' && f.tour_id === tFollow).length;
  check('M6: סינון משולב — קבלן + סטטוס + סיור', await countIs(combo), `${await shownCount()} / ${combo}`);
  await p.locator('.ff-chips .link', { hasText: 'נקה מסננים' }).click();
  await filter('סיווג').selectOption('critical');
  await filter('קטגוריה').selectOption({ label: 'חשמל' });
  const critElec = srv.filter((f) => f.classification === 'critical' && f.category_id === catByName('חשמל')).length;
  check('M6: סינון לפי סיווג וקטגוריה', await countIs(critElec), `${critElec}`);
  await p.locator('.ff-chips .link', { hasText: 'נקה מסננים' }).click();
  check('M6: ביצועים — סינון וחיפוש ב-600 ממצאים', filterMs < 1500 && searchMs < 1500, `סינון ${filterMs} ms · חיפוש ${searchMs} ms`);

  // Sorting
  await p.locator('table.ft thead .ft-sort', { hasText: 'מס׳' }).click();
  const firstAsc = await rows.first().locator('.ft-no').textContent();
  await p.locator('table.ft thead .ft-sort', { hasText: 'מס׳' }).click();
  const firstDesc = await rows.first().locator('.ft-no').textContent();
  const maxNo = Math.max(...srv.map((f) => f.display_no));
  const minNo = Math.min(...srv.map((f) => f.display_no));
  check('M6: מיון לפי מספר — עולה ויורד', firstAsc === `#${minNo}` && firstDesc === `#${maxNo}`, `${firstAsc} / ${firstDesc}`);
  await p.locator('table.ft thead .ft-sort', { hasText: 'סיווג' }).click();
  check('M6: מיון לפי סיווג — קריטיים ראשונים', (await rows.first().getAttribute('class'))?.includes('cls-critical') ?? false);

  // Inline edit
  const inl = srv.find((f) => f.status === 'open' && !f.description.startsWith('בדיקת') && !f.description.startsWith('למחיקה'))!;
  await search.fill(`#${inl.display_no}`);
  await countIs(1);
  await p.getByLabel(`סטטוס לממצא ${inl.display_no}`).selectOption('reported_done');
  await sync(p);
  await backToTable();
  const inlEv = (await sbAdmin.from('finding_events').select('*').eq('finding_id', inl.id).eq('type', 'status_changed')).data ?? [];
  const inlRow = (await sbAdmin.from('findings').select('status').eq('id', inl.id).single()).data!;
  check('M6: עריכה בתוך הטבלה (סטטוס) נשמרת בשרת עם אירוע היסטוריה בסיור הפעיל',
    inlRow.status === 'reported_done' && inlEv.length === 1 && inlEv[0].tour_id === deviceTour && inlEv[0].to_value?.status === 'reported_done');

  // Bulk status
  await p.locator('table.ft').waitFor();
  await filter('קבלן').selectOption({ value: cByName('ריצוף מזרחי') });
  await filter('סטטוס').selectOption('open');
  const bulkTargets = srv.filter((f) => f.contractor_id === cByName('ריצוף מזרחי') && f.status === 'open' && f.id !== inl.id);
  await countIs(bulkTargets.length);
  await p.getByLabel('בחר את כל הממצאים המסוננים').check();
  check('M6: בחירת כל המסוננים (גם מעבר ל-200 המוצגות)', !!(await p.locator('.ft-bulk b').textContent())?.includes(`נבחרו ${bulkTargets.length}`));
  await p.getByLabel('שינוי סטטוס לנבחרים').selectOption('reported_done');
  await apply();
  const bulkMsg = await p.locator('.ftable .alert[role=status]').textContent();
  await shot(p, '2-bulk');
  await sync(p);
  await backToTable();
  srv = await serverFindings();
  const bulkIds = new Set(bulkTargets.map((f) => f.id));
  const bulkEv = ((await sbAdmin.from('finding_events').select('finding_id, to_value, tour_id').eq('type', 'status_changed').in('finding_id', [...bulkIds])).data ?? []);
  check('M6: עדכון סטטוס מרובה — כל הממצאים עודכנו בשרת',
    !!bulkMsg?.includes(`עודכנו ${bulkTargets.length}`) && srv.filter((f) => bulkIds.has(f.id)).every((f) => f.status === 'reported_done'), `${bulkTargets.length} ממצאים`);
  check('M6: לכל ממצא בעדכון המרובה אירוע היסטוריה משלו',
    new Set(bulkEv.filter((e) => e.to_value?.status === 'reported_done' && e.tour_id === deviceTour).map((e) => e.finding_id)).size === bulkTargets.length);

  // Bulk contractor and category
  await filter('בניין').selectOption({ label: 'בניין A' });
  await filter('קטגוריה').selectOption({ label: 'חשמל' });
  const catTargets = srv.filter((f) => within(f.location_id, bA.id) && f.category_id === catByName('חשמל'));
  await countIs(catTargets.length);
  await p.getByLabel('בחר את כל הממצאים המסוננים').check();
  await p.getByLabel('שיוך קבלן לנבחרים').selectOption({ label: 'קבלן ראשי' });
  await p.getByLabel('שינוי קטגוריה לנבחרים').selectOption({ label: 'כללי' });
  await apply();
  await sync(p);
  await backToTable();
  srv = await serverFindings();
  const catIds = new Set(catTargets.map((f) => f.id));
  check('M6: שיוך קבלן ושינוי קטגוריה מרובים',
    srv.filter((f) => catIds.has(f.id)).every((f) => f.contractor_id === cByName('קבלן ראשי') && f.category_id === catByName('כללי')), `${catTargets.length} ממצאים`);

  // Concurrent change during a bulk edit: never overwritten silently.
  const conc = srv.filter((f) => f.description.startsWith('בדיקת-מקביליות')).sort((a, b) => a.display_no - b.display_no);
  await setOffline(ctx, p, true);
  const [c1, c2, c3] = conc;
  await pushAll(eng2Api, [
    { id: c1.id, baseVersion: c1.version, createdAt: new Date().toISOString(), data: { projectId, tourId: c1.tour_id, batchId: null, locationId: c1.location_id, locationDetail: '', categoryId: c1.category_id, contractorId: c1.contractor_id, classification: c1.classification, description: c1.description, status: 'closed', photoIds: c1.photo_ids, deletedAt: null } },
    { id: c2.id, baseVersion: c2.version, createdAt: new Date().toISOString(), data: { projectId, tourId: c2.tour_id, batchId: null, locationId: c2.location_id, locationDetail: '', categoryId: c2.category_id, contractorId: c2.contractor_id, classification: c2.classification, description: `${c2.description} (עודכן במכשיר אחר)`, status: c2.status, photoIds: c2.photo_ids, deletedAt: null } },
  ]);
  // locationDetail differs from the device copy only if it was non-empty; keep the device copy's detail.
  await search.fill('בדיקת-מקביליות');
  await countIs(3);
  await p.getByLabel('בחר את כל הממצאים המסוננים').check();
  await p.getByLabel('שינוי סטטוס לנבחרים').selectOption('reopened');
  await apply();
  await setOffline(ctx, p, false);
  await sync(p);
  await sync(p);
  await backToTable();
  await search.fill('בדיקת-מקביליות');
  srv = await serverFindings();
  const s1 = srv.find((f) => f.id === c1.id)!;
  const s2 = srv.find((f) => f.id === c2.id)!;
  const s3 = srv.find((f) => f.id === c3.id)!;
  const conflictShown = await p.locator(`tr[data-id="${c1.id}"] .tag.danger`, { hasText: 'התנגשות' }).isVisible();
  check('M6: עריכה מרובה מול שינוי מקביל באותו שדה — לא נדרס, מוצגת התנגשות להחלטה', s1.status === 'closed' && conflictShown, `שרת: ${s1.status}`);
  check('M6: שינוי מקביל בשדה אחר מוזג אוטומטית; ממצא שלא השתנה עודכן',
    s2.status === 'reopened' && s2.description.endsWith('(עודכן במכשיר אחר)') && s3.status === 'reopened', `${s2.status} · ${s3.status}`);
  await p.locator(`tr[data-id="${c1.id}"] .ft-no button`).click();
  await p.getByText('בשרת (ממכשיר אחר):').click();
  await p.getByRole('button', { name: 'שמור החלטה' }).click();
  await sync(p);
  await backToTable();

  // Bulk delete and restore
  await search.fill('למחיקה-בדיקה');
  await countIs(2);
  await p.getByLabel('בחר את כל הממצאים המסוננים').check();
  await p.getByRole('button', { name: 'מחק נבחרים' }).click();
  await p.getByRole('button', { name: 'כן, מחק' }).click();
  const goneFromList = await countIs(0);
  await filter('מצב').selectOption('deleted');
  const inDeleted = await countIs(2);
  await sync(p);
  await backToTable();
  srv = await serverFindings();
  const delIds = srv.filter((f) => f.description.startsWith('למחיקה-בדיקה')).map((f) => f.id);
  check('M6: מחיקה מרובה (עם אישור) — נעלמים מהרשימה, מופיעים ב"נמחקו", ונמחקים רכות בשרת',
    goneFromList && inDeleted && srv.filter((f) => delIds.includes(f.id)).every((f) => !!f.deleted_at));
  await search.fill('למחיקה-בדיקה');
  await filter('מצב').selectOption('deleted');
  await countIs(2);
  await p.getByLabel('בחר את כל הממצאים המסוננים').check();
  await p.getByRole('button', { name: 'שחזר נבחרים' }).click();
  await sync(p);
  await backToTable();
  srv = await serverFindings();
  const delEv = (await sbAdmin.from('finding_events').select('type').in('finding_id', delIds)).data ?? [];
  check('M6: שחזור מרובה, עם אירועי "נמחק" ו"שוחזר" בהיסטוריה',
    srv.filter((f) => delIds.includes(f.id)).every((f) => !f.deleted_at) && delEv.filter((e) => e.type === 'deleted').length === 2 && delEv.filter((e) => e.type === 'restored').length === 2);

  // Details panel: photos and history
  const withPhotos = srv.find((f) => f.photo_ids.length === 3)!;
  await search.fill(`#${withPhotos.display_no}`);
  await countIs(1);
  await rows.first().locator('.ft-open').click();
  await p.locator('.sheet .history').waitFor();
  const thumbs = await until(async () => (await p.locator('.sheet .edit-photos .thumb').count()) === 3, 30000);
  await shot(p, '3-details');
  check('M6: פאנל פרטים עם תמונות (מהשרת) והיסטוריה', thumbs && (await p.locator('.sheet .history-row').count()) >= 1, `${await p.locator('.sheet .edit-photos .thumb').count()} תמונות`);
  await p.locator('.sheet .link', { hasText: 'סגור' }).first().click();

  // Project isolation
  await search.fill('');
  const switchProject = async (name: RegExp) => {
    await p.locator('.pb-switch').click();
    await p.getByRole('radio', { name }).click();
    await p.locator('[role=dialog]').waitFor({ state: 'detached' });
  };
  await switchProject(/פרויקט שני לבדיקה/);
  const p2Only = await countIs(5);
  await search.fill('חסר');
  const noLeak = await countIs(0);
  await search.fill('');
  await switchProject(/מגדלי הפארק/);
  await search.fill('ממצא-פרויקט-שני');
  const noLeakBack = await countIs(0);
  await search.fill('');
  check('M6: הפרדת פרויקטים — מעבר פרויקט מציג רק את ממצאיו', p2Only && noLeak && noLeakBack);

  // Mobile width: the table scrolls inside its frame, the page does not.
  await p.setViewportSize({ width: 390, height: 844 });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const cardsShown = (await p.locator('.card-row .fc-contractor').first().isVisible()) && (await p.locator('table.ft').count()) === 0;
  await shot(p, '4-table-mobile');
  check('M6: מסך צר — כרטיסים עם קבלן וסטטוס במקום טבלה, בלי גלילה אופקית של הדף', overflow <= 1 && cardsShown, `גלישה ${overflow}px`);
  await p.setViewportSize({ width: 1440, height: 900 });

  // ---------- M8: Excel ----------
  srv = await serverFindings();
  await filter('בניין').selectOption({ label: 'בניין A' });
  await filter('סיור').selectOption({ value: tFollow });
  const xlsxExpected = srv.filter((f) => !f.deleted_at && within(f.location_id, bA.id) && f.tour_id === tFollow);
  await countIs(xlsxExpected.length);
  const [dl1] = await Promise.all([p.waitForEvent('download'), p.locator('.ft-export').click()]);
  const x1Path = `${OUT}export-filtered.xlsx`;
  await dl1.saveAs(x1Path);
  const x1 = readXlsx(x1Path);
  const header = x1.rows[0].map((c) => c[0]);
  const body = x1.rows.slice(1);
  const col = (h: string) => header.indexOf(h);
  check('M8: ייצוא הנתונים המסוננים — מספר שורות ושם קובץ', body.length === xlsxExpected.length && /^SiteFlow-DEMO-findings-\d{8}-\d{4}\.xlsx$/.test(dl1.suggestedFilename()), `${body.length} שורות · ${dl1.suggestedFilename()}`);
  check('M8: גיליון מימין לשמאל, שורת כותרת קבועה, סינון אוטומטי ורוחב עמודות', x1.rtl && x1.freeze === 'A2' && !!x1.filter && x1.widths.every((w) => w >= 8), `${x1.title}`);
  check('M8: כל העמודות הנדרשות',
    ['מס׳ ממצא', 'פרויקט', 'בניין / אזור', 'קומה', 'דירה / חלל', 'מיקום מדויק', 'תיאור', 'קטגוריה', 'קבלן', 'סיווג', 'סטטוס', 'סיור', 'תאריך סיור', 'נוצר', 'עודכן'].every((h) => header.includes(h)));
  const numOk = body.every((r) => r[col('מס׳ ממצא')][1] === 'n' && typeof r[col('מס׳ ממצא')][0] === 'number');
  const dateOk = body.every((r) => r[col('תאריך סיור')][1] === 'd' && String(r[col('תאריך סיור')][0]).startsWith('2026-10-20') && r[col('תאריך סיור')][3] === 'dd/mm/yyyy');
  const createdOk = body.every((r) => r[col('נוצר')][1] === 'd' && r[col('נוצר')][3] === 'dd/mm/yyyy hh:mm');
  check('M8: סוגי נתונים — מספר כמספר, תאריכים כתאריך עם תבנית', numOk && dateOk && createdOk);
  const byNo = new Map(srv.map((f) => [f.display_no, f]));
  const sampleRow = body.find((r) => (byNo.get(r[col('מס׳ ממצא')][0] as number)?.description.length ?? 0) > 150);
  check('M8: תוכן עברי ארוך נשמר במלואו, כולל מיקום וקבלן',
    !!sampleRow && sampleRow[col('תיאור')][0] === byNo.get(sampleRow[col('מס׳ ממצא')][0] as number)!.description && sampleRow[col('בניין / אזור')][0] === 'בניין A' && !!sampleRow[col('קבלן')][0]);
  await p.locator('.ff-chips .link', { hasText: 'נקה מסננים' }).click();
  await search.fill('נוסחה');
  await search.fill('');
  // Formula-like text: exported as text, never as a formula.
  const formulaNos = srv.filter((f) => /^[=+@]/.test(f.description)).map((f) => f.display_no);
  await search.fill(`#${formulaNos[0]}`);
  await countIs(1);
  await rows.first().locator('input[type=checkbox]').check();
  for (const n of formulaNos.slice(1)) {
    await search.fill(`#${n}`);
    await countIs(1);
    await rows.first().locator('input[type=checkbox]').check();
  }
  await search.fill('');
  await countIs(N);
  check('M6: בחירה נשמרת בין חיפושים', !!(await p.locator('.ft-bulk b').textContent())?.includes(`נבחרו ${formulaNos.length}`));
  const [dl2] = await Promise.all([p.waitForEvent('download'), p.locator('.ft-export').click()]);
  const x2Path = `${OUT}export-selected.xlsx`;
  await dl2.saveAs(x2Path);
  const x2 = readXlsx(x2Path);
  const descCells = x2.rows.slice(1).map((r) => r[x2.rows[0].findIndex((c) => c[0] === 'תיאור')]);
  check('M8: ייצוא נבחרים בלבד', x2.rows.length - 1 === formulaNos.length, `${x2.rows.length - 1} שורות`);
  check('M8: הגנה מהזרקת נוסחאות — טקסט שמתחיל ב-= + @ נשמר כטקסט עם קידומת מרכאה',
    descCells.length === 3 && descCells.every((c) => c[1] === 's' && c[2] === true) && descCells.some((c) => String(c[0]).startsWith('=HYPERLINK')),
    descCells.map((c) => `${String(c[0]).slice(0, 12)}:${c[1]}`).join(' | '));
  const rawSheet = execSync(`unzip -p '${x2Path}' xl/worksheets/sheet1.xml`).toString();
  check('M8: אין תאי נוסחה בקובץ', !rawSheet.includes('<f>') && !rawSheet.includes('<f '));
  await p.getByRole('button', { name: 'בטל בחירה' }).click();

  // ---------- M7: reports ----------
  await tab(p, 'דוחות');
  await p.locator('.rp-branding .muted').filter({ hasNotText: 'טוען' }).waitFor();
  check('M7: בלי הגדרות — אין עורך, לוגו או חתימה מומצאים', !!(await p.locator('.rp-branding').textContent())?.includes('לא הוגדרו'));
  const logo = await pngImage('LOGO א.ב.', 600, 200);
  const signature = await pngImage('ד. כהן', 600, 180);
  await p.getByRole('button', { name: 'הגדרות דוח' }).click();
  await p.getByLabel('שם החברה').fill('כהן ניהול פרויקטים בע״מ');
  await p.getByLabel('פרטי החברה (כתובת, טלפון, דוא״ל)').fill('רח׳ הברזל 30, תל אביב · 03-5555555 · office@example.com');
  await p.getByLabel('קובץ לוגו').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo });
  await p.locator('.rp-image img[alt="לוגו"]').waitFor();
  await p.getByLabel('שם עורך הדוח').fill('דנה כהן');
  await p.getByLabel('תפקיד / תואר מקצועי').fill('מהנדסת ביצוע');
  await p.getByLabel('רישום מקצועי (לא חובה)').fill('רישום 123456 (לבדיקה)');
  await p.getByLabel('קובץ חתימה').setInputFiles({ name: 'sig.png', mimeType: 'image/png', buffer: signature });
  await p.locator('.rp-image img[alt="חתימה"]').waitFor();
  await shot(p, '5-settings');
  await p.getByRole('button', { name: 'שמור הגדרות' }).click();
  await p.locator('.sheet').waitFor({ state: 'detached' });
  const settingsRow = (await sbAdmin.from('report_settings').select('*').eq('org_id', orgId).single()).data;
  check('M7: הגדרות דוח (חברה, עורך, רישום, לוגו, חתימה) נשמרו לארגון', settingsRow?.author_name === 'דנה כהן' && settingsRow.logo?.startsWith('data:image/png;base64,') && settingsRow.signature?.startsWith('data:image/png;base64,'));

  const rpSelect = (label: string) => p.locator('.rp-form label.field', { has: p.locator('span', { hasText: new RegExp(`^${label}`) }) }).locator('select');
  const entries = p.locator('.reports .report-entry');
  const issueUi = async (button: string) => {
    const before = await entries.count();
    await p.getByRole('radio', { name: new RegExp(button) }).click();
    await p.getByRole('button', { name: 'הפק דוח' }).click();
    const ok = await until(async () => (await entries.count()) > before, 240000);
    if (!ok) throw new Error(`report not issued: ${await p.locator('.reports .alert.error').textContent().catch(() => '')}`);
    return (await sbAdmin.from('reports').select('*').eq('project_id', projectId).order('issued_at', { ascending: false }).limit(1).single()).data!;
  };
  const pdfOf = async (r: { pdf_path: string }) => Buffer.from(await (await sbAdmin.storage.from('reports').download(r.pdf_path)).data!.arrayBuffer());
  srv = await serverFindings();
  const notCancelled = (f: SrvFinding) => !f.deleted_at && f.status !== 'cancelled';

  // A. Compact table: building A, grouped by contractor, custom title and notes.
  await rpSelect('היקף').selectOption({ value: bA.id });
  await p.locator('.rp-advanced summary').click();
  await rpSelect('קיבוץ').selectOption('contractor');
  await p.getByLabel('כותרת הדוח').fill('דוח מסירה — בניין A');
  await p.getByLabel('הערות לדוח').fill('הממצאים יטופלו עד 15.11.2026. Contact: site@example.com');
  const expectA = srv.filter((f) => notCancelled(f) && within(f.location_id, bA.id));
  const preview = await p.locator('.rp-count').textContent();
  t0 = Date.now();
  const rA = await issueUi('דוח טבלאי מרוכז');
  const msA = Date.now() - t0;
  const pdfA = await pdfOf(rA);
  writeFileSync(`${OUT}report-table-buildingA.pdf`, pdfA);
  const iA = await pdfInfo(pdfA);
  check('M7: דוח טבלאי — היקף בניין, סטטוסים ברירת מחדל (ללא מבוטלים), מספר ממצאים נכון', rA.finding_count === expectA.length && !!preview?.includes(String(expectA.length)), `${rA.finding_count} / ${expectA.length} · ${msA} ms`);
  check('M7: דוח טבלאי — A4 לרוחב, רב-עמודי, מספור עמודים', iA.landscape && iA.pages > 3 && iA.text.includes('עמוד') && iA.text.includes('מתוך'), `${iA.pages} עמודים`);
  check('M7: דוח טבלאי — כותרת, חברה, עורך, רישום והערות מההגדרות',
    ['מסירה', 'כהן', 'ניהול', 'דנה', 'מהנדסת', '123456', '15.11.2026', 'site@example.com'].every((w) => iA.text.includes(w)));
  check('M7: מזוהה כפרוטוקול השלמת עבודות ולא כאישור הנדסי/בטיחות', ['פרוטוקול', 'הנדסי', 'בטיחות', 'אינו'].every((w) => iA.text.includes(w)));
  check('M7: קיבוץ לפי קבלן נשמר בתמונת המצב', rA.snapshot.grouping === 'contractor' && rA.scope.options?.grouping === 'contractor' && rA.scope.type === 'location');
  check('M7: לוגו וחתימה מופיעים כתמונות בדוח הטבלאי (בלי תמונות ממצאים)', iA.images === iA.pages + 1, `${iA.images} תמונות ב-${iA.pages} עמודים`);

  // B. Detailed protocol: one floor, one contractor, chosen statuses, follow-up tour only, by location.
  await rpSelect('היקף').selectOption({ value: bA2.id });
  const contr = cByName('קבלן ראשי');
  await rpSelect('קבלן').selectOption({ value: contr });
  for (const s of ['דווח כבוצע', 'נסגר (אומת)']) await p.getByRole('checkbox', { name: s, exact: true }).uncheck();
  await p.getByRole('radio', { name: 'סיורים נבחרים' }).check();
  await p.locator('.rp-tours label', { hasText: 'לפני' }).waitFor();
  for (const l of await p.locator('.rp-tours label').all()) {
    const isFollow = (await l.textContent())?.includes('20.10.2026');
    const box = l.locator('input');
    if (isFollow) await box.check();
    else await box.uncheck();
  }
  await rpSelect('קיבוץ').selectOption('location');
  await rpSelect('סיור בעמוד השער').selectOption({ value: tFollow });
  await p.getByLabel('כותרת הדוח').fill('');
  await p.getByLabel('הערות לדוח').fill('');
  srv = await serverFindings();
  const expectB = srv.filter((f) => !f.deleted_at && within(f.location_id, bA2.id) && f.contractor_id === contr && ['open', 'reopened'].includes(f.status) && f.tour_id === tFollow);
  await shot(p, '6-report-options');
  const rB = await issueUi('פרוטוקול מפורט');
  const pdfB = await pdfOf(rB);
  writeFileSync(`${OUT}report-detailed-floor-contractor.pdf`, pdfB);
  const iB = await pdfInfo(pdfB);
  check('M7: פרוטוקול מפורט — קומה + קבלן + סטטוסים + סיור, מספר ממצאים נכון', rB.finding_count === expectB.length, `${rB.finding_count} / ${expectB.length}`);
  check('M7: פרוטוקול מפורט — A4 לאורך, משתתפי הסיור ותאריכו בשער (כולל שם באנגלית)',
    iB.portrait && ['יוסי', 'Mark', 'Levi', '20.10.2026', 'חוזר'].every((w) => iB.text.includes(w)));

  // C. Whole project, all statuses, critical only.
  await rpSelect('היקף').selectOption('project');
  await rpSelect('קבלן').selectOption('');
  for (const s of ['דווח כבוצע', 'נסגר (אומת)', 'בוטל']) await p.getByRole('checkbox', { name: s, exact: true }).check();
  await p.getByRole('radio', { name: 'כל הסיורים' }).check();
  await p.getByRole('checkbox', { name: 'ליקויים קריטיים בלבד' }).check();
  const rC = await issueUi('דוח טבלאי מרוכז');
  check('M7: ליקויים קריטיים בלבד, כל הפרויקט', rC.finding_count === srv.filter((f) => !f.deleted_at && f.classification === 'critical').length, `${rC.finding_count}`);
  await p.getByRole('checkbox', { name: 'ליקויים קריטיים בלבד' }).uncheck();

  // D. Large detailed protocol: every finding and photo of the project.
  t0 = Date.now();
  const rD = await issueUi('פרוטוקול מפורט');
  const msD = Date.now() - t0;
  const pdfD = await pdfOf(rD);
  writeFileSync(`${OUT}report-detailed-full.pdf`, pdfD);
  const iD = await pdfInfo(pdfD);
  const photoRefs = (rD.snapshot.findings as { photoIds: string[] }[]).reduce((n, f) => n + f.photoIds.length, 0);
  check('M7: פרוטוקול מפורט מלא — מאות ממצאים ועשרות תמונות בגודל אמיתי',
    rD.finding_count === srv.filter((f) => !f.deleted_at).length && iD.pages > 50 && photoRefs > 50,
    `${rD.finding_count} ממצאים · ${photoRefs} תמונות · ${iD.pages} עמודים · ${(pdfD.length / 1048576).toFixed(1)} MB · ${(msD / 1000).toFixed(0)} שנ׳`);
  check('M7: כל תמונות הממצאים צוירו (ועוד לוגו בכל עמוד וחתימה)', iD.images === photoRefs + iD.pages + 1, `${iD.images} = ${photoRefs} + ${iD.pages} + 1`);

  // Revision, archive, download, distribution log.
  const pdfABefore = sha(pdfA);
  const entryA = entries.filter({ has: p.locator(`a.item[data-id="${rA.id}"]`) });
  const beforeRev = await entries.count();
  await entryA.locator('.rp-more summary').click();
  await entryA.getByRole('button', { name: 'גרסה מעודכנת' }).click();
  await until(async () => (await entries.count()) > beforeRev, 240000);
  const rA1 = (await sbAdmin.from('reports').select('*').eq('supersedes_report_id', rA.id).single()).data!;
  const rAAfter = (await sbAdmin.from('reports').select('*').eq('id', rA.id).single()).data!;
  check('M7: גרסה מעודכנת — אותו מספר, גרסה 1, אותן הגדרות; המקור לא השתנה',
    rA1.number === rA.number && rA1.revision === 1 && rA1.scope.options.title === 'דוח מסירה — בניין A' && JSON.stringify(rAAfter) === JSON.stringify(rA) && sha(await pdfOf(rA)) === pdfABefore,
    `${rA1.number} Rev.${rA1.revision}`);
  check('M7: ארכיון — כל הדוחות ברשימה, עם גרסה', (await entries.count()) === 5 && !!(await entries.first().textContent())?.includes('Rev.1'));
  const [dl3] = await Promise.all([p.waitForEvent('download'), entryA.getByRole('button', { name: 'הורדה' }).click()]);
  await dl3.saveAs(`${OUT}downloaded.pdf`);
  const dlBuf = readFileSync(`${OUT}downloaded.pdf`);
  check('M7: הורדת PDF מהארכיון — הקובץ זהה לטביעה הרשומה', sha(dlBuf) === rA.pdf_sha256 && dl3.suggestedFilename() === `${rA.number}.pdf`, dl3.suggestedFilename());
  if (!(await entryA.locator('.rp-more').evaluate((d) => (d as HTMLDetailsElement).open))) await entryA.locator('.rp-more summary').click();
  await entryA.getByRole('button', { name: /יומן הפצה/ }).click();
  await p.getByLabel('שם הנמען').fill('יוסי כהן');
  await p.getByLabel('קבלן הנמען').selectOption({ label: 'קבלן ראשי' });
  await p.getByLabel('אופן ההפצה').selectOption('whatsapp');
  await p.getByRole('button', { name: 'רשום הפצה' }).click();
  await until(async () => !!(await entryA.textContent())?.includes('הופץ ל-1'));
  const dist = (await sbAdmin.from('report_distributions').select('*').eq('report_id', rA.id)).data ?? [];
  check('M7: יומן הפצה ידני — רישום נמען, קבלן וערוץ', dist.length === 1 && dist[0].channel === 'whatsapp' && dist[0].recipient_contractor_id === contr);
  await shot(p, '7-archive');

  // ---------- M9: app upgrade with unsynced data ----------
  // Supabase unreachable (the test server drops this device's data traffic; the app files still load).
  const device = await p.evaluate(() => localStorage.getItem('sf.installId'));
  const dataOff = (offline: boolean) => fetch(`${BASE}/api/__test/offline`, { method: 'POST', body: JSON.stringify({ device, offline }) });
  const localDb = (id: string) =>
    p.evaluate(
      (fid) =>
        new Promise<{ n: number; dirty: number; cls: string | null }>((resolve, reject) => {
          const req = indexedDB.open('siteflow');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const all = req.result.transaction('findings').objectStore('findings').getAll();
            all.onsuccess = () => {
              const rows = all.result as { id: string; dirty: number; classification: string }[];
              resolve({ n: rows.length, dirty: rows.filter((r) => r.dirty === 1).length, cls: rows.find((r) => r.id === fid)?.classification ?? null });
              req.result.close();
            };
          };
        }),
      id,
    );
  await p.reload();
  await p.locator('nav.tabs').waitFor({ timeout: 30000 });
  const controlled = await until(() => p.evaluate(() => !!navigator.serviceWorker.controller), 15000);
  await dataOff(true);
  srv = await serverFindings();
  const up = srv.find((f) => f.classification === 'missing' && !f.deleted_at && f.status === 'open')!;
  await backToTable();
  await p.locator('table.ft').waitFor();
  await search.fill(`#${up.display_no}`);
  await countIs(1);
  await p.getByLabel(`סיווג לממצא ${up.display_no}`).selectOption('defective');
  const beforeUp = await localDb(up.id);
  await tab(p, 'הגדרות');
  const buildBefore = await p.locator('.app-version').textContent().catch(() => '');
  execSync(`npx vite build --outDir ${DIST} --emptyOutDir`, { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: `${BASE}/sb`, VITE_SUPABASE_PUBLISHABLE_KEY: SB_ANON, VITE_TEST_HOOKS: "1" } });
  await p.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
  const offered = await p.getByRole('button', { name: 'עדכן עכשיו' }).waitFor({ timeout: 30000 }).then(() => true, () => false);
  if (offered) {
    await Promise.all([p.waitForEvent('load', { timeout: 30000 }).catch(() => null), p.getByRole('button', { name: 'עדכן עכשיו' }).click()]);
  }
  await p.locator('nav.tabs').waitFor({ timeout: 30000 });
  await tab(p, 'הגדרות');
  const buildAfter = await p.locator('.app-version').textContent().catch(() => '');
  const afterUp = await localDb(up.id);
  check('M9: עדכון גרסת אפליקציה (Service Worker) עם עריכה שלא סונכרנה — שום נתון לא אבד',
    controlled && offered && buildAfter !== buildBefore && afterUp.n === beforeUp.n && afterUp.dirty === beforeUp.dirty && beforeUp.dirty >= 1 && afterUp.cls === 'defective',
    `${beforeUp.n}→${afterUp.n} ממצאים · ממתינים ${beforeUp.dirty}→${afterUp.dirty}`);
  await dataOff(false);
  await sync(p);
  const upRow = (await sbAdmin.from('findings').select('classification').eq('id', up.id).single()).data!;
  check('M9: אחרי העדכון והחזרת החיבור — העריכה הגיעה לשרת', upRow.classification === 'defective');

  // ---------- M9: security ----------
  const upd = await engApi.from('reports').update({ title: 'שונה' }).eq('id', rA.id).select();
  const del = await engApi.from('reports').delete().eq('id', rA.id).select();
  const overwrite = await engApi.storage.from('reports').upload(rA.pdf_path, Buffer.from('%PDF-fake'), { contentType: 'application/pdf', upsert: true });
  await engApi.storage.from('reports').remove([rA.pdf_path]);
  check('M9: דוח שהונפק — אין עדכון, מחיקה או החלפת קובץ (גם לעורך)',
    (!!upd.error || !upd.data?.length) && (!!del.error || !del.data?.length) && !!overwrite.error && sha(await pdfOf(rA)) === rA.pdf_sha256);
  const strangerReads = await Promise.all([
    strangerApi.from('reports').select('id').eq('project_id', projectId),
    strangerApi.from('report_settings').select('id').eq('org_id', orgId),
    strangerApi.from('findings').select('id').eq('project_id', projectId),
    strangerApi.from('report_distributions').select('id').eq('report_id', rA.id),
  ]);
  const strangerPdf = await strangerApi.storage.from('reports').download(rA.pdf_path);
  const strangerPhoto = await strangerApi.storage.from('photos').download(`${orgId}/${projectId}/${photoIds[0]}.jpg`);
  check('M9: משתמש מארגון אחר — לא רואה דוחות, הגדרות, ממצאים, הפצות, קובצי PDF או תמונות',
    strangerReads.every((r) => !r.error && r.data?.length === 0) && !!strangerPdf.error && !!strangerPhoto.error);
  const strangerIssue = await fetch(`${BASE}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${strangerToken}` }, body: JSON.stringify({ projectId, format: 'table', scope: { type: 'project' } }) });
  const strangerDist = await strangerApi.from('report_distributions').insert({ org_id: otherOrgId, report_id: rA.id, recipient_name: 'x', channel: 'other' });
  check('M9: משתמש מארגון אחר — לא מפיק דוח לפרויקט ולא רושם הפצה לדוח שאינו שלו', strangerIssue.status === 404 && !!strangerDist.error, `${strangerIssue.status}`);
  const viewerIssue = await fetch(`${BASE}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${viewerToken}` }, body: JSON.stringify({ projectId, format: 'table', scope: { type: 'project' } }) });
  const viewerSettings = await viewerApi.from('report_settings').update({ author_name: 'מתחזה' }).eq('org_id', orgId).select();
  const viewerDist = await viewerApi.from('report_distributions').insert({ org_id: orgId, report_id: rA.id, recipient_name: 'x', channel: 'other' });
  const viewerRead = await viewerApi.from('reports').select('id').eq('project_id', projectId);
  check('M9: צופה — רואה את הדוחות אך לא מפיק, לא משנה הגדרות ולא רושם הפצה',
    viewerIssue.status === 403 && (!!viewerSettings.error || !viewerSettings.data?.length) && !!viewerDist.error && (viewerRead.data?.length ?? 0) === 5, `הפקה: ${viewerIssue.status}`);
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
  const badLogo = await engApi.from('report_settings').update({ logo: svg }).eq('org_id', orgId).select();
  const hugeLogo = await engApi.from('report_settings').update({ logo: `data:image/png;base64,${'A'.repeat(900000)}` }).eq('org_id', orgId).select();
  check('M9: לוגו/חתימה — רק PNG/JPEG בגודל מוגבל (SVG עם סקריפט נדחה)', !!badLogo.error && !!hugeLogo.error);
  const badScope = await fetch(`${BASE}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${engToken}` }, body: JSON.stringify({ projectId, format: 'table', scope: { type: 'location', locationId: "x' or 1=1" } }) });
  const badFormat = await fetch(`${BASE}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${engToken}` }, body: JSON.stringify({ projectId, format: 'html', scope: { type: 'project' } }) });
  const noAuth = await fetch(`${BASE}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, format: 'table', scope: { type: 'project' } }) });
  check('M9: שירות הדוחות — דורש כניסה ודוחה היקף או פורמט לא תקינים', noAuth.status === 401 && badScope.status === 400 && badFormat.status === 400, `${noAuth.status} · ${badScope.status} · ${badFormat.status}`);
  const bundle = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? bundle(join(dir, f)) : [join(dir, f)]));
  const prodDist = `${ROOT}dist`;
  const leaked = [...bundle(DIST), ...bundle(prodDist)].filter((f) => {
    const t = readFileSync(f).toString('latin1');
    // The library itself mentions the "sb_secret_" prefix; a key is that prefix followed by key characters.
    const jwtRoles = [...t.matchAll(/eyJ[\w-]+\.(eyJ[\w-]+)\.[\w-]+/g)].map((m) => Buffer.from(m[1], 'base64url').toString());
    return t.includes(SB_SECRET) || /sb_secret_[A-Za-z0-9_-]{16,}/.test(t) || jwtRoles.some((r) => r.includes('service_role'));
  });
  check('M9: אין מפתח שירות או מפתח סודי בקבצי האפליקציה', leaked.length === 0, leaked.join(', '));
  check('M9: אין שגיאות JavaScript בדף במהלך הבדיקות', pageErrors.filter((e) => !(ENGINE === 'webkit' && /access control checks/.test(e))).length === 0, pageErrors.slice(0, 3).join(' | '));

  await ctx.close();
  for (const u of [eng, eng2, viewer, stranger]) await sbAdmin.auth.admin.deleteUser(u.id);
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
