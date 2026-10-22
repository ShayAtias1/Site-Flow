// Settings: what an inspector needs — whether the work is saved and synced, the account, the company
// and author shown in reports, and backup/restore. No diagnostics or test tools (UX-11).
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { signOut, type AuthUser } from '../auth';
import { db } from '../db';
import { useProjects } from '../projectData';
import { loadReportSettings, type ReportSettings } from '../reportSettings';
import { canWrite, loadMemberships, type Membership } from '../setup';
import { deliverFile, diagnostics, exportBackup, importBackup, isIOS, isStandalone, type Diagnostics } from '../storage';
import { onSyncState, syncNow, type SyncOutcome } from '../sync';
import { SettingsSheet } from './Reports';

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const when = (iso: string) => new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });

export function System({ user, offline }: { user: AuthUser; offline: boolean }) {
  const [d, setD] = useState<Diagnostics | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [sync, setSync] = useState<{ running: boolean; last?: SyncOutcome }>({ running: false });
  const [online, setOnline] = useState(navigator.onLine);
  const [members, setMembers] = useState<Membership[] | null>(null);
  const [identity, setIdentity] = useState<ReportSettings | null | undefined>(undefined);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const projects = useProjects();
  const orgId = projects?.current?.org_id;
  // Live counts, so the status follows saves and syncs while the screen is open.
  const pending = useLiveQuery(async () => ({
    findings: await db.findings.where('dirty').equals(1).count(),
    photos: await db.photos.where('uploaded').equals(0).filter((p) => !!p.findingId).count(),
    tours: await db.tours.where('dirty').equals(1).count(),
    conflicts: await db.findings.filter((f) => !!f.conflict).count(),
    rejected: await db.findings.filter((f) => !!f.syncError).count(),
  }), []);
  const say = (s: string) => setLog((l) => [`${new Date().toLocaleTimeString('he-IL', { timeStyle: 'short' })}  ${s}`, ...l].slice(0, 8));
  const refresh = () => diagnostics().then(setD);

  useEffect(() => {
    refresh();
    const unsub = onSyncState((st) => {
      setSync(st);
      if (!st.running) refresh();
    });
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    loadMemberships().then(setMembers, () => setMembers([]));
    return () => {
      unsub();
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  useEffect(() => {
    if (orgId) loadReportSettings(orgId).then(setIdentity, () => setIdentity(undefined));
  }, [orgId]);

  if (!d || !pending) return <div className="settings-screen muted">טוען…</div>;
  const waiting = pending.findings + pending.photos + pending.tours;
  const role = members?.find((m) => m.orgId === orgId)?.role;
  const lastFailed = sync.last && !sync.last.ok && online;
  const status = sync.running
    ? { cls: 'syncing', text: 'מסנכרן עכשיו…' }
    : pending.conflicts
      ? { cls: 'bad', text: `${pending.conflicts} ממצאים בהתנגשות — פתח אותם בלשונית "ממצאים" ובחר מה לשמור.` }
      : waiting && !online
        ? { cls: 'pending', text: `אין חיבור. ${waiting} פריטים נשמרו במכשיר וישלחו לשרת כשיחזור חיבור.` }
        : waiting
          ? { cls: 'pending', text: `${waiting} פריטים נשמרו במכשיר וממתינים לשליחה לשרת.` }
          : lastFailed
            ? { cls: 'bad', text: `הסנכרון האחרון לא הצליח. הנתונים שמורים במכשיר; נסה שוב.` }
            : { cls: 'ok', text: 'הכול נשמר וסונכרן לשרת ✓' };
  const storageTight = d.usage !== null && d.quota !== null && d.quota > 0 && d.usage / d.quota > 0.8;

  return (
    <div className="settings-screen">
      <section className="card set-card" aria-labelledby="set-sync">
        <h2 className="section-title" id="set-sync">שמירה וסנכרון</h2>
        <p className={`set-status ${status.cls}`} role="status">{status.text}</p>
        <ul className="set-facts">
          {pending.findings > 0 && <li>{pending.findings} ממצאים ממתינים לשליחה</li>}
          {pending.photos > 0 && <li>{pending.photos} תמונות ממתינות להעלאה</li>}
          {pending.tours > 0 && <li>{pending.tours} סיורים ממתינים לשליחה</li>}
          {pending.rejected > 0 && <li>{pending.rejected} ממצאים נדחו בשרת — הם מסומנים ברשימת הממצאים</li>}
          <li>סנכרון אחרון: {d.lastSyncAt ? when(d.lastSyncAt) : 'עדיין לא'}</li>
        </ul>
        <p className="muted">"נשמר במכשיר" — אפשר להמשיך לעבוד בלי קליטה. הנתונים ממתינים לסנכרון. "סונכרן" — נשמר גם בשרת.</p>
        {storageTight && <div className="alert warn">האחסון במכשיר כמעט מלא ({mb(d.usage!)}). סנכרן וגבה את הנתונים.</div>}
        <div className="actions-row">
          <button
            className="btn primary-solid"
            disabled={sync.running}
            onClick={async () => {
              const r = await syncNow();
              say(
                r.ok
                  ? `סונכרן: נשלחו ${r.pushed}, התקבלו ${r.pulled}${r.photos ? `, הועלו ${r.photos} תמונות` : ''}${r.conflicts ? ` · ${r.conflicts} התנגשויות` : ''}`
                  : `סנכרון נכשל: ${r.error}`,
              );
              refresh();
            }}
          >
            סנכרן עכשיו
          </button>
        </div>
        {log.length > 0 && (
          <div className="log" aria-live="polite">
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
      </section>

      <section className="card set-card" aria-labelledby="set-account">
        <h2 className="section-title" id="set-account">חשבון</h2>
        <p>
          מחובר כ-<bdi dir="ltr">{user.email}</bdi>
          {offline ? ' (ללא חיבור — הכניסה תאומת כשיחזור חיבור)' : ''}
        </p>
        <div className="actions-row">
          <button
            className="btn"
            onClick={async () => {
              const err = await signOut();
              if (err) say(`יציאה נחסמה: ${err}`);
            }}
          >
            יציאה מהחשבון
          </button>
        </div>
      </section>

      <section className="card set-card" aria-labelledby="set-identity">
        <h2 className="section-title" id="set-identity">החברה והעורך בדוחות</h2>
        {!orgId ? (
          <p className="muted">יוצג אחרי שייבחר פרויקט.</p>
        ) : identity === undefined ? (
          <p className="muted">{online ? 'טוען…' : 'זמין כשיש חיבור.'}</p>
        ) : identity ? (
          <p>
            {identity.company_name || 'שם הארגון'} · {identity.author_name ? `${identity.author_name}${identity.author_title ? `, ${identity.author_title}` : ''}` : 'לא הוגדר עורך'}
            {identity.logo ? ' · לוגו' : ''}
            {identity.signature ? ' · חתימה' : ''}
          </p>
        ) : (
          <p className="muted">לא הוגדרו. הדוחות יציגו את שם הארגון בלבד, בלי עורך, לוגו או חתימה.</p>
        )}
        <p className="muted">פרטי החברה והעורך משותפים לכל הפרויקטים בארגון. מבנה וקבלנים מנוהלים לכל פרויקט. ספריית הקטגוריות והביטויים משותפת לארגון; קבלן ברירת המחדל מוגדר לכל פרויקט.</p>
        {orgId && identity !== undefined && canWrite(role) && (
          <div className="actions-row">
            <button className="btn" onClick={() => setEditingIdentity(true)}>
              עריכת פרטי החברה והעורך
            </button>
          </div>
        )}
      </section>

      <section className="card set-card" aria-labelledby="set-backup">
        <h2 className="section-title" id="set-backup">גיבוי ושחזור</h2>
        <p className="muted">קובץ גיבוי שומר את כל מה שבמכשיר, גם מה שעוד לא סונכרן. שחזור מוסיף רק מה שחסר — לא מוחק ולא דורס דבר.</p>
        <div className="actions-row">
          <button
            className="btn"
            onClick={async () => {
              const f = await exportBackup();
              const how = await deliverFile(f);
              say(`גיבוי ${f.name} (${mb(f.size)}): ${how === 'shared' ? 'שותף' : how === 'downloaded' ? 'נשמר' : 'בוטל'}`);
            }}
          >
            ייצוא גיבוי
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            שחזור מגיבוי
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const r = await importBackup(f);
                say(`שחזור: נוספו ${r.added}, עודכנו ${r.updated}, דולגו ${r.skipped}, תמונות ${r.photosAdded}`);
              } catch (err) {
                say(`שחזור נכשל: ${(err as Error).message}`);
              }
              e.target.value = '';
              refresh();
            }}
          />
        </div>
      </section>

      {!isStandalone() && isIOS() && (
        <section className="card set-card" aria-labelledby="set-install">
          <h2 className="section-title" id="set-install">התקנה באייפון</h2>
          <p>שתף ← "הוסף למסך הבית", ופתח את SiteFlow רק מהאייקון. הנתונים בספארי ובאפליקציה המותקנת נפרדים.</p>
        </section>
      )}
      <p className="muted app-version">גרסת האפליקציה: {new Date(__APP_BUILD__).toLocaleString('he-IL')}</p>
      {editingIdentity && orgId && (
        <SettingsSheet
          orgId={orgId}
          current={identity ?? null}
          onClose={() => setEditingIdentity(false)}
          onSaved={(s) => {
            setIdentity(s);
            setEditingIdentity(false);
          }}
        />
      )}
    </div>
  );
}
