import {
  CLASSIFICATION_LABEL,
  STATUS_LABEL,
  type Classification,
  type ReportFindingRow,
  type ReportSnapshot,
} from '../../shared/types';

export interface RenderInput {
  snapshot: ReportSnapshot;
  /** photo id → data URI, already resized for print. */
  photos: Map<string, string>;
  /** @font-face rules with embedded fonts. */
  fontCss: string;
}

export interface RenderedReport {
  html: string;
  headerTemplate: string;
  footerTemplate: string;
  landscape: boolean;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Isolate left-to-right tokens (codes, numbers) so they never reorder Hebrew around them. */
const ltr = (s: string | number) => `<bdi dir="ltr">${esc(String(s))}</bdi>`;


const formatDate = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
};

const CLASS_ORDER: Classification[] = ['critical', 'defective', 'missing'];

function baseCss(fontCss: string, landscape: boolean) {
  return `
${fontCss}
@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; }
* { box-sizing: border-box; }
html { direction: rtl; }
body { margin: 0; font-family: 'Heebo', sans-serif; font-size: 10pt; color: #1b2430; line-height: 1.45;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-size: 18pt; margin: 0 0 2mm; font-weight: 700; color: #0f2a44; }
h2 { font-size: 12pt; margin: 6mm 0 2mm; font-weight: 700; color: #0f2a44; break-after: avoid; }
.doc-kind { font-size: 10pt; color: #5b6b7c; margin-bottom: 4mm; }
.meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.5mm 6mm; border: 0.3mm solid #c9d3de;
  border-radius: 2mm; padding: 3mm 4mm; background: #f6f8fb; }
.meta div { font-size: 9pt; } .meta b { display: block; font-size: 8pt; color: #5b6b7c; font-weight: 400; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 0.25mm solid #c9d3de; padding: 1.4mm 2mm; text-align: right; vertical-align: top; overflow-wrap: anywhere; }
thead { display: table-header-group; }
thead th { background: #0f2a44; color: #fff; font-weight: 700; font-size: 8.5pt; }
tr { break-inside: avoid; }
tbody tr:nth-child(even) td { background: #f8fafc; }
td.num, th.num { text-align: center; white-space: nowrap; }
table.findings td { font-size: 8.5pt; padding: 1mm 1.6mm; line-height: 1.35; }
table.findings td:nth-child(7), table.findings td:nth-child(8) { white-space: nowrap; }
.code { color: #5b6b7c; font-size: 7.5pt; white-space: nowrap; }
.badge { display: inline-block; padding: 0.3mm 2mm; border-radius: 3mm; font-size: 8pt; white-space: nowrap; }
.b-critical { background: #fde2e1; color: #a1150f; font-weight: 700; }
.b-defective { background: #fff1d6; color: #8a5200; }
.b-missing { background: #e6eef7; color: #1f4b7a; }
tr.row-critical td { background: #fff5f4 !important; }
.critical-box { border: 0.5mm solid #c62828; border-radius: 2mm; padding: 2mm 3mm; margin-top: 3mm; break-inside: avoid; }
.critical-box h2 { color: #a1150f; margin-top: 0; }
.participants { font-size: 9pt; }
.signature { margin-top: 8mm; display: flex; gap: 10mm; align-items: flex-end; break-inside: avoid; }
.signature .sig-block { border-top: 0.3mm solid #1b2430; padding-top: 1.5mm; min-width: 60mm; font-size: 9pt; }
.signature img { height: 16mm; display: block; margin-bottom: 1mm; }
.disclaimer { margin-top: 6mm; padding: 2.5mm 3.5mm; border: 0.3mm solid #c9d3de; border-radius: 2mm;
  font-size: 8.5pt; color: #3b4a5a; background: #f6f8fb; break-inside: avoid; }
.page-break { break-before: page; }
tr.group td { background: #e3eaf3 !important; font-weight: 700; color: #0f2a44; font-size: 9pt; padding: 1.4mm 2mm; }
tr.group { break-after: avoid; }
h3.group-h { font-size: 11pt; margin: 5mm 0 2mm; padding: 1.5mm 3mm; background: #e3eaf3; color: #0f2a44; border-radius: 1.5mm; break-after: avoid; }
.notes { margin-top: 3mm; padding: 2.5mm 3.5mm; border: 0.3mm solid #c9d3de; border-radius: 2mm; font-size: 9.5pt; white-space: pre-wrap; break-inside: avoid; }
.filters { font-size: 9pt; color: #3b4a5a; margin: -2mm 0 4mm; }
.sig-blank { height: 16mm; }
/* detailed format */
/* No outer box: a box split across pages would draw its side borders down the empty page. */
.finding { border-bottom: 0.3mm solid #c9d3de; margin-bottom: 4mm; }
.finding.compact { break-inside: avoid; }
.f-head { border-radius: 1.5mm; }
.finding.critical .f-head { box-shadow: inset -1.6mm 0 0 #c62828; }
.f-text { break-inside: avoid; break-after: avoid; }
.f-head { display: flex; gap: 3mm; align-items: center; background: #eef2f7; padding: 2mm 3mm; }
.finding.critical .f-head { background: #fde2e1; }
.f-head .no { font-weight: 700; font-size: 11pt; color: #0f2a44; }
.f-head .loc { font-weight: 700; flex: 1; }
.f-meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1mm 4mm; padding: 2mm 3mm 0; font-size: 9pt; }
.f-meta b { display: block; font-size: 7.5pt; color: #5b6b7c; font-weight: 400; }
.f-desc { padding: 2mm 3mm 3mm; font-size: 10pt; white-space: pre-wrap; overflow-wrap: anywhere; }
.photo-row { display: flex; gap: 3mm; padding: 0 3mm 3mm; break-inside: avoid; }
.photo { flex: 1 1 0; max-width: calc(50% - 1.5mm); text-align: center; }
.photo img { width: 100%; height: 58mm; object-fit: contain; background: #f1f4f8; border: 0.25mm solid #d8e0e8; border-radius: 1mm; }
.photo .cap { font-size: 7.5pt; color: #5b6b7c; margin-top: 0.8mm; }
`;
}

function headerFooter(s: ReportSnapshot, fontCss: string) {
  const style = `<style>${fontCss} .hf{font-family:'Heebo',sans-serif;direction:rtl;width:100%;font-size:8pt;color:#3b4a5a;
    padding:0 12mm;display:flex;align-items:center;gap:4mm;-webkit-print-color-adjust:exact;}</style>`;
  const header = `${style}<div class="hf" style="border-bottom:0.3mm solid #c9d3de;padding-bottom:1.5mm;">
    ${s.company.logo ? `<img src="${s.company.logo}" style="height:9mm;max-width:40mm;object-fit:contain"/>` : ''}
    <div style="flex:1"><b style="font-size:9pt;color:#0f2a44">${esc(s.company.name)}</b>${s.company.name ? '<br/>' : ''}${esc(s.project.name)}</div>
    <div style="text-align:left">${esc(s.title)}<br/>דוח ${ltr(s.number)} · גרסה ${ltr(s.revision)}</div>
  </div>`;
  const footer = `${style}<div class="hf" style="border-top:0.3mm solid #c9d3de;padding-top:1.5mm;">
    <div style="flex:1">פרוטוקול השלמת עבודות — אינו מהווה אישור הנדסי או אישור בטיחות</div>
    <div>הופק ${ltr(formatDate(s.issuedAt))}</div>
    <div style="min-width:28mm;text-align:left">עמוד <span class="pageNumber"></span> מתוך <span class="totalPages"></span></div>
  </div>`;
  return { header, footer };
}

function cover(s: ReportSnapshot) {
  const counts = new Map<string, Record<Classification, number>>();
  for (const f of s.findings) {
    const c = counts.get(f.contractor) ?? { missing: 0, defective: 0, critical: 0 };
    c[f.classification]++;
    counts.set(f.contractor, c);
  }
  const summaryRows = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'he'))
    .map(([name, c]) => `<tr><td>${esc(name)}</td>${CLASS_ORDER.map((k) => `<td class="num">${c[k] || ''}</td>`).join('')}
      <td class="num"><b>${c.missing + c.defective + c.critical}</b></td></tr>`)
    .join('');
  const totals = CLASS_ORDER.map((k) => s.findings.filter((f) => f.classification === k).length);
  const critical = s.findings.filter((f) => f.classification === 'critical');

  return `
  <h1>${esc(s.title)}</h1>
  <div class="doc-kind">${esc(s.docKind)}</div>
  <div class="filters">${esc(s.scopeLabel)} · ${esc(s.filterLabel)}</div>
  <div class="meta">
    <div><b>פרויקט</b>${esc(s.project.name)}</div>
    <div><b>כתובת</b>${esc(s.project.address)}</div>
    <div><b>יזם</b>${esc(s.project.developer)}</div>
    <div><b>מספר דוח / גרסה</b>${ltr(s.number)} · ${ltr('Rev.' + s.revision)}</div>
    <div><b>סיור</b>${s.tourDate ? esc(s.tourLabel) : '—'}</div>
    <div><b>תאריך הפקה</b>${ltr(formatDate(s.issuedAt))}</div>
    <div><b>עורך הדוח</b>${esc([s.author.name, s.author.title].filter(Boolean).join(', ')) || '—'}</div>
    <div><b>מספר ממצאים</b>${ltr(s.findings.length)}</div>
    ${s.company.details ? `<div style="grid-column:span 4"><b>פרטי החברה</b>${esc(s.company.details)}</div>` : ''}
  </div>
  ${s.notes ? `<div class="notes"><b>הערות:</b> ${esc(s.notes)}</div>` : ''}
  ${s.participants.length ? `<h2>משתתפים</h2>
  <div class="participants">${s.participants.map((p) => `${esc(p.name)}${p.role ? ` — ${esc(p.role)}` : ''}`).join(' · ')}</div>` : ''}
  <h2>ריכוז לפי קבלן</h2>
  <table>
    <thead><tr><th>קבלן</th>${CLASS_ORDER.map((k) => `<th class="num">${CLASSIFICATION_LABEL[k]}</th>`).join('')}<th class="num">סה״כ</th></tr></thead>
    <tbody>${summaryRows}
      <tr><td><b>סה״כ</b></td>${totals.map((t) => `<td class="num"><b>${t}</b></td>`).join('')}<td class="num"><b>${s.findings.length}</b></td></tr>
    </tbody>
  </table>
  ${critical.length ? `<div class="critical-box"><h2>⚠ ליקויים קריטיים / בטיחותיים — לטיפול מיידי (${critical.length})</h2>
    <table><thead><tr><th class="num">מס׳</th><th>מיקום</th><th>תיאור</th><th>קבלן</th></tr></thead><tbody>
    ${critical.map((f) => `<tr><td class="num">${ltr(f.displayNo)}</td><td>${esc(f.location)}</td><td>${esc(f.description)}</td><td>${esc(f.contractor)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}`;
}

function closing(s: ReportSnapshot) {
  return `
  <div class="disclaimer"><b>הבהרה:</b> ${esc(s.disclaimer)}</div>
  <div class="signature">
    <div class="sig-block">
      ${s.author.signature ? `<img src="${s.author.signature}" style="max-width:55mm;object-fit:contain"/>` : '<div class="sig-blank"></div>'}
      ${esc([s.author.name, s.author.title, s.author.registration].filter(Boolean).join(' · ')) || 'עורך הדוח (שם וחתימה)'}<br/>
      תאריך: ${ltr(formatDate(s.issuedAt))}
    </div>
    <div class="sig-block" style="min-width:55mm;">&nbsp;<br/>אישור קבלה (שם, חתימה ותאריך)</div>
  </div>`;
}

const badge = (c: Classification) => `<span class="badge b-${c}">${CLASSIFICATION_LABEL[c]}</span>`;

/** Findings split into consecutive groups (the snapshot is already sorted for its grouping). */
function groups(s: ReportSnapshot): { label: string; items: ReportFindingRow[] }[] {
  if (s.grouping === 'none') return [{ label: '', items: s.findings }];
  const out: { label: string; items: ReportFindingRow[] }[] = [];
  for (const f of s.findings) {
    const label = s.grouping === 'contractor' ? f.contractor : f.area;
    if (out.at(-1)?.label === label) out.at(-1)!.items.push(f);
    else out.push({ label, items: [f] });
  }
  return out;
}

const groupTitle = (s: ReportSnapshot, label: string, n: number) =>
  `${s.grouping === 'contractor' ? 'קבלן: ' : ''}${esc(label)} (${ltr(n)})`;

function tableBody(s: ReportSnapshot) {
  const row = (f: ReportFindingRow) => `<tr class="${f.classification === 'critical' ? 'row-critical' : ''}">
      <td class="num"><b>${ltr(f.displayNo)}</b></td>
      <td>${esc(f.location)} <span class="code">${ltr(f.locationCode)}</span></td>
      <td>${esc(f.locationDetail)}</td>
      <td>${esc(f.category)}</td>
      <td>${esc(f.description)}</td>
      <td>${esc(f.contractor)}</td>
      <td>${badge(f.classification)}</td>
      <td>${STATUS_LABEL[f.status]}</td>
      <td class="num">${f.photoIds.length || ''}</td>
    </tr>`;
  const rows = groups(s)
    .map((g) => (g.label ? `<tr class="group"><td colspan="9">${groupTitle(s, g.label, g.items.length)}</td></tr>` : '') + g.items.map(row).join(''))
    .join('');
  return `<div class="page-break"></div><h2>פירוט עבודות להשלמה</h2>
  <table class="findings">
    <colgroup><col style="width:4.5%"/><col style="width:17.5%"/><col style="width:10%"/><col style="width:8%"/>
      <col style="width:30%"/><col style="width:12%"/><col style="width:8.5%"/><col style="width:6.5%"/><col style="width:3%"/></colgroup>
    <thead><tr><th class="num">מס׳</th><th>מיקום</th><th>פירוט מיקום</th><th>קטגוריה</th><th>תיאור העבודה</th>
      <th>קבלן אחראי</th><th>סיווג</th><th>סטטוס</th><th class="num">תמ׳</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function findingBlock(f: ReportFindingRow, photos: Map<string, string>) {
  const imgs = f.photoIds.map((id) => photos.get(id)).filter((u): u is string => !!u);
  const rows: string[] = [];
  for (let i = 0; i < imgs.length; i += 2) {
    const pair = imgs.slice(i, i + 2);
    rows.push(`<div class="photo-row">${pair
      .map((src, j) => `<div class="photo"><img src="${src}"/><div class="cap">ממצא ${ltr(f.displayNo)} · תמונה ${i + j + 1} מתוך ${imgs.length}</div></div>`)
      .join('')}</div>`);
  }
  return `<section class="finding ${f.classification === 'critical' ? 'critical' : ''} ${imgs.length <= 2 ? 'compact' : ''}">
    <div class="f-text">
      <div class="f-head"><span class="no">${ltr(f.displayNo)}</span><span class="loc">${esc(f.location)}</span>${badge(f.classification)}</div>
      <div class="f-meta">
        <div><b>פירוט מיקום</b>${esc(f.locationDetail) || '—'}</div>
        <div><b>קטגוריה</b>${esc(f.category)}</div>
        <div><b>קבלן אחראי</b>${esc(f.contractor)}</div>
        <div><b>סטטוס</b>${STATUS_LABEL[f.status]}</div>
      </div>
      <div class="f-desc">${esc(f.description)}</div>
    </div>
    ${rows.join('')}
  </section>`;
}

export function renderReport({ snapshot: s, photos, fontCss }: RenderInput): RenderedReport {
  const landscape = s.format === 'table';
  const body =
    s.format === 'table'
      ? tableBody(s)
      : `<div class="page-break"></div><h2>פירוט ממצאים</h2>${groups(s)
          .map((g) => (g.label ? `<h3 class="group-h">${groupTitle(s, g.label, g.items.length)}</h3>` : '') + g.items.map((f) => findingBlock(f, photos)).join(''))
          .join('')}`;
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"/>
    <style>${baseCss(fontCss, landscape)}</style></head><body>
    ${cover(s)}${body}${closing(s)}
    </body></html>`;
  const { header, footer } = headerFooter(s, fontCss);
  return { html, headerTemplate: header, footerTemplate: footer, landscape };
}
