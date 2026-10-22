// SiteFlow server: serves the PWA and issues PDF reports. Data and sync live in Supabase (since M2).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueReport, ReportError, userClient, type IssueRequest } from './report/issue';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = resolve(process.env.SITEFLOW_DIST ?? join(ROOT, 'dist'));
const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.SITEFLOW_TOKEN ?? '';

/** Supabase project: SITEFLOW_SUPABASE_URL/KEY, else the app's own .env.local. Only the public key is used. */
function supabaseConfig() {
  let url = process.env.SITEFLOW_SUPABASE_URL ?? '';
  let key = process.env.SITEFLOW_SUPABASE_KEY ?? '';
  const envFile = join(ROOT, '.env.local');
  if ((!url || !key) && existsSync(envFile)) {
    const env = Object.fromEntries(
      readFileSync(envFile, 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
    url ||= env.VITE_SUPABASE_URL ?? '';
    key ||= env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';
  }
  return { url, key };
}
const SUPABASE = supabaseConfig();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const readJson = async <T>(req: IncomingMessage) => JSON.parse((await readBody(req)).toString('utf8')) as T;

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (!existsSync(DIST)) return send(res, 503, { error: 'app not built — run npm run build' });
  let file = normalize(join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST)) return send(res, 403, { error: 'forbidden' });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  const name = file.slice(DIST.length);
  // The service worker and the HTML shell must always be revalidated so updates are noticed.
  const noCache = name === '/index.html' || name === '/sw.js' || name.endsWith('.webmanifest');
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': noCache ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(readFileSync(file));
}

// Test-only: devices marked offline get their connection dropped, like a phone with no signal.
// (Playwright cannot emulate offline for a service-worker page in WebKit.) In test builds the app
// reaches Supabase through /sb on this server, so the same switch covers its Supabase traffic.
const TEST_MODE = process.env.SITEFLOW_TEST === '1';
// 'all': no connection at all. 'data': sign-in (Supabase auth) works, data and reports don't.
const offlineDevices = new Map<string, 'all' | 'data'>();
const isOffline = (req: IncomingMessage, path: string) => {
  const mode = offlineDevices.get(req.headers['x-siteflow-device'] as string);
  return mode === 'all' || (mode === 'data' && !path.startsWith('/sb/auth/'));
};

async function proxySupabase(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (isOffline(req, url.pathname)) return req.socket.destroy();
  const upstream = `${SUPABASE.url}${url.pathname.slice(3)}${url.search}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v && !['host', 'connection', 'content-length'].includes(k)) headers.set(k, String(v));
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req, 60 * 1024 * 1024);
  let r: Response;
  try {
    r = await fetch(upstream, { method: req.method, headers, body: body ? new Uint8Array(body) : undefined, redirect: 'manual' });
  } catch {
    return req.socket.destroy(); // upstream unreachable: the client sees a network error
  }
  const out: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v;
  });
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (TEST_MODE) {
    if (url.pathname === '/api/__test/offline' && req.method === 'POST') {
      const { device, offline } = await readJson<{ device: string; offline: boolean | 'data' }>(req);
      if (offline) offlineDevices.set(device, offline === 'data' ? 'data' : 'all');
      else offlineDevices.delete(device);
      return send(res, 200, { ok: true });
    }
    if (isOffline(req, url.pathname)) return req.socket.destroy();
  }
  if (TOKEN && req.headers['x-siteflow-token'] !== TOKEN && url.searchParams.get('t') !== TOKEN)
    return send(res, 401, { error: 'unauthorized' });

  if (url.pathname === '/api/health') return send(res, 200, { ok: true, time: new Date().toISOString() });

  if (url.pathname === '/api/reports' && req.method === 'POST') {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!bearer) return send(res, 401, { error: 'sign in required' });
    if (!SUPABASE.url || !SUPABASE.key) return send(res, 503, { error: 'Supabase is not configured on the server' });
    const body = await readJson<IssueRequest>(req);
    try {
      return send(res, 200, await issueReport(userClient(SUPABASE.url, SUPABASE.key, bearer), body));
    } catch (e) {
      if (e instanceof ReportError) return send(res, e.status, { error: e.message });
      throw e;
    }
  }
  return send(res, 404, { error: 'unknown endpoint' });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  try {
    if (TEST_MODE && url.pathname.startsWith('/sb/')) await proxySupabase(req, res, url);
    else if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    const err = e as Error & { status?: number };
    console.error(err);
    if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`SiteFlow server on http://localhost:${PORT}`));
