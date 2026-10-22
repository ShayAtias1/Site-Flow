// Generates the two sample PDFs (tabular + detailed) from fixture data, without the app or server.
// Output: poc-output/sample-table.pdf, poc-output/sample-detailed.pdf
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { CATEGORIES, WALK_ORDER, demoProjectRows } from '../shared/project';
import { buildProjectModel } from '../shared/projectModel';
import type { Classification, ServerFinding } from '../shared/types';
import { closeRenderer, renderPdf } from '../server/report/pdf';
import { buildSnapshot, SAMPLE_BRANDING } from '../server/report/snapshot';
import { legacyOptions } from '../shared/types';

const OUT = new URL('../poc-output/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// Descriptions chosen to stress mixed Hebrew / numbers / Latin (BiDi) rendering.
const DESCRIPTIONS = [
  'חסר שקע 16A במטבח, ליד המקרר',
  'חסר סף שיש ביציאה למרפסת (רוחב 120 ס״מ)',
  'נזילה בחיבור הסיפון — יש לבדוק לחץ 6 בר',
  'מעקה מרפסת ללא עיגון! סכנת נפילה — לטיפול מיידי',
  'חסרים 3 כיסויי שקעים בחדר שינה הורים',
  'דלת כניסה לא מכוונת; פער 8 מ״מ בצד הצירים',
  'חסרה רשת בחלון חדר ילדים (סוג Klil 7300)',
  'לוח חשמל ללא שילוט מעגלים, דגם ABB-24',
  'תיקוני טיח סביב צנרת, ראה גם ממצא 12',
  'חסר ניקוי כללי לפני מסירה — כולל זגוגיות',
  'אריח סדוק להחלפה בשורה 4 מהקיר הצפוני (30×60)',
  'חסר איטום בחיבור אדנית למעקה; קוד פרט D-17',
  'שכבת צבע אחרונה חסרה; גוון RAL 9010',
  'יש לתאם עם ניר (054-0000000) או במייל test@example.com',
];
const DETAILS = ['מטבח', 'חדר רחצה הורים', 'מרפסת שירות', 'סלון, קיר מערבי', 'חדר שינה 2', 'מסדרון', 'ממ״ד', ''];
const CLASSES: Classification[] = ['missing', 'missing', 'missing', 'missing', 'defective', 'critical'];

async function makePhotos(count: number) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const photos = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const hue = (i * 47) % 360;
    await page.setContent(`<body style="margin:0;width:1600px;height:1200px;font-family:Arial;direction:rtl;
      background:linear-gradient(135deg,hsl(${hue},35%,70%),hsl(${(hue + 60) % 360},30%,45%));display:flex;
      align-items:center;justify-content:center;flex-direction:column;color:#fff">
      <div style="width:900px;height:500px;border:14px solid rgba(255,255,255,.8);border-radius:20px"></div>
      <div style="font-size:90px;font-weight:bold;margin-top:40px">תמונה לדוגמה ${i + 1}</div></body>`);
    photos.set(`photo-${i + 1}`, await page.screenshot({ type: 'jpeg', quality: 80 }));
  }
  await browser.close();
  return photos;
}

function fixtureFindings(): ServerFinding[] {
  const units = WALK_ORDER;
  const findings: ServerFinding[] = [];
  let photoNo = 0;
  for (let i = 0; i < 48; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length];
    const loc = units[(i * 3) % units.length];
    // A spread of photo counts: none, 1, 2, and one finding with 6 to test page breaking.
    const nPhotos = i === 7 ? 6 : [0, 0, 1, 2, 0, 1][i % 6];
    const photoIds = Array.from({ length: nPhotos }, () => `photo-${(photoNo++ % 14) + 1}`);
    findings.push({
      id: `f-${i}`,
      version: 1,
      displayNo: i + 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectId: 'demo',
      tourId: null,
      batchId: null,
      locationId: loc.id,
      locationDetail: DETAILS[i % DETAILS.length],
      categoryId: cat.id,
      contractorId: cat.defaultContractorId,
      classification: i === 3 ? 'critical' : CLASSES[i % CLASSES.length],
      description:
        i === 20
          ? 'תיאור ארוך במיוחד לבדיקת גלישת שורות: ' + DESCRIPTIONS.slice(0, 5).join('. ') + '.'
          : DESCRIPTIONS[i % DESCRIPTIONS.length],
      status: i % 9 === 0 ? 'reported_done' : 'open',
      photoIds,
      deletedAt: null,
    });
  }
  return findings;
}

const photos = await makePhotos(14);
const findings = fixtureFindings();
const issuedAt = '2026-10-21T09:00:00.000Z';

for (const format of ['table', 'detailed'] as const) {
  const snapshot = buildSnapshot({
    model: buildProjectModel(demoProjectRows()),
    number: format === 'table' ? 'DEMO-T-001' : 'DEMO-P-001',
    format,
    options: { ...legacyOptions({ type: 'project' }), grouping: format === 'table' ? 'location' : 'contractor', notes: 'דוח לדוגמה בלבד — נתונים ופרטי עורך בדויים.' },
    findings,
    issuedAt,
    branding: SAMPLE_BRANDING,
  });
  const t0 = Date.now();
  const pdf = await renderPdf(snapshot, (id) => photos.get(id));
  const file = new URL(`sample-${format}.pdf`, OUT);
  writeFileSync(file, pdf);
  console.log(
    `${format}: ${snapshot.findings.length} findings, ${(pdf.length / 1024 / 1024).toFixed(2)} MB, ` +
      `${Date.now() - t0} ms, sha256 ${createHash('sha256').update(pdf).digest('hex').slice(0, 12)} → ${file.pathname}`,
  );
}
await closeRenderer();
