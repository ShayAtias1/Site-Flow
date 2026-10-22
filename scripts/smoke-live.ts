// Deployment smoke test: fails if the live site serves raw Vite source files, references missing assets,
// has a wrong PWA scope, or the app does not initialise to its login screen in a real browser.
// Read-only: it never touches IndexedDB or service-worker storage of any real profile (fresh browser context).
// Usage: tsx scripts/smoke-live.ts [url] [--wait=seconds]
//   default url: https://shayatias1.github.io/Site-Flow/
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const URL_ = (args.find((a) => !a.startsWith('--')) ?? 'https://shayatias1.github.io/Site-Flow/').replace(/\/?$/, '/');
const WAIT = Number(args.find((a) => a.startsWith('--wait='))?.slice(7) ?? 0);
const BASE_PATH = new URL(URL_).pathname;

async function get(url: string) {
  const r = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  return { status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() };
}

async function checkOnce(): Promise<string[]> {
  const fails: string[] = [];
  const page = await get(`${URL_}?smoke=${Date.now()}`);
  if (page.status !== 200) return [`HTML: HTTP ${page.status}`];
  if (/src=["']\/?src\/main\.tsx/.test(page.body) || page.body.includes('/src/main.tsx'))
    return ['HTML references /src/main.tsx — the live site serves raw Vite source, not the build output (Pages source must be "GitHub Actions")'];
  const assets = [...page.body.matchAll(/(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g)].map((m) => m[1]);
  if (!assets.some((a) => a.endsWith('.js'))) fails.push('HTML has no compiled JavaScript under assets/');
  if (!assets.some((a) => a.endsWith('.css'))) fails.push('HTML has no compiled CSS under assets/');
  for (const a of assets) {
    if (!a.startsWith(BASE_PATH)) fails.push(`asset outside base path: ${a}`);
    const r = await get(new URL(a, URL_).href);
    const wantJs = a.endsWith('.js');
    if (r.status !== 200) fails.push(`${a}: HTTP ${r.status}`);
    else if (/^\s*<!doctype html/i.test(r.body)) fails.push(`${a}: returned HTML instead of an asset`);
    else if (wantJs && !/javascript|ecmascript/.test(r.type)) fails.push(`${a}: content-type ${r.type}`);
    else if (!wantJs && !/css/.test(r.type)) fails.push(`${a}: content-type ${r.type}`);
    else if (r.body.length < 500) fails.push(`${a}: suspiciously small (${r.body.length} bytes)`);
    if (wantJs && r.status === 200) {
      if (!/https:\/\/[a-z0-9]+\.supabase\.co/.test(r.body)) fails.push('bundle has no Supabase URL (build env missing)');
      // Real keys only (supabase-js itself mentions "sb_secret_" as a prefix in its code).
      const jwtRoles = [...r.body.matchAll(/eyJ[\w-]+\.([\w-]+)\.[\w-]+/g)].map((m) => {
        try {
          return JSON.parse(Buffer.from(m[1], 'base64url').toString()).role as string;
        } catch {
          return '';
        }
      });
      if (/sb_secret_[A-Za-z0-9_-]{20,}/.test(r.body) || jwtRoles.includes('service_role')) fails.push('bundle contains a secret/service key');
    }
  }
  const mf = await get(`${URL_}manifest.webmanifest`);
  try {
    const m = JSON.parse(mf.body);
    if (mf.status !== 200 || m.scope !== BASE_PATH || m.start_url !== BASE_PATH) fails.push(`manifest scope/start_url ${m.scope}/${m.start_url}, expected ${BASE_PATH}`);
  } catch {
    fails.push(`manifest.webmanifest: HTTP ${mf.status}, not JSON`);
  }
  const sw = await get(`${URL_}sw.js`);
  if (sw.status !== 200 || !/javascript/.test(sw.type)) fails.push(`sw.js: HTTP ${sw.status} ${sw.type}`);
  if (fails.length) return fails;

  // Real browser: the app must initialise to its login screen without script errors.
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    p.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
    p.on('response', (r) => {
      if (r.status() >= 400 && r.url().startsWith(new URL(URL_).origin)) errors.push(`HTTP ${r.status()}: ${r.url()}`);
    });
    await p.goto(URL_, { waitUntil: 'load' });
    const ok = await p.locator('input[type=email]').waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (!ok) fails.push(`login screen did not render (body text: "${(await p.locator('body').innerText()).slice(0, 80)}")`);
    fails.push(...errors);
  } finally {
    await browser.close();
  }
  return fails;
}

const deadline = Date.now() + WAIT * 1000;
let fails: string[];
for (;;) {
  fails = await checkOnce().catch((e) => [`smoke error: ${(e as Error).message}`]);
  if (!fails.length || Date.now() >= deadline) break;
  console.log(`not ready (${fails[0]}) — retrying…`);
  await new Promise((r) => setTimeout(r, 10000));
}
if (!fails.length && WAIT) {
  // Another publisher (e.g. the legacy branch build) can land just after ours: confirm it is stable.
  await new Promise((r) => setTimeout(r, 45000));
  fails = await checkOnce().catch((e) => [`smoke error: ${(e as Error).message}`]);
}
if (fails.length) {
  console.error(`SMOKE FAIL ${URL_}\n - ${fails.join('\n - ')}`);
  process.exit(1);
}
console.log(`SMOKE OK ${URL_}`);
