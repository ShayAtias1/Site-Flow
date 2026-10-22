// UX acceptance tests for the UX/UI review (UX-01…UX-15): accessible dialogs (name, role, modal,
// focus in/trap/return, Escape, nested overlays, inert background), the persistent project context,
// shared search/filters with mobile filter sheet and chips, cards vs. table, docked details,
// inline-save feedback and retry, two-step bulk edits, multi-location capture, tour next steps,
// report preparation and archive, system and category screens, layout at 320/390/768/1440 and
// at 200% zoom, headings and text contrast. Throwaway users and organizations on the local Supabase.
// Usage: tsx scripts/ux-tests.ts [chromium|webkit]
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { chromium, webkit, type Page } from 'playwright';

const ENGINE = (process.argv[2] ?? 'chromium') as 'chromium' | 'webkit';
const engine = ENGINE === 'webkit' ? webkit : chromium;
const PORT = 8794;
const BASE = `http://localhost:${PORT}`;
const ROOT = new URL('../', import.meta.url).pathname;
const OUT = `${ROOT}poc-output/ux-${ENGINE}/`;
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

const DIST = `${ROOT}dist-test-ux`;
let server: ChildProcess | undefined;
let page: Page | undefined;
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

async function until(fn: () => Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const tab = (p: Page, name: string) => p.locator('nav.tabs button', { hasText: name }).click();
const view = (p: Page, name: string) => p.locator('.view-tabs button', { hasText: new RegExp(`^${name}$`) }).click();
const shot = (p: Page, name: string) => p.screenshot({ path: `${OUT}${name}.png` });
async function sync(p: Page) {
  await tab(p, 'הגדרות');
  const n = await p.locator('.log div').count();
  await p.getByRole('button', { name: 'סנכרן עכשיו' }).click();
  await p.locator('.log div').nth(n).waitFor({ timeout: 60000 });
}

/** What has keyboard focus: inside the open dialog, and is the app behind it inert? */
const focusState = (p: Page) =>
  p.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role=dialog]')] as HTMLElement[];
    const top = dialogs.filter((d) => !d.closest('[inert]')).at(-1) ?? null;
    const a = document.activeElement as HTMLElement | null;
    return {
      open: dialogs.length,
      inTop: !!top && !!a && top.contains(a),
      modal: top?.getAttribute('aria-modal') === 'true',
      named: !!top && !!(top.getAttribute('aria-label') || document.getElementById(top.getAttribute('aria-labelledby') ?? '')?.textContent?.trim()),
      rootInert: !!document.getElementById('root')?.inert,
      active: a ? `${a.tagName}:${(a.getAttribute('aria-label') ?? a.textContent ?? '').trim().slice(0, 30)}` : '',
    };
  });

/** The topmost popup: centered in the viewport, all corners rounded, visible margins, no drag handle. */
const popupGeometry = (p: Page) =>
  p.evaluate(() => {
    const d = [...document.querySelectorAll('[role=dialog]')].filter((x) => !x.closest('[inert]')).at(-1) as HTMLElement;
    const r = d.getBoundingClientRect();
    const cs = getComputedStyle(d);
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const radius = Math.min(...['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'].map((k) => parseFloat(cs[k as 'borderTopLeftRadius'])));
    const handle = getComputedStyle(d, '::before').display !== 'none' && getComputedStyle(d, '::before').content !== 'none';
    return {
      centeredX: Math.abs(r.left - (vw - r.right)) <= 2,
      centeredY: Math.abs(r.top - (vh - r.bottom)) <= 2,
      margin: Math.round(Math.min(r.left, vw - r.right, r.top, vh - r.bottom)),
      radius,
      border: parseFloat(cs.borderTopWidth) > 0,
      handle,
    };
  });
const popupOk = (g: Awaited<ReturnType<typeof popupGeometry>>) => g.centeredX && g.centeredY && g.margin >= 12 && g.radius >= 20 && g.border && !g.handle;
const popupFails: string[] = [];

/** Opens a dialog with `open`, then checks name/role/modal, focus inside, Tab trap, Escape, focus return. */
async function dialogKeyboard(p: Page, label: string, open: () => Promise<void>, tabs = 25) {
  await open();
  await p.locator('[role=dialog]').last().waitFor();
  const opener = await p.evaluate(() => (window as unknown as { __opener?: string }).__opener ?? '');
  const g = await popupGeometry(p);
  if (!popupOk(g)) popupFails.push(`${label}@${p.viewportSize()?.width}: ${JSON.stringify(g)}`);
  const s1 = await focusState(p);
  let escaped = false;
  const trace: string[] = [];
  for (let i = 0; i < tabs; i++) {
    await p.keyboard.press('Tab');
    const st = await focusState(p);
    if (!st.inTop) {
      escaped = true;
      trace.push(`${st.active} [open ${st.open} inert ${st.rootInert}]`);
    }
  }
  if (trace.length) console.log(`      focus left the dialog at: ${trace.slice(0, 3).join(' | ')}`);
  for (let i = 0; i < 5; i++) {
    await p.keyboard.press('Shift+Tab');
    if (!(await focusState(p)).inTop) escaped = true;
  }
  await p.keyboard.press('Escape');
  const closed = await until(async () => (await p.locator('[role=dialog]').count()) === 0, 3000);
  const back = await p.evaluate(() => document.activeElement?.getAttribute('data-opener') === '1');
  check(`UX-02: ${label} — role/שם/aria-modal, פוקוס בפנים, Tab לא בורח, Escape סוגר, הפוקוס חוזר לפותח`,
    s1.modal && s1.named && s1.inTop && s1.rootInert && !escaped && closed && back,
    `modal ${s1.modal} · name ${s1.named} · in ${s1.inTop} · inert ${s1.rootInert} · escaped ${escaped} · closed ${closed} · return ${back} ${opener}`);
}
/** Marks the element about to open a dialog, to check that focus returns to it. */
const markOpener = (p: Page, selector: string) =>
  p.locator(selector).first().evaluate((el) => {
    document.querySelectorAll('[data-opener]').forEach((x) => x.removeAttribute('data-opener'));
    el.setAttribute('data-opener', '1');
  });
async function openWithKeyboard(p: Page, selector: string) {
  // Some openers wait for permissions to load (e.g. "+ פרויקט חדש").
  await until(() => p.locator(selector).first().isEnabled(), 10000);
  await markOpener(p, selector);
  await p.locator(selector).first().focus();
  await p.keyboard.press('Enter');
}

const overflowX = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** WCAG contrast of visible text against its effective background (sampled elements). As a string: no build helpers inside. */
const CONTRAST_JS = `(sel) => {
  const parse = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
  const lum = (rgb) => { const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c[3] === undefined || c[3] > 0.5)) return c; } return [255, 255, 255]; };
  const out = [];
  for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 80)) {
    if (!el.offsetWidth || !el.textContent.trim() || el.closest('[inert]') || el.disabled) continue;
    const cs = getComputedStyle(el);
    const a = lum(parse(cs.color)), b = lum(bgOf(el));
    const size = parseFloat(cs.fontSize);
    out.push({ text: el.textContent.trim().slice(0, 24), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), large: size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700) });
  }
  return out;
}`;
const contrastReport = (p: Page, selector: string) =>
  p.evaluate(`(${CONTRAST_JS})(${JSON.stringify(selector)})`) as Promise<{ text: string; ratio: number; large: boolean }[]>;

/** Elements sticking out past the right or left edge (for overflow diagnostics). */
const OVERFLOWERS_JS = `(() => { const out = []; for (const e of Array.from(document.querySelectorAll('body, body *'))) { if (e.closest('.ft-wrap, .chips.scroll')) continue; const x = e.scrollWidth - e.clientWidth; if (x > 1 && e.clientWidth > 0) out.push(e.tagName + '.' + String(e.className).split(' ').slice(0, 2).join('.') + ':+' + x); } return out.slice(-6).concat(['sw=' + document.documentElement.scrollWidth]); })()`;

async function main() {
  console.log(`\n=== SiteFlow UX tests — engine: ${ENGINE} ===\n`);
  execSync(`npx vite build --outDir ${DIST} --emptyOutDir`, { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: `${BASE}/sb`, VITE_SUPABASE_PUBLISHABLE_KEY: SB_ANON, VITE_TEST_HOOKS: "1" } });
  await startServer();

  const email = `ux-${randomBytes(4).toString('hex')}@siteflow.test`;
  const password = randomBytes(18).toString('base64url');
  const created = await sbAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const orgName = `ארגון UX ${randomBytes(3).toString('hex')}`;
  const orgId = (await sbAdmin.rpc('admin_add_member', { p_email: email, p_org_name: orgName, p_role: 'engineer' })).data as string;
  const projectId = (await sbAdmin.rpc('admin_seed_demo_project', { p_org_name: orgName })).data as string;
  // A second project with a long mixed Hebrew/English name, for the project switch and RTL checks.
  const p2 = randomUUID();
  const p2b = randomUUID();
  const p2u = randomUUID();
  await sbAdmin.from('projects').insert({ id: p2, org_id: orgId, code: 'YAM-B', name: 'מגדלי הים — Building B / שלב ב׳ (Phase 2)' });
  await sbAdmin.from('locations').insert([
    { id: p2b, org_id: orgId, project_id: p2, parent_id: null, kind: 'building', name: 'בניין צפוני', code: 'N', sort_order: 0 },
    { id: p2u, org_id: orgId, project_id: p2, parent_id: p2b, kind: 'unit', name: 'דירה 101', code: 'N-101', sort_order: 1 },
  ]);

  const api = createClient(SB_URL, SB_ANON, { auth: { persistSession: false } });
  await api.auth.signInWithPassword({ email, password });
  const leaves = ((await sbAdmin.from('locations').select('id, kind').eq('project_id', projectId).in('kind', ['unit', 'common'])).data ?? []) as { id: string }[];
  const cats = ((await sbAdmin.from('categories').select('id').eq('org_id', orgId)).data ?? []) as { id: string }[];
  const defaults = new Map(((await sbAdmin.from('project_category_defaults').select('category_id, contractor_id').eq('project_id', projectId)).data ?? []).map((d) => [d.category_id, d.contractor_id]));
  const LONG = 'בחדר הרחצה של ההורים חסר סיליקון סביב האמבטיה לכל אורכה (כ-170 ס״מ), וקיימים סימני רטיבות; דגם Grohe Eurosmart 33265, לתאם עם site-manager@example.com לפני הפירוק.';
  const changes = Array.from({ length: 150 }, (_, i) => {
    const cat = cats[i % cats.length].id;
    return {
      id: randomUUID(), baseVersion: 0, createdAt: new Date().toISOString(),
      data: {
        projectId, tourId: null, batchId: null, locationId: leaves[(i * 5) % leaves.length].id, locationDetail: i % 3 ? 'מטבח' : '',
        categoryId: cat, contractorId: defaults.get(cat) ?? null, classification: i % 13 === 0 ? 'critical' : 'missing',
        description: i % 7 === 0 ? LONG : `ממצא בדיקה ${i + 1}: חסר שקע 16A ליד החלון`, status: ['open', 'reported_done', 'closed'][i % 3], photoIds: [], deletedAt: null,
      },
    };
  });
  for (let i = 0; i < changes.length; i += 75) await api.rpc('push_findings', { p_changes: changes.slice(i, i + 75) });

  const ctx = await engine.launchPersistentContext(`${OUT}profile`, { viewport: { width: 1440, height: 900 }, serviceWorkers: 'allow', acceptDownloads: true });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  const errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE);
  await p.locator('.login-card input[type=email]').fill(email);
  await p.locator('.login-card input[type=password]').fill(password);
  await p.locator('.login-card button[type=submit]').click();
  page = p;
  // ---------- Projects home ----------
  const home = await p.locator('.projects-home').waitFor({ timeout: 60000 }).then(() => true, () => false);
  const cards = await p.locator('.ph-card h3').allTextContents();
  const demoCard = p.locator('.ph-card', { hasText: 'מגדלי הפארק' });
  const homeCardText = (await demoCard.textContent()) ?? '';
  await shot(p, 'projects-home');
  check('פרויקטים: בכניסה ראשונה עם כמה פרויקטים האפליקציה נפתחת ב"הפרויקטים שלי" — כרטיסים עם סיכום אמיתי, פתח וניהול',
    home && cards.length === 2 && /\d+ ממצאים פתוחים/.test(homeCardText) && homeCardText.includes('דירות') && (await demoCard.getByRole('button', { name: /^פתח/ }).isVisible()) && (await demoCard.getByRole('button', { name: /^ניהול/ }).isVisible()),
    `${cards.join(' | ')} · ${homeCardText.slice(0, 90)}`);
  await demoCard.getByRole('button', { name: /^פתח/ }).click();
  await p.locator('.start-tour').waitFor({ timeout: 30000 });
  check('פרויקטים: "פתח" עובר לתיעוד בפרויקט שנבחר', !!(await p.locator('.project-bar .pb-name').textContent())?.includes('מגדלי הפארק'));
  await p.getByRole('button', { name: 'התחל סיור' }).click();
  await p.getByText('שמור והמשך').waitFor();
  await sync(p);
  await tab(p, 'תיעוד');
  await p.locator('.pb-all').click();
  await p.locator('.projects-home').waitFor();
  const activeTourShown = (await demoCard.locator('.ph-tour').textContent({ timeout: 10000 }).catch(() => ''))?.includes('סיור פעיל');
  await demoCard.getByRole('button', { name: /^ניהול/ }).click();
  const manageOk = await p.locator('.setup-tabs').waitFor({ timeout: 5000 }).then(() => true, () => false);
  await p.locator('.back-link').click();
  const backHome = await p.locator('.projects-home').waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('פרויקטים: נתיב קבוע חזרה לכל הפרויקטים, סיור פעיל בכרטיס, "ניהול" פותח את ניהול הפרויקט עם חזרה',
    !!activeTourShown && manageOk && backHome, `tour ${activeTourShown} · manage ${manageOk} · back ${backHome}`);
  await demoCard.getByRole('button', { name: /^המשך לתעד|^פתח/ }).click();
  await p.locator('#capture-desc').waitFor();

  // ---------- UX-03: project context on every main screen ----------
  const bars: string[] = [];
  for (const t of ['תיעוד', 'ממצאים', 'דוחות', 'פרויקטים']) {
    await tab(p, t);
    bars.push((await p.locator('.project-bar .pb-name').textContent().catch(() => '')) ?? '');
  }
  check('UX-03: שם הפרויקט הפעיל מוצג בתיעוד, ממצאים, דוחות ופרויקט', bars.every((b) => b.includes('מגדלי הפארק')), bars.join(' | '));
  await tab(p, 'ממצאים');
  check('UX-03: הסיור הפעיל מוצג בהקשר הפרויקט (ממצאים)', !!(await p.locator('.project-bar .pb-tour').textContent())?.includes('סיור'));
  const h1s = await p.evaluate(() => [...document.querySelectorAll('h1')].map((h) => h.textContent));
  check('UX-02: כותרת h1 אמיתית למסך', h1s.length === 1 && h1s[0] === 'ממצאים', h1s.join());

  // Separate drafts across a project switch: nothing of project A's draft appears in project B.
  await tab(p, 'תיעוד');
  await p.locator('.chips .chip').first().click();
  await p.locator('#capture-desc').fill('טיוטה של פרויקט א');
  const contractorA = await p.locator('.drow-select option:checked').textContent();
  await openWithKeyboard(p, '.pb-switch');
  await p.locator('[role=dialog]').waitFor();
  await p.getByRole('radio', { name: /מגדלי הים/ }).click();
  await p.locator('[role=dialog]').waitFor({ state: 'detached' });
  const projBStart = await p.locator('.start-tour').or(p.locator('#capture-desc')).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  if (await p.locator('.start-tour').isVisible()) {
    await p.getByRole('button', { name: 'התחל סיור' }).click();
    await p.locator('#capture-desc').waitFor();
  }
  const descB = await p.locator('#capture-desc').inputValue();
  const contractorB = await p.locator('.drow-select option:checked').textContent();
  const locB = await p.locator('.locbar .loc-name').textContent();
  const barB = await p.locator('.project-bar .pb-name').textContent();
  await p.locator('.pb-switch').click();
  await p.getByRole('radio', { name: /מגדלי הפארק/ }).click();
  await until(async () => (await p.locator('#capture-desc').inputValue()) === 'טיוטה של פרויקט א', 5000);
  const descA = await p.locator('#capture-desc').inputValue();
  check('UX-03: החלפת פרויקט מבורר הפרויקט — טיוטה נפרדת לכל פרויקט (תיאור, קבלן ומיקום לא עוברים)',
    projBStart && !!barB?.includes('מגדלי הים') && descB === '' && contractorB === 'בחר' && locB === 'דירה 101' && descA === 'טיוטה של פרויקט א' && contractorA !== 'בחר',
    `B: "${descB}" / ${contractorB} / ${locB} · A: "${descA}"`);
  await p.locator('#capture-desc').fill('');

  // ---------- UX-02: dialogs, keyboard only ----------
  await dialogKeyboard(p, 'החלפת פרויקט', () => openWithKeyboard(p, '.pb-switch'));
  await dialogKeyboard(p, 'בורר מיקום', () => openWithKeyboard(p, '.locbar .loc'));
  await tab(p, 'פרויקטים');
  await p.locator('.setup-tabs, .projects-home').first().waitFor();
  if (await p.locator('.back-link').isVisible()) await p.locator('.back-link').click();
  await dialogKeyboard(p, 'פרויקט חדש', () => openWithKeyboard(p, 'button:has-text("+ פרויקט חדש")'));
  await p.locator('.ph-card', { hasText: 'מגדלי הפארק' }).getByRole('button', { name: /^ניהול/ }).click();
  await p.locator('.setup-tabs button', { hasText: 'קבלנים' }).click();
  await dialogKeyboard(p, 'הוספת קבלן', () => openWithKeyboard(p, 'button:has-text("+ הוסף קבלן")'));
  await p.locator('.setup-tabs button', { hasText: 'מבנה' }).click();
  await dialogKeyboard(p, 'מחולל בניין', () => openWithKeyboard(p, 'button:has-text("+ בניין (מחולל)")'));
  await tab(p, 'דוחות');
  await p.locator('.rp-branding .muted').filter({ hasNotText: 'טוען' }).waitFor();
  await dialogKeyboard(p, 'הגדרות דוח', () => openWithKeyboard(p, 'button:has-text("הגדרות דוח")'));
  await tab(p, 'ממצאים');
  await view(p, 'סיורים');
  await dialogKeyboard(p, 'פרטי סיור', () => openWithKeyboard(p, '.tour-item'));
  await view(p, 'ממצאים');
  await dialogKeyboard(p, 'עריכת ממצא', () => openWithKeyboard(p, '.finding-card'));

  // The location picker inside the finding editor is a view of the same popup, with a way back.
  await openWithKeyboard(p, '.finding-card');
  await p.locator('[role=dialog]').waitFor();
  await markOpener(p, '.sheet .loc-btn');
  await p.locator('.sheet .loc-btn').focus();
  await p.keyboard.press('Enter');
  await p.locator('[role=dialog] .picker-search').waitFor();
  const inner = await focusState(p);
  const oneDialog = (await p.locator('[role=dialog]').count()) === 1;
  const backLabel = await p.locator('[role=dialog] .popup-head .link').textContent();
  await p.keyboard.press('Escape');
  await p.locator('[role=dialog] .loc-btn').waitFor();
  const backToLoc = await p.evaluate(() => document.activeElement?.classList.contains('loc-btn') ?? false);
  const stillOpen = (await p.locator('[role=dialog]').count()) === 1;
  await p.keyboard.press('Escape');
  const allClosed = await until(async () => (await p.locator('[role=dialog]').count()) === 0, 3000);
  check('UX-02: בחירת מיקום מתוך עריכת ממצא — תצוגה באותו חלון עם "חזרה", Escape חוזר לטופס והפוקוס לכפתור המיקום, Escape נוסף סוגר',
    inner.inTop && oneDialog && backLabel === 'חזרה לממצא' && backToLoc && stillOpen && allClosed, `inTop ${inner.inTop} · one ${oneDialog} · back ${backToLoc}`);

  // Unsaved typing is not dropped silently.
  await p.locator('.finding-card').first().click();
  await p.locator('.sheet textarea.desc').fill('שינוי שלא נשמר');
  await p.keyboard.press('Escape');
  const asked = await p.getByText('יש שינויים שלא נשמרו').isVisible();
  await p.getByRole('button', { name: 'המשך לערוך' }).click();
  const kept = (await p.locator('.sheet textarea.desc').inputValue()) === 'שינוי שלא נשמר';
  await p.keyboard.press('Escape');
  await p.getByRole('button', { name: 'סגור בלי לשמור' }).click();
  check('UX-02: טופס עם שינויים — סגירה שואלת ולא מוחקת בשקט', asked && kept && (await p.locator('[role=dialog]').count()) === 0);

  // ---------- UX-01/08: list with search, filter sheet, chips (390px) ----------
  await p.setViewportSize({ width: 390, height: 844 });
  await tab(p, 'ממצאים');
  await view(p, 'ממצאים');
  const card = p.locator('.finding-card').first();
  await card.waitFor();
  const cardText = (await card.textContent()) ?? '';
  check('UX-08: כרטיס ממצא מציג מספר, מיקום מלא, קבלן וסטטוס', /#\d+/.test(cardText) && cardText.includes('›') && (await card.locator('.fc-contractor').isVisible()) && (await card.locator('.tag[class*="status-"]').isVisible()), cardText.slice(0, 80));
  await p.locator('.ff-search input').fill('16A');
  const searched = await until(async () => (await p.locator('.finding-card').count()) > 0 && (await p.locator('.finding-card').allTextContents()).every((t) => t.includes('16A')));
  check('UX-08: חיפוש ברשימה הרגילה', searched);
  await p.locator('.ff-search input').fill('');
  await markOpener(p, '.ff-open');
  await p.locator('.ff-open').click();
  await p.locator('.ff-sheet').waitFor();
  await p.locator('.ff-sheet select[aria-label="סטטוס"]').selectOption('closed');
  await p.locator('.ff-sheet select[aria-label="בניין"]').selectOption({ label: 'בניין A' });
  await p.getByRole('button', { name: 'החל', exact: true }).click();
  await p.locator('.ff-sheet').waitFor({ state: 'detached' });
  const chips = await p.locator('.ff-chip').allTextContents();
  const btn = await p.locator('.ff-open').textContent();
  const allClosedA = (await p.locator('.finding-card .tag.status-closed').count()) === (await p.locator('.finding-card').count()) && (await p.locator('.finding-card').count()) > 0;
  check('UX-01: במובייל — כפתור "מסננים (N)", חלונית עם החל, צ׳יפים של המסננים הפעילים', btn === 'מסננים (2)' && chips.length === 2 && allClosedA, `${btn} · ${chips.join(' | ')}`);
  await p.locator('.ff-chip', { hasText: 'נסגר' }).click();
  check('UX-01: הסרת מסנן בצ׳יפ', (await p.locator('.ff-open').textContent()) === 'מסננים (1)');
  // Filters survive switching to the management view and back (shared model).
  await view(p, 'טבלת ניהול');
  await p.locator('.ff-chip').first().waitFor({ timeout: 5000 }).catch(() => {});
  const sharedChip = await p.locator('.ff-chip').allTextContents();
  check('UX-08: מסננים משותפים לרשימה ולטבלת הניהול', sharedChip.some((c) => c.includes('בניין A')), sharedChip.join());
  await p.locator('.ff-search input').fill('אין-כזה-ממצא-בכלל');
  await p.locator('.empty-state').waitFor();
  await p.getByRole('button', { name: 'נקה חיפוש ומסננים' }).click();
  check('UX-01: מצב ריק עם איפוס ישיר', (await p.locator('.ff-chip').count()) === 0 && (await p.locator('.card-row').count()) > 0);

  // Management at 390px: cards, no horizontal scrolling, contractor and status visible; open/edit/return.
  const ov390 = await overflowX(p);
  const mgmtCard = p.locator('.card-row').first();
  const cardOk = (await mgmtCard.locator('.fc-contractor').isVisible()) && (await mgmtCard.locator('.tag[class*="status-"]').isVisible());
  await shot(p, '390-management');
  check('UX-01: ניהול ב-390px — כרטיסים, קבלן וסטטוס גלויים, ללא גלילה אופקית', ov390 <= 1 && cardOk && (await p.locator('table.ft').count()) === 0, `גלישה ${ov390}px`);
  await p.locator('.ff-open').click();
  await p.locator('.ff-sheet select[aria-label="סטטוס"]').selectOption('open');
  await p.getByRole('button', { name: 'החל', exact: true }).click();
  const before = await p.locator('.card-row').count();
  await p.locator('.card-row .finding-card').first().click();
  await p.locator('.sheet .field', { hasText: 'סטטוס' }).locator('select').selectOption('reported_done');
  await p.getByRole('button', { name: 'שמור שינויים' }).click();
  await p.locator('[role=dialog]').waitFor({ state: 'detached' });
  const after = await p.locator('.card-row').count();
  check('UX-01: פתיחה, עריכה וחזרה — המסנן נשמר (הממצא שנסגר יצא מהרשימה המסוננת)', after === before - 1 && (await p.locator('.ff-open').textContent()) === 'מסננים (1)', `${before} → ${after}`);
  // Bulk selection on mobile.
  await p.locator('.card-row input[type=checkbox]').nth(0).check();
  await p.locator('.card-row input[type=checkbox]').nth(1).check();
  check('UX-01: בחירה מרובה במובייל', !!(await p.locator('.ft-bulk b').textContent())?.includes('נבחרו 2'));
  await p.getByRole('button', { name: 'בטל בחירה' }).click();
  await p.locator('.ff-chips .link').click();

  // ---------- UX-05/13: desktop workspace ----------
  await p.setViewportSize({ width: 1440, height: 900 });
  await view(p, 'טבלת ניהול');
  await p.locator('table.ft').waitFor();
  const fit = await p.locator('.ft-wrap').evaluate((e) => e.scrollWidth - e.clientWidth);
  check('UX-05: ב-1440px כל עמודות ברירת המחדל נכנסות בלי גלילה אופקית', fit <= 1, `${fit}px`);
  const first = p.locator('table.ft tbody tr').first();
  const firstId = await first.getAttribute('data-id');
  await first.locator('.ft-check input').check();
  const scrollBefore = await p.evaluate(() => window.scrollY);
  await first.locator('.ft-open').click();
  await p.locator('[role=dialog]').waitFor();
  const g = await popupGeometry(p);
  const wide = await p.locator('[role=dialog]').evaluate((e) => e.getBoundingClientRect().width);
  await shot(p, '1440-finding-popup');
  await p.locator('[role=dialog] .link', { hasText: 'סגור' }).click();
  const stillSelected = await p.locator(`tr[data-id="${firstId}"] .ft-check input`).isChecked();
  const scrollAfter = await p.evaluate(() => window.scrollY);
  check('UX-05: עריכת ממצא בחלון ממורכז ורחב מספיק; אחרי סגירה הבחירה, המסננים והגלילה נשמרים',
    popupOk(g) && wide >= 700 && stillSelected && scrollAfter === scrollBefore, `${JSON.stringify(g)} · ${Math.round(wide)}px`);
  await p.locator('.ft-columns summary').click();
  await p.locator('.ft-columns-menu label', { hasText: 'קטגוריה' }).locator('input').uncheck();
  const headers = await p.locator('table.ft thead th').allTextContents();
  check('UX-05: בורר עמודות', !headers.some((h) => h.includes('קטגוריה')) && headers.some((h) => h.includes('קבלן')), headers.join('|'));
  await p.locator('.ft-columns-menu label', { hasText: 'קטגוריה' }).locator('input').check();
  await p.locator('.ft-columns summary').click();
  await p.getByRole('button', { name: 'בטל בחירה' }).click();

  // Inline save feedback, failure and retry (simulated storage failure: existing test mechanism).
  const row = p.locator('table.ft tbody tr').nth(2);
  const no = (await row.locator('.ft-no').textContent())!.slice(1);
  await row.locator(`select[aria-label="סטטוס לממצא ${no}"]`).selectOption('reopened');
  const savedMsg = await row.locator('.row-save.ok').waitFor({ timeout: 5000 }).then(() => true, () => false);
  await p.evaluate(() => localStorage.setItem('sf.debug.failWrites', '1'));
  await row.locator(`select[aria-label="סטטוס לממצא ${no}"]`).selectOption('closed');
  const errShown = await row.locator('.row-save.error').waitFor({ timeout: 5000 }).then(() => true, () => false);
  const notFalse = !(await row.locator('.row-save.ok').isVisible());
  await p.evaluate(() => localStorage.removeItem('sf.debug.failWrites'));
  await row.locator('.row-save.error .link', { hasText: 'נסה שוב' }).click();
  const retried = await row.locator('.row-save.ok').waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('UX-13: עריכה בשורה — "נשמר במכשיר", כשל מוצג בלי הצלחה מדומה, "נסה שוב" מצליח', savedMsg && errShown && notFalse && retried, `${savedMsg} ${errShown} ${notFalse} ${retried}`);

  // Two-step bulk edit with explicit scope.
  await p.locator('table.ft tbody tr').nth(0).locator('.ft-check input').check();
  await p.locator('table.ft tbody tr').nth(1).locator('.ft-check input').check();
  await p.getByLabel('שינוי סטטוס לנבחרים').selectOption('reported_done');
  const notYet = !(await p.locator('.ftable .alert[role=status]').isVisible());
  const scope = await p.locator('.ft-bulk-apply').textContent();
  await p.getByRole('button', { name: 'החל על 2 ממצאים' }).click();
  const done = await p.locator('.ftable .alert[role=status]').textContent();
  check('UX-13: עריכה מרובה בשני שלבים — היקף מוצג לפני ההחלה', notYet && !!scope?.includes('עבור 2 ממצאים') && !!done?.includes('עודכנו'), scope ?? '');
  await p.getByRole('button', { name: 'בטל בחירה' }).click();

  // ---------- UX-06/07: capture ----------
  await tab(p, 'תיעוד');
  await p.locator('#capture-desc').waitFor();
  await p.getByRole('button', { name: /כל הקטגוריות/ }).click();
  const wrapped = await p.locator('.chips.wrap').isVisible();
  await p.getByRole('button', { name: 'שורה אחת' }).click();
  check('UX-07: "כל הקטגוריות" מציג את כולן', wrapped);
  await p.locator('.locbar .loc').click();
  await p.getByRole('radio', { name: 'כמה מיקומים' }).click();
  const sel1 = await p.locator('.picker-selection').textContent();
  await p.getByRole('button', { name: 'נקה בחירה' }).click();
  const sel0 = await p.locator('.picker-selection b').textContent();
  await p.locator('.picker-floor', { hasText: 'קומה 1' }).first().getByRole('button', { name: 'דירה 1', exact: true }).click();
  await p.locator('.picker-floor', { hasText: 'קומה 1' }).first().getByRole('button', { name: 'דירה 2', exact: true }).click();
  await p.locator('.picker-done .primary').click();
  const strip = (await p.locator('.multi-strip').textContent()) ?? '';
  const saveLabel = await p.locator('.savebar .primary').textContent();
  check('UX-06: המיקום הנוכחי מסומן מראש עם הסבר, מונה, ניקוי בחירה', !!sel1?.includes('נבחרו 1') && !!sel1.includes('נבחר מראש') && sel0 === 'נבחרו 0', sel1 ?? '');
  check('UX-06: נתיב מלא ושמירה מפורשת "שמור 2 ממצאים", הסבר על תמונות משותפות', strip.includes('בניין A › קומה 1 › דירה 1') && strip.includes('משותפות') && !!saveLabel?.includes('שמור 2 ממצאים'), saveLabel ?? '');
  await p.locator('.chips .chip').first().click();
  await p.locator('#capture-desc').fill('UX — שני מיקומים בדיקה');
  await p.locator('.savebar .primary').click();
  await p.locator('.toast').waitFor();
  const toast = await p.locator('.toast').textContent();
  const local = await p.evaluate(
    () =>
      new Promise<{ desc: string; batch: string | null; status: string }[]>((res) => {
        const r = indexedDB.open('siteflow');
        r.onsuccess = () => {
          const all = r.result.transaction('findings').objectStore('findings').getAll();
          all.onsuccess = () => res((all.result as { description: string; batchId: string | null; status: string }[]).filter((f) => f.description === 'UX — שני מיקומים בדיקה').map((f) => ({ desc: f.description, batch: f.batchId, status: f.status })));
        };
      }),
  );
  check('UX-06: נוצרו בדיוק 2 ממצאים עצמאיים עם batch משותף, והודעה עם קישור לממצאים',
    local.length === 2 && !!local[0].batch && local[0].batch === local[1].batch && !!toast?.includes('נשמרו 2 ממצאים') && (await p.locator('.toast-link').isVisible()), toast ?? '');
  check('UX-06: אחרי השמירה אין מיקום נוסף מוסתר — חזרה למיקום אחד', (await p.locator('.multi-strip').count()) === 0 && (await p.locator('.savebar .primary').textContent())!.includes('שמור והמשך'));

  // ---------- UX-09: tours ----------
  await tab(p, 'ממצאים');
  await view(p, 'סיורים');
  await p.locator('.tour-item.is-active').click();
  const summary = await p.locator('.tour-summary').isVisible();
  const editSection = await p.locator('.tour-edit h3').textContent();
  await p.getByRole('button', { name: 'סגור סיור' }).click();
  await p.getByRole('button', { name: 'כן, סגור סיור' }).click();
  await p.locator('[role=dialog]').waitFor({ state: 'detached' });
  const next = await p.locator('.next-step').textContent();
  await p.getByRole('button', { name: 'הצג את ממצאי הסיור' }).click();
  await p.locator('.ff-chip').first().waitFor();
  const tourChip = await p.locator('.ff-chip').first().textContent();
  const tourCards = await p.locator('.finding-card').count();
  check('UX-09: פרטי סיור — סיכום, אזור עריכה נפרד; אחרי סגירה הצעה לצפות בממצאי הסיור או להכין דוח',
    summary && editSection === 'פרטי הסיור' && !!next?.includes('הכנת דוח לסיור') && !!tourChip?.includes('סיור') && tourCards === 2, `${tourChip} · ${tourCards}`);
  await p.locator('.ff-chips .link').click();

  // ---------- UX-04/14: reports ----------
  await p.setViewportSize({ width: 320, height: 740 });
  await tab(p, 'דוחות');
  await p.locator('.rp-form').waitFor();
  const cols = await p.locator('.rp-cols').first().locator('select').evaluateAll((s) => s.map((e) => e.getBoundingClientRect().left));
  const clipped = await p.locator('.rp-form select').evaluateAll((s) =>
    s.filter((e) => (e as HTMLElement).offsetWidth).some((e) => (e as HTMLSelectElement).getBoundingClientRect().right > document.documentElement.clientWidth + 1),
  );
  const ov320 = await overflowX(p);
  const primaries = await p.locator('.rp-form .primary').count();
  const advancedClosed = !(await p.locator('.rp-advanced').evaluate((d) => (d as HTMLDetailsElement).open));
  await shot(p, '320-reports');
  check('UX-04: 320px — עמודה אחת, בחירות לא חתוכות, כפתור הפקה יחיד, אפשרויות מתקדמות מקופלות',
    cols.length === 2 && Math.abs(cols[0] - cols[1]) < 2 && !clipped && ov320 <= 1 && primaries === 1 && advancedClosed, `overflow ${ov320}px · primaries ${primaries}`);
  const countText = await p.locator('.rp-count').textContent();
  check('UX-04: הבחנה בין הערכה מקומית לתוצאה מהשרת', !!countText?.includes('הערכה') && !!countText.includes('בשרת'), countText ?? '');
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.getByRole('radio', { name: /פרוטוקול מפורט/ }).click();
  await p.getByRole('radio', { name: /דוח טבלאי מרוכז/ }).click();
  await p.getByRole('button', { name: 'הפק דוח' }).click();
  await p.locator('.rp-issued').waitFor({ timeout: 120000 });
  const issuedText = await p.locator('.rp-issued').textContent();
  const entry = p.locator('.report-entry').first();
  const visibleText = await entry.locator('.item').textContent();
  const hashHidden = !(await entry.getByText('SHA-256').isVisible());
  await entry.locator('.rp-more summary').click();
  const reissueNote = await entry.locator('.rp-reissue').textContent();
  await entry.getByRole('button', { name: /יומן הפצה/ }).click();
  const distNote = await entry.locator('.dist-note').textContent();
  check('UX-04/14: אחרי הפקה — מספר, כמות, פתיחה והורדה; בארכיון כותרת/מספר/תאריך/כמות בולטים, hash בפרטים, גרסה מעודכנת משנית עם הסבר',
    !!issuedText?.match(/DEMO-T-\d+/) && (await p.locator('.rp-issued .btn', { hasText: 'הורדה' }).isVisible()) && !!visibleText?.includes('ממצאים') && hashHidden && !!reissueNote?.includes('נשמרת'),
    issuedText ?? '');
  check('UX-14: יומן הפצה מסומן כרישום ידני שלא שולח דבר', !!distNote?.includes('לא שולח'));

  // ---------- Editing an existing building: visible actions, add units to a floor ----------
  await tab(p, 'פרויקטים');
  await p.locator('.setup-tabs, .projects-home').first().waitFor();
  if (!(await p.locator('.setup-tabs').isVisible())) await p.locator('.ph-card', { hasText: 'מגדלי הפארק' }).getByRole('button', { name: /^ניהול/ }).click();
  await p.locator('.setup-tabs button', { hasText: 'מבנה' }).click();
  const bA = p.locator('.st-root', { hasText: 'בניין A' }).first();
  const actions = await bA.locator('.st-actions button').allTextContents();
  const floor1 = bA.locator('.st-floor', { has: p.locator('.st-floor-name', { hasText: /^קומה 1$/ }) });
  const unitsBefore = await floor1.locator('.st-chip:not(.st-add)').count();
  await floor1.locator('.st-add').click();
  await p.locator('[role=dialog]').waitFor();
  await p.getByLabel('כמה דירות').fill('2');
  const preview = await p.locator('[role=dialog] .preview').textContent();
  await shot(p, 'add-units');
  await p.locator('[role=dialog] .primary').click();
  await p.locator('[role=dialog]').waitFor({ state: 'detached', timeout: 15000 });
  await until(async () => (await floor1.locator('.st-chip:not(.st-add)').count()) === unitsBefore + 2);
  const unitsAfter = await floor1.locator('.st-chip:not(.st-add)').count();
  check('עריכת בניין קיים: פעולות גלויות (עריכה, + קומות, + שטח משותף) והוספת כמה דירות לקומה עם תצוגה מקדימה',
    actions.join('|') === 'עריכה|+ קומות|+ שטח משותף' && !!preview?.includes('יתווספו 2 דירות') && unitsAfter === unitsBefore + 2, `${actions.join('|')} · ${unitsBefore} → ${unitsAfter} · ${preview}`);
  await p.locator('.st-root', { hasText: 'בניין A' }).first().getByRole('button', { name: '+ קומות' }).click();
  const floorsDialog = await p.locator('[role=dialog]', { hasText: 'הוספת קומות' }).isVisible();
  await p.keyboard.press('Escape');
  check('עריכת בניין קיים: "+ קומות" פותח את מחולל הקומות לבניין', floorsDialog);

  // ---------- UX-10/11 ----------
  await tab(p, 'פרויקטים');
  await p.locator('.setup-tabs, .projects-home').first().waitFor();
  if (!(await p.locator('.setup-tabs').isVisible())) await p.locator('.ph-card', { hasText: 'מגדלי הפארק' }).getByRole('button', { name: /^ניהול/ }).click();
  await p.locator('.setup-tabs button', { hasText: 'קטגוריות' }).click();
  await p.locator('.scope-tag').nth(1).waitFor();
  const tags = await p.locator('.scope-tag').allTextContents();
  check('UX-10: הפרדה בין ברירות מחדל לפרויקט לבין ספריית הארגון', tags.length === 2 && tags[0].includes('רק בפרויקט') && tags[1].includes('כל פרויקטי הארגון'), tags.join(' | '));
  await tab(p, 'הגדרות');
  await p.locator('.settings-screen .set-status').waitFor();
  const routine = (await p.getByRole('button', { name: 'סנכרן עכשיו' }).isVisible()) && (await p.getByRole('button', { name: 'ייצוא גיבוי' }).isVisible()) && (await p.getByRole('button', { name: 'יציאה מהחשבון' }).isVisible());
  // Diagnostics and test tools must not exist anywhere a user can reach — not even hidden in a menu.
  const forbidden = ['סימולציית', 'קוד גישה', 'Service Worker', 'בדיקת כתיבה', 'אחסון קבוע', 'persisted', 'מכסה', 'אבחון', 'מתקדם'];
  const leaks: string[] = [];
  for (const t of ['תיעוד', 'ממצאים', 'דוחות', 'פרויקטים', 'הגדרות']) {
    await tab(p, t);
    await p.waitForTimeout(200);
    const html = await p.evaluate(() => document.body.innerHTML);
    for (const w of forbidden) if (html.includes(w)) leaks.push(`${t}:${w}`);
  }
  check('UX-11: הגדרות — מצב שמירה פשוט, חשבון, פרטי החברה וגיבוי; אין כלי אבחון או בדיקה בשום מסך (גם לא תחת "מתקדם")', routine && leaks.length === 0, leaks.join(', '));

  // ---------- Layout at 320/390/768/1440 and 200% zoom ----------
  const widths = [320, 390, 768, 1440];
  const bad: string[] = [];
  for (const w of widths) {
    await p.setViewportSize({ width: w, height: 900 });
    for (const [t, v] of [['תיעוד', ''], ['ממצאים', 'ממצאים'], ['ממצאים', 'טבלת ניהול'], ['ממצאים', 'סיורים'], ['דוחות', ''], ['פרויקטים', ''], ['הגדרות', '']] as const) {
      await tab(p, t);
      if (v) await view(p, v);
      await p.waitForTimeout(150);
      const o = await overflowX(p);
      if (o > 1) bad.push(`${w}:${t}/${v}:${o}px ${(await p.evaluate(OVERFLOWERS_JS) as string[]).join(' ')}`);
      await shot(p, `${w}-${t}${v ? `-${v}` : ''}`);
    }
  }
  check('UX: אין גלילה אופקית של הדף ב-320/390/768/1440 בכל המסכים הראשיים', bad.length === 0, bad.join(', '));
  // 200% browser zoom of a 1440px window ≈ a 720px-wide CSS viewport.
  await p.setViewportSize({ width: 720, height: 450 });
  const zoomBad: string[] = [];
  for (const t of ['תיעוד', 'ממצאים', 'דוחות', 'הגדרות']) {
    await tab(p, t);
    const o = await overflowX(p);
    if (o > 1) zoomBad.push(`${t}:${o}px`);
  }
  check('UX: זום 200% (רוחב 720px) — ללא גלילה אופקית', zoomBad.length === 0, zoomBad.join(', '));

  // ---------- Every popup centered and rounded at every width (UX-16) ----------
  for (const w of [320, 390, 768]) {
    await p.setViewportSize({ width: w, height: w === 768 ? 1024 : 800 });
    const probe = async (label: string, open: () => Promise<void>) => {
      await open();
      await p.locator('[role=dialog]').last().waitFor();
      await p.waitForTimeout(200);
      const g = await popupGeometry(p);
      if (!popupOk(g)) popupFails.push(`${label}@${w}: ${JSON.stringify(g)}`);
      if (w === 390) await shot(p, `popup-390-${label}`);
      await p.keyboard.press('Escape');
      await until(async () => (await p.locator('[role=dialog]').count()) === 0, 3000);
    };
    await tab(p, 'ממצאים');
    await view(p, 'ממצאים');
    await probe('filters', () => p.locator('.ff-open').click());
    await probe('finding', () => p.locator('.finding-card').first().click());
    await tab(p, 'תיעוד');
    // The tour was closed earlier in this run: start one to reach the capture form.
    await p.locator('.locbar .loc, .start-tour').first().waitFor();
    if (await p.locator('.start-tour').isVisible()) await p.getByRole('button', { name: 'התחל סיור' }).click();
    await p.locator('.locbar .loc').waitFor();
    await probe('picker', () => p.locator('.locbar .loc').click());
    await tab(p, 'פרויקטים');
    await p.locator('.setup-tabs, .projects-home').first().waitFor();
    if (await p.locator('.back-link').isVisible()) await p.locator('.back-link').click();
    await probe('new-project', () => p.getByRole('button', { name: '+ פרויקט חדש' }).click());
    await tab(p, 'הגדרות');
    await probe('identity', () => p.getByRole('button', { name: 'עריכת פרטי החברה והעורך' }).click());
  }
  check('UX-16: כל החלונות ממורכזים ומעוגלים (≥20px), עם מסגרת ושוליים גלויים, בלי ידית גרירה — ב-320/390/768/1440', popupFails.length === 0, popupFails.slice(0, 4).join(' · '));

  // ---------- One checkbox control everywhere (UX-16) ----------
  await p.setViewportSize({ width: 1440, height: 900 });
  const cbAudit = async () =>
    p.evaluate(() =>
      [...document.querySelectorAll('input[type=checkbox]')]
        .filter((e) => (e as HTMLElement).offsetWidth)
        .map((e) => {
          const cs = getComputedStyle(e);
          return {
            ok: cs.appearance === 'none' && parseFloat(cs.width) >= 22 && parseFloat(cs.width) <= 24 && parseFloat(cs.borderTopLeftRadius) >= 4,
            checked: (e as HTMLInputElement).checked,
            bg: cs.backgroundColor,
            what: `${e.parentElement?.className}:${cs.appearance}/${cs.width}/${cs.borderTopLeftRadius}`,
          };
        }),
    );
  const audits: { ok: boolean; checked: boolean; bg: string; what: string }[] = [];
  await tab(p, 'דוחות');
  await p.locator('.rp-form').waitFor();
  audits.push(...(await cbAudit()));
  await tab(p, 'ממצאים');
  await view(p, 'טבלת ניהול');
  await p.locator('table.ft').waitFor();
  await p.locator('table.ft tbody tr').nth(1).locator('.ft-check input').check();
  const mixed = await p.getByLabel('בחר את כל הממצאים המסוננים').evaluate((e) => (e as HTMLInputElement).indeterminate);
  await p.waitForTimeout(300); // colour transition
  audits.push(...(await cbAudit()));
  await p.locator('.ft-columns summary').click();
  audits.push(...(await cbAudit()));
  await p.locator('.ft-columns summary').click();
  await p.getByRole('button', { name: 'בטל בחירה' }).click();
  await p.setViewportSize({ width: 390, height: 844 });
  await p.locator('.card-row').first().waitFor();
  audits.push(...(await cbAudit()));
  const checkedFill = audits.filter((a) => a.checked).every((a) => a.bg !== 'rgb(255, 255, 255)');
  const rowTarget = await p.locator('.ft-selectall').evaluate((e) => e.getBoundingClientRect().height);
  await p.locator('.card-row input[type=checkbox]').first().focus();
  await p.keyboard.press('Space');
  const spaceWorks = await p.locator('.card-row input[type=checkbox]').first().isChecked();
  await p.keyboard.press('Space');
  check('UX-16: כל תיבות הסימון בעיצוב האחיד (22–24px, פינות מעוגלות, מילוי כשמסומן), "בחר הכול" במצב חלקי, שורה לחיצה ≥44px, רווח מסמן',
    audits.length > 10 && audits.every((a) => a.ok) && checkedFill && mixed && rowTarget >= 44 && spaceWorks,
    `${audits.length} תיבות · לא תקינות ${audits.filter((a) => !a.ok).length} ${[...new Set(audits.filter((a) => !a.ok).map((a) => a.what))].join(' ')} · mixed ${mixed} · fill ${checkedFill} · space ${spaceWorks} · שורה ${Math.round(rowTarget)}px`);
  await p.setViewportSize({ width: 1440, height: 900 });

  // ---------- Contrast ----------
  await p.setViewportSize({ width: 1440, height: 900 });
  const low: string[] = [];
  let sampled = 0;
  for (const [t, v] of [['ממצאים', 'ממצאים'], ['ממצאים', 'טבלת ניהול'], ['דוחות', ''], ['הגדרות', '']] as const) {
    await tab(p, t);
    if (v) await view(p, v);
    await p.locator('.finding-card, table.ft, .rp-form, .settings-screen .set-card').first().waitFor();
    await p.waitForTimeout(300);
    const rep = await contrastReport(p, '.muted, .tag, .label, .fc-loc, .pb-label, .pb-code, .hint, .savebar-hint, .row-save, .ff-field, .rp-type span, .btn, .link');
    sampled += rep.length;
    for (const r of rep)
      if (r.ratio < (r.large ? 3 : 4.5)) low.push(`${r.text}:${r.ratio.toFixed(2)}`);
  }
  check('UX: ניגודיות טקסט ≥ 4.5:1 (טקסט רגיל) בדגימת תגים, טקסט משני וכפתורים', sampled > 50 && low.length === 0, `${sampled} רכיבים נמדדו ${[...new Set(low)].slice(0, 8).join(' · ')}`);

  check('UX: אין שגיאות JavaScript בדף', errors.filter((e) => !(ENGINE === 'webkit' && /access control checks/.test(e))).length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
  await sbAdmin.auth.admin.deleteUser(created.data.user.id);
}

try {
  await main();
} catch (e) {
  check('הרצת הבדיקות', false, (e as Error).stack ?? String(e));
  await page?.screenshot({ path: `${OUT}failure.png` }).catch(() => {});
} finally {
  if (server?.pid) process.kill(-server.pid, 'SIGKILL');
  rmSync(DIST, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  writeFileSync(`${OUT}results.json`, JSON.stringify({ engine: ENGINE, at: new Date().toISOString(), results }, null, 1));
  console.log(`\n${results.length - failed.length}/${results.length} passed (${ENGINE})`);
  process.exit(failed.length ? 1 : 0);
}
