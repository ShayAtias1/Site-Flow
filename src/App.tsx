import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { initAuth, onAuthState, type AuthState, type AuthUser } from './auth';
import { db, getMeta } from './db';
import { Login } from './screens/Login';
import { HeaderProject, ProjectBar } from './screens/ProjectBar';
import { Icon, type IconName } from './icons';
import { Capture } from './screens/Capture';
import { Findings } from './screens/Findings';
import { Reports } from './screens/Reports';
import { Setup } from './screens/setup/Setup';
import { System } from './screens/System';
import { checkIntegrity, isIOS, isStandalone, requestPersist, type IntegrityState } from './storage';
import { onSyncState, startAutoSync, type SyncOutcome } from './sync';

export type SetupView = 'home' | 'manage';
type Tab = 'capture' | 'findings' | 'reports' | 'setup' | 'system';
const TABS: [Tab, string][] = [
  ['capture', 'תיעוד'],
  ['findings', 'ממצאים'],
  ['reports', 'דוחות'],
  ['setup', 'פרויקטים'],
  ['system', 'הגדרות'],
];

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : `${n} ${many}`;
}

export function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });
  useEffect(() => {
    const unsub = onAuthState(setAuth);
    initAuth();
    return () => {
      unsub();
    };
  }, []);
  if (auth.kind === 'loading') return null;
  if (auth.kind === 'signed-out') return <Login state={auth} />;
  return <Shell user={auth.user} offline={auth.offline} />;
}

function Shell({ user, offline }: { user: AuthUser; offline: boolean }) {
  const firstTab = sessionStorage.getItem('sf.tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(() => firstTab || 'capture');
  // "פרויקטים": the list of projects, or one project's management. The main tab always lands on the list.
  const [setupView, setSetupView] = useState<SetupView>(() => (sessionStorage.getItem('sf.setupView') as SetupView) || 'home');
  const [online, setOnline] = useState(navigator.onLine);
  const [sync, setSync] = useState<{ running: boolean; last?: SyncOutcome }>({ running: false });
  const [integrity, setIntegrity] = useState<IntegrityState>('ok');
  const pending = useLiveQuery(() => db.findings.where('dirty').equals(1).count(), [], 0);
  const pendingTours = useLiveQuery(() => db.tours.where('dirty').equals(1).count(), [], 0);
  const pendingPhotos = useLiveQuery(() => db.photos.where('uploaded').equals(0).filter((p) => !!p.findingId).count(), [], 0);
  const conflicts = useLiveQuery(() => db.findings.filter((f) => !!f.conflict).count(), [], 0);
  const blocked = useLiveQuery(() => db.findings.filter((f) => !!f.syncError?.blocked).count(), [], 0);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    sessionStorage.setItem('sf.tab', tab);
  }, [tab]);
  useEffect(() => {
    sessionStorage.setItem('sf.setupView', setupView);
  }, [setupView]);

  // No project chosen yet on this device and several to choose from: start at "הפרויקטים שלי" (once,
  // also when the projects arrive with the first sync).
  const choice = useLiveQuery(async () => ({
    chosen: await getMeta<string>('currentProjectId'),
    active: (await db.projects.toArray()).filter((p) => !p.deleted_at && p.status === 'active').length,
  }), []);
  const decided = useRef(!!firstTab);
  useEffect(() => {
    if (decided.current || !choice) return;
    if (choice.chosen || choice.active > 1) decided.current = true;
    if (!choice.chosen && choice.active > 1) {
      setSetupView('home');
      setTab('setup');
    }
  }, [choice]);

  // Screens ask to move elsewhere (e.g. "show this tour's findings") through this event.
  const [navKey, setNavKey] = useState(0);
  useEffect(() => {
    const go = (e: Event) => {
      const to = (e as CustomEvent<{ tab: Tab }>).detail;
      if (to.tab === 'setup') setSetupView('home');
      setTab(to.tab);
      setNavKey((k) => k + 1);
    };
    window.addEventListener('sf:navigate', go);
    return () => window.removeEventListener('sf:navigate', go);
  }, []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    checkIntegrity().then((r) => setIntegrity(r.state));
    requestPersist();
    startAutoSync();
    const unsub = onSyncState(setSync);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      unsub();
    };
  }, []);

  const waiting = pending + pendingPhotos + pendingTours;
  const syncFailed = !!sync.last && !sync.last.ok && online;
  const waitingText = [
    pending ? plural(pending, 'ממצא אחד', 'ממצאים') : '',
    pendingPhotos ? plural(pendingPhotos, 'תמונה אחת', 'תמונות') : '',
    pendingTours ? plural(pendingTours, 'סיור אחד', 'סיורים') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const syncState: { cls: string; icon?: IconName; body: ReactNode } = sync.running
    ? { cls: 'syncing', icon: 'syncing', body: 'מסנכרן…' }
    : waiting
      ? {
          cls: 'pending',
          icon: online ? undefined : 'device',
          body: (
            <>
              {!online && 'נשמר במכשיר · '}
              <b>ממתינים: {waitingText}</b>
            </>
          ),
        }
      : syncFailed
        ? { cls: 'error', body: 'שגיאת סנכרון' }
        : { cls: 'ok', icon: 'check', body: tab === 'capture' ? <span className="sr-only">מסונכרן</span> : 'מסונכרן' };

  const alerts = (
    <>
      {integrity === 'idb-wiped' && (
        <div className="alert error">
          נתוני המכשיר נמחקו (ככל הנראה על ידי מערכת ההפעלה). נתונים שסונכרנו ישוחזרו מהשרת; אם יש קובץ גיבוי — שחזר ממנו במסך מערכת.
        </div>
      )}
      {!isStandalone() && isIOS() && (
        <div className="alert warn">
          לעבודה בשטח: שתף ← "הוסף למסך הבית", ופתח את SiteFlow רק מהאייקון. הנתונים בספארי ובאפליקציה המותקנת נפרדים.
        </div>
      )}
      {offline && (
        <div className="alert info">עובד ללא חיבור כ-{user.email}. הכניסה תאומת כשיחזור חיבור; כל מה שנשמר נשאר במכשיר.</div>
      )}
      {!!conflicts && (
        <button className="alert error" onClick={() => setTab('findings')}>
          {conflicts} ממצאים בהתנגשות — נדרשת החלטה
        </button>
      )}
      {!!blocked && (
        <button className="alert error" onClick={() => setTab('findings')}>
          {blocked} ממצאים נדחו בסנכרון ולא יישלחו שוב עד שתערוך אותם
        </button>
      )}
      {syncFailed && sync.last && <div className="alert warn">הסנכרון האחרון נכשל: {sync.last.error}</div>}
      {needRefresh && (
        <div className="alert info">
          גרסה חדשה זמינה. הנתונים נשמרים בעדכון.
          <button className="link" onClick={() => updateServiceWorker(true)}>עדכן עכשיו</button>
        </div>
      )}
    </>
  );

  return (
    <div className={`app ${tab === 'capture' ? 'on-capture' : ''} ${tab === 'setup' || tab === 'findings' || tab === 'reports' ? 'wide' : ''} ${tab === 'findings' ? 'full' : ''}`}>
      <header className="status">
        <span className={`net ${online ? 'on' : 'off'}`}>
          <span className="dot" aria-hidden="true" />
          <span className={tab === 'capture' ? 'sr-only' : undefined}>{online ? 'מחובר' : 'ללא חיבור'}</span>
        </span>
        {tab === 'capture' && <HeaderProject />}
        <button className={`sync ${syncState.cls}`} title="מצב השמירה והסנכרון בהגדרות" onClick={() => setTab('system')}>
          {syncState.icon && <Icon name={syncState.icon} size={15} strokeWidth={2.4} />}
          <span>{syncState.body}</span>
        </button>
      </header>
      <main>
        {tab === 'system' && <h1 className="sr-only">הגדרות</h1>}
        {tab === 'setup' && setupView === 'home' && <h1 className="sr-only">פרויקטים</h1>}
        {tab === 'capture' && <h1 className="sr-only">תיעוד</h1>}
        {tab !== 'system' && tab !== 'capture' && !(tab === 'setup' && setupView === 'home') && (
          <ProjectBar
            screen={TABS.find(([k]) => k === tab)![1]}
            showAll={tab !== 'setup'}
            showTour
            onTours={() => {
              sessionStorage.setItem('sf.findingsView', 'tours');
              if (tab === 'findings') window.dispatchEvent(new Event('sf:show-tours'));
              setTab('findings');
            }}
          />
        )}
        {tab !== 'capture' && alerts}
        {tab === 'capture' && (
          <Capture
            alerts={alerts}
            onTours={() => {
              sessionStorage.setItem('sf.findingsView', 'tours');
              setTab('findings');
            }}
            onFindings={() => {
              sessionStorage.setItem('sf.findingsView', 'findings');
              setTab('findings');
            }}
          />
        )}
        {tab === 'findings' && <Findings key={navKey} />}
        {tab === 'reports' && <Reports key={navKey} />}
        {tab === 'setup' && <Setup key={navKey} view={setupView} onView={setSetupView} onOpenProject={() => setTab('capture')} />}
        {tab === 'system' && <System user={user} offline={offline} />}
      </main>
      <nav className="tabs" aria-label="ניווט ראשי">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => {
              if (k === 'setup') setSetupView('home');
              setTab(k);
            }}
          >
            <span className="tab-icon">
              <Icon name={k} size={25} strokeWidth={tab === k ? 2.3 : 2} />
              {k === 'findings' && !!conflicts && (
                <span className="badge" aria-label={`${conflicts} התנגשויות`}>{conflicts}</span>
              )}
            </span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
