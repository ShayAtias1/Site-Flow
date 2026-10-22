// Demo project used by the proof of concept. In the MVP this comes from project setup.
import type { ProjectRows } from './projectModel';

export type LocationKind = 'building' | 'floor' | 'unit' | 'common' | 'site';

export interface LocationNode {
  id: string;
  parentId: string | null;
  kind: LocationKind;
  name: string;
  code: string;
}

export interface Category {
  id: string;
  name: string;
  defaultContractorId: string;
  phrases: string[];
}

export interface Contractor {
  id: string;
  name: string;
  trade: string;
}

export const PROJECT = {
  id: 'demo',
  code: 'DEMO',
  name: 'פרויקט הדגמה — מגדלי הפארק',
  address: 'רח׳ הדוגמה 12, עיר לדוגמה',
  developer: 'חברת יזמות לדוגמה בע״מ',
};

export const COMPANY = {
  name: 'א.ב. יזמות ובנייה (דוגמה)',
  address: 'רח׳ התעשייה 5, עיר לדוגמה · טל׳ 03-0000000',
};

export const AUTHOR = {
  name: 'מהנדס לדוגמה',
  title: 'מהנדס ביצוע',
  license: 'מ.ר. 000000',
};

export const DISCLAIMER =
  'מסמך זה מהווה רשימת עבודות להשלמה בלבד, כפי שנצפו בסיור בתאריך הנקוב. ' +
  'אין בו משום אישור הנדסי, אישור בטיחות, אישור מסירה או אישור לאכלוס, ' +
  'ואין בו כדי לגרוע מאחריות הקבלנים לביצוע מלא לפי החוזה והתוכניות.';

export const CONTRACTORS: Contractor[] = [
  { id: 'c-plumb', name: 'אינסטלציה כהן בע״מ', trade: 'אינסטלציה' },
  { id: 'c-elec', name: 'לוי חשמל ותקשורת', trade: 'חשמל' },
  { id: 'c-tile', name: 'ריצוף מזרחי', trade: 'ריצוף וחיפוי' },
  { id: 'c-alum', name: 'אלומיניום השרון', trade: 'אלומיניום' },
  { id: 'c-plaster', name: 'טיח ושפכטל אברהם', trade: 'טיח וצבע' },
  { id: 'c-carp', name: 'נגרות גולן', trade: 'נגרות' },
  { id: 'c-steel', name: 'מסגרות הצפון', trade: 'מסגרות' },
  { id: 'c-seal', name: 'איטום פלוס', trade: 'איטום' },
  { id: 'c-main', name: 'קבלן ראשי', trade: 'כללי' },
];

export const CATEGORIES: Category[] = [
  { id: 'plumb', name: 'אינסטלציה', defaultContractorId: 'c-plumb', phrases: ['חסר כיסוי ביקורת', 'חסר סיליקון סביב כלים סניטריים', 'חסרה סוללה', 'נזילה בחיבור'] },
  { id: 'elec', name: 'חשמל', defaultContractorId: 'c-elec', phrases: ['חסרים כיסויי שקעים', 'חסר גוף תאורה', 'לוח חשמל ללא שילוט', 'חסר שקע 16A'] },
  { id: 'tile', name: 'ריצוף וחיפוי', defaultContractorId: 'c-tile', phrases: ['חסר רובה', 'אריח סדוק להחלפה', 'חסר פאנל', 'חסר סף שיש'] },
  { id: 'alum', name: 'אלומיניום', defaultContractorId: 'c-alum', phrases: ['חסרה רשת', 'חסר ידית', 'כנף לא נסגרת', 'חסר אטם'] },
  { id: 'plaster', name: 'טיח וצבע', defaultContractorId: 'c-plaster', phrases: ['תיקוני טיח', 'שכבת צבע אחרונה חסרה', 'כתמים על הקיר'] },
  { id: 'carp', name: 'נגרות', defaultContractorId: 'c-carp', phrases: ['חסר משקוף', 'דלת לא מכוונת', 'חסרה ידית דלת'] },
  { id: 'steel', name: 'מסגרות', defaultContractorId: 'c-steel', phrases: ['חסר מעקה', 'חסרה צביעה למעקה', 'חסר עיגון'] },
  { id: 'seal', name: 'איטום', defaultContractorId: 'c-seal', phrases: ['חסר איטום בחיבור', 'סימני רטיבות'] },
  { id: 'general', name: 'כללי', defaultContractorId: 'c-main', phrases: ['חסר ניקוי', 'פסולת בניין לפינוי'] },
];

function buildLocations(): LocationNode[] {
  const nodes: LocationNode[] = [];
  for (const b of ['A', 'B']) {
    const bId = `b-${b}`;
    nodes.push({ id: bId, parentId: null, kind: 'building', name: `בניין ${b}`, code: b });
    nodes.push({ id: `${bId}-lobby`, parentId: bId, kind: 'common', name: 'לובי כניסה', code: `${b}-LOBBY` });
    nodes.push({ id: `${bId}-stairs`, parentId: bId, kind: 'common', name: 'חדר מדרגות', code: `${b}-STAIRS` });
    for (let f = 1; f <= 4; f++) {
      const fId = `${bId}-f${f}`;
      nodes.push({ id: fId, parentId: bId, kind: 'floor', name: `קומה ${f}`, code: `${b}-${String(f).padStart(2, '0')}` });
      for (let u = 1; u <= 4; u++) {
        const no = (f - 1) * 4 + u;
        nodes.push({ id: `${fId}-u${no}`, parentId: fId, kind: 'unit', name: `דירה ${no}`, code: `${b}-${String(f).padStart(2, '0')}-${String(no).padStart(2, '0')}` });
      }
    }
    nodes.push({ id: `${bId}-roof`, parentId: bId, kind: 'common', name: 'גג', code: `${b}-ROOF` });
  }
  nodes.push({ id: 'site', parentId: null, kind: 'site', name: 'פיתוח ושטחים משותפים', code: 'SITE' });
  nodes.push({ id: 'site-parking', parentId: 'site', kind: 'common', name: 'חניון ‎-1', code: 'P-1' });
  nodes.push({ id: 'site-garden', parentId: 'site', kind: 'common', name: 'גינה צפונית', code: 'GARDEN-N' });
  nodes.push({ id: 'site-pumps', parentId: 'site', kind: 'common', name: 'חדר משאבות', code: 'PUMPS' });
  return nodes;
}

export const LOCATIONS = buildLocations();

const byId = new Map(LOCATIONS.map((n) => [n.id, n]));

export function locationById(id: string) {
  return byId.get(id);
}

/** Leaf locations (where findings are recorded) in walking order — drives "next unit". */
export const WALK_ORDER = LOCATIONS.filter((n) => n.kind === 'unit' || n.kind === 'common');

export function locationPath(id: string): LocationNode[] {
  const path: LocationNode[] = [];
  let cur = byId.get(id);
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

export function locationLabel(id: string) {
  return locationPath(id).map((n) => n.name).join(' › ');
}

export function isWithin(locationId: string, ancestorId: string) {
  return locationPath(locationId).some((n) => n.id === ancestorId);
}

export const categoryById = (id: string) => CATEGORIES.find((c) => c.id === id);
export const contractorById = (id: string) => CONTRACTORS.find((c) => c.id === id);

/** The demo fixture as database-shaped rows (sample PDFs and tests use the same model builder as the app). */
export function demoProjectRows(): ProjectRows {
  const row = { deleted_at: null };
  return {
    project: { ...row, id: PROJECT.id, org_id: 'demo-org', code: PROJECT.code, name: PROJECT.name, address: PROJECT.address, developer: PROJECT.developer },
    locations: LOCATIONS.map((n, i) => ({ ...row, id: n.id, project_id: PROJECT.id, parent_id: n.parentId, kind: n.kind, name: n.name, code: n.code, sort_order: i })),
    categories: CATEGORIES.map((c, i) => ({ ...row, id: c.id, name: c.name, phrases: c.phrases, sort_order: i })),
    contractors: CONTRACTORS.map((c) => ({ ...row, id: c.id, name: c.name, trade: c.trade })),
    projectContractors: CONTRACTORS.map((c) => ({ ...row, id: `pc-${c.id}`, project_id: PROJECT.id, contractor_id: c.id })),
    defaults: CATEGORIES.map((c) => ({ ...row, id: `d-${c.id}`, project_id: PROJECT.id, category_id: c.id, contractor_id: c.defaultContractorId })),
  };
}
