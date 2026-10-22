import { db, getMeta, setMeta, type EventRow, type LocalFinding, type LocalPhoto, type TourRow } from './db';

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const LS_INSTALL = 'sf.installId';
const LS_COUNT = 'sf.knownFindings';

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore — localStorage is only a secondary witness */
    }
  },
};

export type IntegrityState = 'ok' | 'first-run' | 'idb-wiped' | 'ls-wiped';

/**
 * Detects storage that was wiped behind our back. An install id lives in both IndexedDB
 * and localStorage; if one disappears while the other remains, one store was evicted.
 * A drop of the finding count to zero is reported as well.
 */
export async function checkIntegrity(): Promise<{ state: IntegrityState; knownCount: number; actualCount: number }> {
  const idbId = await getMeta<string>('installId');
  const lsId = ls.get(LS_INSTALL);
  const knownCount = Number(ls.get(LS_COUNT) ?? 0);
  const actualCount = await db.findings.count();
  let state: IntegrityState = 'ok';
  if (!idbId && !lsId) {
    const id = crypto.randomUUID();
    await setMeta('installId', id);
    ls.set(LS_INSTALL, id);
    state = 'first-run';
  } else if (!idbId && lsId) state = 'idb-wiped';
  else if (idbId && !lsId) {
    ls.set(LS_INSTALL, idbId);
    state = 'ls-wiped';
  } else if (knownCount > 0 && actualCount === 0) state = 'idb-wiped';
  return { state, knownCount, actualCount };
}

export async function noteFindingCount() {
  ls.set(LS_COUNT, String(await db.findings.count()));
}

/** Writes and reads back 1 MB, to prove the store accepts writes right now. */
export async function probeWrite(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = performance.now();
  try {
    const buf = new Uint8Array(1024 * 1024);
    crypto.getRandomValues(buf.subarray(0, 65536));
    await setMeta('probe', buf.buffer);
    const back = await getMeta<ArrayBuffer>('probe');
    await db.meta.delete('probe');
    const ok = !!back && back.byteLength === buf.byteLength && new Uint8Array(back)[100] === buf[100];
    return { ok, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: `${(e as Error).name}: ${(e as Error).message}` };
  }
}

export async function requestPersist(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  return navigator.storage.persist();
}

export interface Diagnostics {
  standalone: boolean;
  ios: boolean;
  userAgent: string;
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
  findings: number;
  pendingFindings: number;
  conflicts: number;
  photos: number;
  pendingPhotos: number;
  localPhotoBytes: number;
  lastSyncAt: string | null;
  swControlled: boolean;
  online: boolean;
}

export async function diagnostics(): Promise<Diagnostics> {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const all = await db.findings.toArray();
  const photos = await db.photos.toArray();
  return {
    standalone: isStandalone(),
    ios: isIOS(),
    userAgent: navigator.userAgent,
    persisted: navigator.storage?.persisted ? await navigator.storage.persisted() : null,
    usage: est?.usage ?? null,
    quota: est?.quota ?? null,
    findings: all.length,
    pendingFindings: all.filter((f) => f.dirty).length,
    conflicts: all.filter((f) => f.conflict).length,
    photos: photos.length,
    pendingPhotos: photos.filter((p) => !p.uploaded && p.findingId).length,
    localPhotoBytes: photos.reduce((s, p) => s + p.size + p.thumb.byteLength, 0),
    lastSyncAt: (await getMeta<string>('lastSyncAt')) ?? null,
    swControlled: !!navigator.serviceWorker?.controller,
    online: navigator.onLine,
  };
}

// ---------- Backup / restore ----------

const toB64 = (buf: ArrayBuffer) => {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

interface BackupFile {
  format: 'siteflow-backup';
  version: 1;
  exportedAt: string;
  installId: string | null;
  findings: LocalFinding[];
  photos: (Omit<LocalPhoto, 'bytes' | 'thumb'> & { bytes: string; thumb: string })[];
  /** M4: tours and finding history (absent in older backups). */
  tours?: TourRow[];
  events?: EventRow[];
}

export async function exportBackup(): Promise<File> {
  const findings = await db.findings.toArray();
  const photos = (await db.photos.toArray()).map((p) => ({ ...p, bytes: toB64(p.bytes), thumb: toB64(p.thumb) }));
  const data: BackupFile = {
    format: 'siteflow-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    installId: (await getMeta<string>('installId')) ?? null,
    findings,
    photos,
    tours: await db.tours.toArray(),
    events: await db.events.toArray(),
  };
  const stamp = data.exportedAt.slice(0, 16).replace(/[-:T]/g, '');
  return new File([JSON.stringify(data)], `siteflow-backup-${stamp}.json`, { type: 'application/json' });
}

/** Shares the file (iOS: "Save to Files") or falls back to a download link. */
export async function deliverFile(file: File) {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

/**
 * Restores a backup without ever overwriting newer or unsynced local work:
 * missing records are added; an existing record is replaced only if it is clean
 * and the backup holds a newer server version.
 */
export async function importBackup(file: File) {
  const data = JSON.parse(await file.text()) as BackupFile;
  if (data.format !== 'siteflow-backup') throw new Error('הקובץ אינו גיבוי של SiteFlow');
  const r = { added: 0, updated: 0, skipped: 0, photosAdded: 0 };
  await db.transaction('rw', [db.findings, db.photos, db.tours, db.events], async () => {
    // Tours and history the device no longer has come back; nothing on the device is replaced.
    for (const t of data.tours ?? []) if (!(await db.tours.get(t.id))) await db.tours.add(t);
    for (const e of data.events ?? []) if (!(await db.events.get(e.id))) await db.events.add(e);
    for (const f of data.findings) {
      const cur = await db.findings.get(f.id);
      if (!cur) {
        await db.findings.add(f);
        r.added++;
      } else if (!cur.dirty && f.version > cur.version) {
        await db.findings.put(f);
        r.updated++;
      } else r.skipped++;
    }
    for (const p of data.photos) {
      if (await db.photos.get(p.id)) continue;
      await db.photos.add({ ...p, bytes: fromB64(p.bytes), thumb: fromB64(p.thumb) });
      r.photosAdded++;
    }
  });
  await noteFindingCount();
  return r;
}
