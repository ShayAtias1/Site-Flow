import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import type { ProjectModel } from '../../shared/projectModel';
import { NO_TOUR, selectFindings } from '../../shared/reportFilter';
import {
  ALL_STATUSES,
  DEFAULT_TITLE,
  STATUS_LABEL,
  type FindingStatus,
  type IssuedReport,
  type ReportFormat,
  type ReportGrouping,
  type ReportOptions,
  type ReportScope,
} from '../../shared/types';
import { postJson } from '../api';
import { supabase } from '../auth';
import { db, getMeta } from '../db';
import { saveFile, shareFile } from '../download';
import { useProjectModel } from '../projectData';
import {
  EMPTY_SETTINGS,
  imageToDataUri,
  loadReportSettings,
  saveReportSettings,
  type ReportSettings,
  type ReportSettingsFields,
} from '../reportSettings';
import { canWrite, type Membership } from '../setup';
import { syncNow } from '../sync';
import { useActiveTour } from '../tours';
import { Checkbox } from './Checkbox';
import { Field, Sheet } from './setup/ui';
import { tourLabel } from './Tours';

type Listed = IssuedReport & { url: string | null; path: string; scopeText: string };

interface Distribution {
  id: string;
  report_id: string;
  recipient_name: string;
  recipient_contractor_id: string | null;
  channel: 'email' | 'whatsapp' | 'print' | 'other';
  sent_at: string;
  note: string;
}

const CHANNEL_LABEL: Record<Distribution['channel'], string> = { email: 'דוא״ל', whatsapp: 'וואטסאפ', print: 'מודפס / ביד', other: 'אחר' };
const GROUPING_LABEL: Record<ReportGrouping, string> = { location: 'לפי מיקום (בניין וקומה)', contractor: 'לפי קבלן', none: 'ללא קיבוץ (לפי סדר הסיור)' };
const FORMAT_LABEL: Record<ReportFormat, string> = { table: 'דוח טבלאי מרוכז', detailed: 'פרוטוקול מפורט' };
/** A punch list shows what is still relevant; cancelled findings are left out unless chosen. */
const DEFAULT_STATUSES = ALL_STATUSES.filter((s) => s !== 'cancelled');

/** Issued reports of the project, each with a short-lived link to its PDF in the private bucket. */
async function listReports(projectId: string): Promise<Listed[]> {
  const { data, error } = await supabase
    .from('reports')
    .select('id, number, revision, supersedes_report_id, format, title, issued_at, finding_count, pdf_sha256, pdf_bytes, pdf_path, snapshot->scopeLabel')
    .eq('project_id', projectId)
    .order('issued_at', { ascending: false });
  if (error) throw new Error(error.message);
  const signed = data.length
    ? (await supabase.storage.from('reports').createSignedUrls(data.map((r) => r.pdf_path), 3600)).data ?? []
    : [];
  return data.map((r, i) => ({
    id: r.id,
    number: r.number,
    revision: r.revision,
    supersedesId: r.supersedes_report_id,
    format: r.format,
    title: r.title,
    issuedAt: r.issued_at,
    findingCount: r.finding_count,
    pdfSha256: r.pdf_sha256,
    pdfBytes: r.pdf_bytes,
    path: r.pdf_path,
    scopeText: typeof r.scopeLabel === 'string' ? r.scopeLabel : '',
    url: signed[i]?.signedUrl ?? null,
  }));
}

export function Reports() {
  const m = useProjectModel();
  if (!m) return null;
  return <ReportsFor m={m} />;
}

/** Locations in tree order, indented, for the scope picker. */
function locationOptions(m: ProjectModel) {
  const out: { id: string; label: string }[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const n of m.locations.filter((x) => x.parentId === parent)) {
      // Indented, with the full path so a chosen "קומה 2" still says which building.
      out.push({ id: n.id, label: depth ? `${'   '.repeat(depth)}${m.locationLabel(n.id)}` : n.name });
      visit(n.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

const FORMAT_HINT: Record<ReportFormat, string> = {
  table: 'טבלה מרוכזת, A4 לרוחב, ללא תמונות — לחלוקה לקבלנים ולמעקב.',
  detailed: 'כל ממצא בפירוט עם התמונות, A4 לאורך — לפרוטוקול סיור.',
};

function ReportsFor({ m }: { m: ProjectModel }) {
  const projectId = m.project.id;
  const [reports, setReports] = useState<Listed[] | null>(null);
  const [dists, setDists] = useState<Distribution[]>([]);
  const [settings, setSettings] = useState<ReportSettings | null | undefined>(undefined);
  const [editingSettings, setEditingSettings] = useState(false);
  const [format, setFormat] = useState<ReportFormat>('table');
  const [scopeKey, setScopeKey] = useState('project');
  const [contractorId, setContractorId] = useState('');
  const [statuses, setStatuses] = useState<FindingStatus[]>(DEFAULT_STATUSES);
  const [tourIds, setTourIds] = useState<string[] | null>(null);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [grouping, setGrouping] = useState<ReportGrouping>('location');
  const [headerTourId, setHeaderTourId] = useState<string | null | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedReport | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [openDist, setOpenDist] = useState<string | null>(null);
  const pending = useLiveQuery(() => db.findings.where('dirty').equals(1).count(), []);
  const pendingPhotos = useLiveQuery(() => db.photos.where('uploaded').equals(0).filter((p) => !!p.findingId).count(), []);
  const findings = useLiveQuery(() => db.findings.where('projectId').equals(projectId).toArray(), [projectId]);
  const tours = useLiveQuery(() => db.tours.where('project_id').equals(projectId).toArray(), [projectId]);
  const memberships = useLiveQuery(() => getMeta<Membership[]>('memberships'), []);
  const active = useActiveTour(projectId);
  const role = memberships?.find((x) => x.orgId === m.project.orgId)?.role;
  const readOnly = !!role && !canWrite(role);
  const locOptions = useMemo(() => locationOptions(m), [m]);
  const sortedTours = useMemo(() => [...(tours ?? [])].sort((a, b) => b.tour_date.localeCompare(a.tour_date)), [tours]);
  // The cover tour: the active one, else the latest — until the user picks another.
  const coverTour = headerTourId === undefined ? active?.id ?? sortedTours[0]?.id ?? null : headerTourId;

  const load = () =>
    Promise.all([
      listReports(projectId).then(async (r) => {
        setReports(r);
        if (r.length) {
          const { data } = await supabase.from('report_distributions').select('*').in('report_id', r.map((x) => x.id)).order('sent_at');
          setDists((data ?? []) as Distribution[]);
        }
      }),
      loadReportSettings(m.project.orgId).then(setSettings),
    ]).catch((e) => setErr(`אין חיבור לשרת: ${e.message}`));
  useEffect(() => {
    setReports(null);
    setScopeKey('project');
    setContractorId('');
    setHeaderTourId(undefined);
    // Arriving from a closed tour ("הכנת דוח לסיור"): that tour, also on the cover.
    const fromTour = sessionStorage.getItem('sf.reportTour');
    sessionStorage.removeItem('sf.reportTour');
    setTourIds(fromTour ? [fromTour] : null);
    if (fromTour) setHeaderTourId(fromTour);
    load();
  }, [projectId]);

  const scope: ReportScope = scopeKey === 'project' ? { type: 'project' } : { type: 'location', locationId: scopeKey };
  const options = (f: ReportFormat): ReportOptions => ({
    scope,
    contractorId: contractorId || null,
    statuses,
    tourIds,
    criticalOnly,
    grouping,
    title: title.trim() || DEFAULT_TITLE[f],
    notes: notes.trim(),
    headerTourId: coverTour,
  });
  const count = findings ? selectFindings(m, findings, options(format)).length : null;
  const tourName = (id: string) => (id === NO_TOUR ? 'לפני הגדרת סיורים' : sortedTours.find((t) => t.id === id) ? tourLabel(sortedTours.find((t) => t.id === id)!) : 'סיור');

  const run = async (key: string, fn: () => Promise<void>) => {
    setErr(null);
    setInfo(null);
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const issue = (f: ReportFormat, supersedes?: string) =>
    run(supersedes ? `re:${supersedes}` : 'issue', async () => {
      setIssued(null);
      // Reports are issued from the server's data, so sync first.
      const s = await syncNow();
      if (!s.ok) throw new Error(`הסנכרון נכשל, ולכן הדוח לא הופק (שום דבר לא נשמר בשרת): ${s.error}`);
      const r = await postJson<IssuedReport>(
        '/api/reports',
        supersedes ? { projectId, format: f, scope, supersedes } : { projectId, format: f, scope, options: options(f) },
        180000,
      );
      await load();
      setIssued(r);
    });

  const download = (r: Listed) =>
    run(`dl:${r.id}`, async () => {
      const { data, error } = await supabase.storage.from('reports').download(r.path);
      if (error || !data) throw new Error(`ההורדה נכשלה: ${error?.message ?? ''}`);
      saveFile(new Blob([data], { type: 'application/pdf' }), `${r.number}${r.revision ? `-rev${r.revision}` : ''}.pdf`);
    });

  const share = (r: Listed) =>
    run(`sh:${r.id}`, async () => {
      const { data, error } = await supabase.storage.from('reports').download(r.path);
      if (error || !data) throw new Error(`השיתוף נכשל: ${error?.message ?? ''}`);
      const name = `${r.number}${r.revision ? `-rev${r.revision}` : ''}.pdf`;
      if (await shareFile(new Blob([data], { type: 'application/pdf' }), name, r.title)) return;
      if (r.url && navigator.clipboard) {
        await navigator.clipboard.writeText(r.url);
        setInfo('הדפדפן לא תומך בשיתוף קבצים. הועתק קישור זמני (תקף לשעה) — אפשר גם להוריד ולצרף.');
      } else saveFile(new Blob([data], { type: 'application/pdf' }), name);
    });

  const toggleStatus = (st: FindingStatus) =>
    setStatuses(statuses.includes(st) ? statuses.filter((x) => x !== st) : ALL_STATUSES.filter((x) => x === st || statuses.includes(x)));
  const toggleTour = (id: string) => {
    const cur = tourIds ?? [];
    setTourIds(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  };
  const latestRev = new Map<string, number>();
  for (const r of reports ?? []) latestRev.set(r.number, Math.max(latestRev.get(r.number) ?? 0, r.revision));
  const issuedEntry = issued && reports?.find((r) => r.id === issued.id);
  const scopeText = scopeKey === 'project' ? 'כל הפרויקט' : m.locationLabel(scopeKey);

  return (
    <div className="reports">
      <section className="rp-form" aria-labelledby="rp-title">
        <h2 className="section-title" id="rp-title">הפקת דוח</h2>
        <div className="rp-types" role="radiogroup" aria-label="סוג הדוח">
          {(['table', 'detailed'] as ReportFormat[]).map((f) => (
            <button key={f} role="radio" aria-checked={format === f} className={`rp-type ${format === f ? 'on' : ''}`} onClick={() => setFormat(f)}>
              <b>{FORMAT_LABEL[f]}</b>
              <span>{FORMAT_HINT[f]}</span>
            </button>
          ))}
        </div>
        <div className="rp-cols">
          <label className="field">
            <span>היקף (פרויקט, בניין, קומה, דירה או אזור)</span>
            <select value={scopeKey} onChange={(e) => setScopeKey(e.target.value)}>
              <option value="project">כל הפרויקט</option>
              {locOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>קבלן</span>
            <select value={contractorId} onChange={(e) => setContractorId(e.target.value)}>
              <option value="">כל הקבלנים</option>
              {m.contractors.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="field rp-fieldset">
          <legend>סטטוסים בדוח</legend>
          <div className="rp-checks">
            {ALL_STATUSES.map((st) => (
              <Checkbox key={st} className="rp-check" checked={statuses.includes(st)} onChange={() => toggleStatus(st)} label={STATUS_LABEL[st]} />
            ))}
            <Checkbox className="rp-check rp-critical" checked={criticalOnly} onChange={setCriticalOnly} label="ליקויים קריטיים בלבד" />
          </div>
        </fieldset>
        <fieldset className="field rp-fieldset">
          <legend>אילו סיורים</legend>
          <div className="rp-checks">
            <label className="rp-check">
              <input type="radio" name="rp-tours" checked={tourIds === null} onChange={() => setTourIds(null)} />
              כל הסיורים
            </label>
            <label className="rp-check">
              <input type="radio" name="rp-tours" checked={tourIds !== null} onChange={() => setTourIds(active ? [active.id] : [])} />
              סיורים נבחרים
            </label>
          </div>
          {tourIds !== null && (
            <div className="rp-checks rp-tours">
              {sortedTours.map((t) => (
                <Checkbox key={t.id} className="rp-check" checked={tourIds.includes(t.id)} onChange={() => toggleTour(t.id)} label={tourLabel(t)} />
              ))}
              <Checkbox className="rp-check" checked={tourIds.includes(NO_TOUR)} onChange={() => toggleTour(NO_TOUR)} label="לפני הגדרת סיורים" />
            </div>
          )}
        </fieldset>
        <details className="rp-advanced">
          <summary>אפשרויות נוספות: קיבוץ, עמוד שער, כותרת והערות</summary>
          <div className="rp-cols">
            <label className="field">
              <span>קיבוץ</span>
              <select value={grouping} onChange={(e) => setGrouping(e.target.value as ReportGrouping)}>
                {Object.entries(GROUPING_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>סיור בעמוד השער (תאריך ומשתתפים)</span>
              <select value={coverTour ?? ''} onChange={(e) => setHeaderTourId(e.target.value || null)}>
                <option value="">ללא סיור</option>
                {sortedTours.map((t) => (
                  <option key={t.id} value={t.id}>{tourLabel(t)}{t.participants.length ? ` · ${t.participants.length} משתתפים` : ''}</option>
                ))}
              </select>
              <small className="hint">רק מה שמופיע בשער. אילו ממצאים נכללים — לפי "אילו סיורים" למעלה.</small>
            </label>
          </div>
          <label className="field">
            <span>כותרת הדוח</span>
            <input value={title} placeholder={DEFAULT_TITLE[format]} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span>הערות לדוח</span>
            <textarea rows={2} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </details>

        <div className="rp-summary" role="status">
          <div>
            <b>{FORMAT_LABEL[format]}</b> · {scopeText}
            {contractorId ? ` · ${m.contractorById(contractorId)?.name}` : ''}
            {tourIds ? ` · ${tourIds.length ? tourIds.map(tourName).join(', ') : 'לא נבחר סיור'}` : ''}
            {criticalOnly ? ' · קריטיים בלבד' : ''}
          </div>
          <div className={`rp-count ${count === 0 ? 'empty' : ''}`}>
            {count === null ? '' : count === 0 ? 'אין ממצאים שמתאימים להגדרות האלה' : `ייכללו כ-${count} ממצאים (הערכה לפי הנתונים במכשיר; המספר הסופי נקבע בשרת בהפקה)`}
          </div>
          {(!!pending || !!pendingPhotos) && (
            <div className="muted">
              {[pending ? `${pending} ממצאים` : '', pendingPhotos ? `${pendingPhotos} תמונות` : ''].filter(Boolean).join(' ו-')} עדיין לא סונכרנו — הם יסונכרנו לפני ההפקה.
            </div>
          )}
        </div>
        <button className="primary rp-issue" disabled={!!busy || readOnly || !statuses.length} onClick={() => issue(format)}>
          {busy === 'issue' ? 'מסנכרן ומפיק…' : 'הפק דוח'}
        </button>
        {readOnly && <div className="muted">צפייה בלבד — אין לך הרשאה להפיק דוחות בארגון הזה.</div>}
        <p className="muted rp-note">הפקה דורשת חיבור. הדוח נשמר כמסמך נעול: עריכה מאוחרת של ממצא לא משנה דוח שכבר הונפק.</p>
      </section>
      {err && <div className="alert error" role="alert">{err}</div>}
      {info && <div className="alert info" role="status">{info}</div>}
      {issued && (
        <div className="alert info rp-issued" role="status">
          <span>
            הונפק דוח <bdi dir="ltr">{issued.number}</bdi>
            {issued.revision ? ` גרסה ${issued.revision}` : ''} · {issued.findingCount} ממצאים
          </span>
          {issuedEntry && (
            <span className="actions-row">
              {issuedEntry.url && (
                <a className="btn" href={issuedEntry.url} target="_blank" rel="noreferrer">
                  פתיחה
                </a>
              )}
              <button className="btn" disabled={!!busy} onClick={() => download(issuedEntry)}>
                הורדה
              </button>
            </span>
          )}
        </div>
      )}

      <div className="rp-branding">
        <div>
          <div className="label">פרטי החברה והעורך בדוחות</div>
          {settings === undefined ? (
            <div className="muted">טוען…</div>
          ) : settings ? (
            <div className="muted">
              {settings.company_name || 'שם הארגון'} · {settings.author_name ? `${settings.author_name}${settings.author_title ? `, ${settings.author_title}` : ''}` : 'לא הוגדר עורך'}
              {settings.logo ? ' · לוגו' : ''}
              {settings.signature ? ' · חתימה' : ''}
            </div>
          ) : (
            <div className="muted">לא הוגדרו. הדוח יציג את שם הארגון, בלי עורך, לוגו או חתימה.</div>
          )}
        </div>
        {!readOnly && settings !== undefined && (
          <button className="btn" onClick={() => setEditingSettings(true)}>
            הגדרות דוח
          </button>
        )}
      </div>

      <section aria-labelledby="rp-archive">
        <h2 className="section-title" id="rp-archive">ארכיון דוחות</h2>
        {reports?.length === 0 && <div className="muted">עדיין לא הונפקו דוחות.</div>}
        {reports?.map((r) => {
          const sent = dists.filter((d) => d.report_id === r.id);
          const newer = (latestRev.get(r.number) ?? 0) > r.revision;
          return (
            <div key={r.id} className="report-entry">
              <a className="item" data-id={r.id} href={r.url ?? undefined} target="_blank" rel="noreferrer">
                <div className="item-top">
                  <b className="rp-entry-title">{r.title}</b>
                  <span className="muted">{new Date(r.issuedAt).toLocaleDateString('he-IL')}</span>
                </div>
                <div className="rp-entry-meta">
                  <bdi dir="ltr" className="rp-number">
                    {r.number}
                    {r.revision ? ` · Rev.${r.revision}` : ''}
                  </bdi>
                  <span>{FORMAT_LABEL[r.format]}</span>
                  <span>{r.findingCount} ממצאים</span>
                  {r.scopeText && <span>{r.scopeText.replace(/^היקף: /, '')}</span>}
                </div>
                <div className="item-tags">
                  {newer && <span className="tag warn">קיימת גרסה מעודכנת יותר</span>}
                  {r.revision > 0 && <span className="tag">גרסה {r.revision} — הגרסאות הקודמות נשמרו</span>}
                  {sent.length > 0 && <span className="tag ok">נרשמה הפצה ל-{sent.length}</span>}
                </div>
              </a>
              <div className="report-actions">
                <button className="btn" disabled={!!busy} onClick={() => download(r)}>
                  {busy === `dl:${r.id}` ? 'מוריד…' : 'הורדה'}
                </button>
                <button className="btn" disabled={!!busy} onClick={() => share(r)}>
                  שיתוף
                </button>
                <details className="rp-more">
                  <summary>פרטים ופעולות</summary>
                  <div className="rp-more-body">
                    <div className="muted">
                      קובץ {(r.pdfBytes / 1024).toFixed(0)} KB · טביעת SHA-256: <bdi dir="ltr">{r.pdfSha256.slice(0, 16)}…</bdi>
                    </div>
                    {!readOnly && (
                      <div className="rp-reissue">
                        <button className="btn" disabled={!!busy} onClick={() => issue(r.format, r.id)}>
                          {busy === `re:${r.id}` ? 'מפיק…' : 'גרסה מעודכנת'}
                        </button>
                        <span className="muted">אותו מספר ואותן הגדרות, עם הנתונים הנוכחיים. הגרסה הקיימת נשמרת כמו שהיא.</span>
                      </div>
                    )}
                    <button className="link" onClick={() => setOpenDist(openDist === r.id ? null : r.id)}>
                      יומן הפצה ({sent.length})
                    </button>
                  </div>
                </details>
              </div>
              {openDist === r.id && <DistributionLog m={m} report={r} entries={sent} readOnly={readOnly} onAdded={load} />}
            </div>
          );
        })}
      </section>
      {editingSettings && (
        <SettingsSheet
          orgId={m.project.orgId}
          current={settings ?? null}
          onClose={() => setEditingSettings(false)}
          onSaved={(st) => {
            setSettings(st);
            setEditingSettings(false);
          }}
        />
      )}
    </div>
  );
}

function DistributionLog({ m, report, entries, readOnly, onAdded }: { m: ProjectModel; report: Listed; entries: Distribution[]; readOnly: boolean; onAdded: () => void }) {
  const [d, setD] = useState({ recipient_name: '', recipient_contractor_id: '', channel: 'email' as Distribution['channel'], note: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setErr(null);
    setBusy(true);
    const { error } = await supabase.from('report_distributions').insert({
      org_id: m.project.orgId,
      report_id: report.id,
      recipient_name: d.recipient_name.trim(),
      recipient_contractor_id: d.recipient_contractor_id || null,
      channel: d.channel,
      note: d.note.trim(),
    });
    setBusy(false);
    if (error) return setErr(/fetch|network|Load failed/i.test(error.message) ? 'אין חיבור לשרת.' : error.message);
    setD({ recipient_name: '', recipient_contractor_id: '', channel: d.channel, note: '' });
    onAdded();
  };
  return (
    <div className="dist-log">
      <div className="muted dist-note">
        <b>רישום ידני בלבד:</b> רשום כאן למי מסרת את הדוח בעצמך. הרישום לא שולח דבר.
      </div>
      {!entries.length && <div className="muted">עדיין לא נרשמה הפצה.</div>}
      {entries.map((e) => (
        <div key={e.id} className="dist-row">
          <b>{e.recipient_name}</b>
          {e.recipient_contractor_id && <span className="muted"> · {m.contractorById(e.recipient_contractor_id)?.name ?? 'קבלן'}</span>}
          <span className="muted"> · {CHANNEL_LABEL[e.channel]} · {new Date(e.sent_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}</span>
          {e.note && <div className="muted">{e.note}</div>}
        </div>
      ))}
      {!readOnly && (
        <div className="dist-form">
          <input aria-label="שם הנמען" placeholder="שם הנמען" value={d.recipient_name} onChange={(e) => setD({ ...d, recipient_name: e.target.value })} />
          <select aria-label="קבלן הנמען" value={d.recipient_contractor_id} onChange={(e) => setD({ ...d, recipient_contractor_id: e.target.value })}>
            <option value="">לא קבלן / אחר</option>
            {m.contractors.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select aria-label="אופן ההפצה" value={d.channel} onChange={(e) => setD({ ...d, channel: e.target.value as Distribution['channel'] })}>
            {Object.entries(CHANNEL_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <input aria-label="הערת הפצה" placeholder="הערה (לא חובה)" value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} />
          <button className="btn" disabled={busy || !d.recipient_name.trim()} onClick={add}>
            רשום הפצה (בלי לשלוח)
          </button>
        </div>
      )}
      {err && <div className="alert error">{err}</div>}
    </div>
  );
}

export function SettingsSheet({ orgId, current, onClose, onSaved }: { orgId: string; current: ReportSettings | null; onClose: () => void; onSaved: (s: ReportSettings) => void }) {
  const [f, setF] = useState<ReportSettingsFields>(() => (current ? { ...EMPTY_SETTINGS, ...current } : EMPTY_SETTINGS));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ReportSettingsFields>) => setF({ ...f, ...patch });
  const image = async (file: File | undefined, key: 'logo' | 'signature') => {
    if (!file) return;
    setErr(null);
    try {
      set({ [key]: await imageToDataUri(file, key === 'logo' ? 600 : 900) });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      onSaved(await saveReportSettings(orgId, current, f));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="הגדרות דוח" onClose={onClose}
      footer={<button className="primary" disabled={busy} onClick={save}>
        {busy ? 'שומר…' : 'שמור הגדרות'}
      </button>}
    >
      <p className="muted">
        הפרטים מופיעים בכל דוח שיונפק מעכשיו בארגון. דוחות שכבר הונפקו לא משתנים. שדה ריק לא יוצג בדוח — המערכת לא משלימה פרטים, מספרי רישום או חתימות.
      </p>
      <Field label="שם החברה">
        <input value={f.company_name} maxLength={120} onChange={(e) => set({ company_name: e.target.value })} />
      </Field>
      <Field label="פרטי החברה (כתובת, טלפון, דוא״ל)">
        <textarea rows={2} value={f.company_details} maxLength={400} onChange={(e) => set({ company_details: e.target.value })} />
      </Field>
      <div className="rp-image">
        <span>לוגו</span>
        {f.logo ? <img src={f.logo} alt="לוגו" /> : <span className="muted">אין</span>}
        <label className="btn rp-pick">
          {f.logo ? 'החלפה' : 'בחירת קובץ'}
          <input type="file" accept="image/png,image/jpeg" hidden aria-label="קובץ לוגו" onChange={(e) => image(e.target.files?.[0], 'logo')} />
        </label>
        {f.logo && <button className="link" onClick={() => set({ logo: null })}>הסר</button>}
      </div>
      <div className="row2">
        <Field label="שם עורך הדוח">
          <input value={f.author_name} maxLength={80} onChange={(e) => set({ author_name: e.target.value })} />
        </Field>
        <Field label="תפקיד / תואר מקצועי">
          <input value={f.author_title} maxLength={80} placeholder="למשל: מהנדס ביצוע" onChange={(e) => set({ author_title: e.target.value })} />
        </Field>
      </div>
      <Field label="רישום מקצועי (לא חובה)" hint="כפי שמופיע אצלך, למשל מספר רישום בפנקס המהנדסים. השאר ריק אם אין.">
        <input value={f.author_registration} maxLength={80} onChange={(e) => set({ author_registration: e.target.value })} />
      </Field>
      <div className="rp-image">
        <span>חתימה</span>
        {f.signature ? <img src={f.signature} alt="חתימה" /> : <span className="muted">אין — יוצג מקום לחתימה ידנית</span>}
        <label className="btn rp-pick">
          {f.signature ? 'החלפה' : 'בחירת קובץ'}
          <input type="file" accept="image/png,image/jpeg" hidden aria-label="קובץ חתימה" onChange={(e) => image(e.target.files?.[0], 'signature')} />
        </label>
        {f.signature && <button className="link" onClick={() => set({ signature: null })}>הסר</button>}
      </div>
      {err && <div className="alert error">{err}</div>}
    </Sheet>
  );
}
