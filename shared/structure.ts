// Project structure generator: a building with its floors and units, numbered automatically.
// Pure functions — the setup screen previews with them and writes their output as location rows.
import type { LocationKind } from './project';

export type Numbering = 'continuous' | 'byFloor';

export interface FloorSpec {
  floorFrom: number;
  floorTo: number;
  unitsPerFloor: number;
  /** continuous: 1, 2, 3… through the building (from startNo). byFloor: floor × 100 + n (301, 302…). */
  numbering: Numbering;
  startNo: number;
  unitPrefix: string;
}

export interface BuildingSpec extends FloorSpec {
  name: string;
  code: string;
  /** Common areas at building level (lobby, stairwell, roof…). */
  commons: string[];
}

export interface GeneratedNode {
  key: string;
  parentKey: string | null;
  kind: LocationKind;
  name: string;
  code: string;
}

export const COMMON_PRESETS = ['לובי כניסה', 'חדר מדרגות', 'מעליות', 'גג', 'חדר אשפה', 'מחסנים', 'חניון', 'מקלט'];

export const LIMITS = { floors: 80, unitsPerFloor: 40, nodes: 2500 };

const pad2 = (n: number) => String(n).padStart(2, '0');

export function floorName(f: number) {
  return f === 0 ? 'קומת קרקע' : `קומה ${f}`;
}

export function floorCode(buildingCode: string, f: number) {
  const part = f < 0 ? `B${-f}` : pad2(f);
  return buildingCode ? `${buildingCode}-${part}` : part;
}

/** Unit numbers on one floor. `index` is the floor's position in the range (0 for the first floor). */
export function unitNumbers(spec: FloorSpec, floor: number, index: number): number[] {
  return Array.from({ length: spec.unitsPerFloor }, (_, i) =>
    spec.numbering === 'byFloor' ? floor * 100 + i + 1 : spec.startNo + index * spec.unitsPerFloor + i,
  );
}

export function validateFloors(spec: FloorSpec): string | null {
  const ints = [spec.floorFrom, spec.floorTo, spec.unitsPerFloor, spec.startNo];
  if (ints.some((n) => !Number.isInteger(n))) return 'יש להזין מספרים שלמים';
  if (spec.floorTo < spec.floorFrom) return 'הקומה האחרונה נמוכה מהראשונה';
  if (spec.floorTo - spec.floorFrom + 1 > LIMITS.floors) return `עד ${LIMITS.floors} קומות בבת אחת`;
  if (spec.unitsPerFloor < 0 || spec.unitsPerFloor > LIMITS.unitsPerFloor) return `מספר הדירות בקומה: 0 עד ${LIMITS.unitsPerFloor}`;
  if (spec.numbering === 'byFloor' && spec.floorFrom < 0 && spec.unitsPerFloor > 0)
    return 'מספור לפי קומה אפשרי מקומת הקרקע ומעלה. בחר מספור רציף, או 0 דירות בקומות המרתף';
  if (spec.numbering === 'byFloor' && spec.unitsPerFloor > 99) return 'מספור לפי קומה תומך בעד 99 דירות בקומה';
  if (spec.numbering === 'continuous' && spec.startNo < 0) return 'מספר הדירה הראשונה לא יכול להיות שלילי';
  return null;
}

export function validateBuilding(spec: BuildingSpec): string | null {
  if (!spec.name.trim()) return 'יש להזין שם לבניין';
  return validateFloors(spec);
}

/** Floors (and their units) of `spec`, under the parent with key `parentKey`. */
export function generateFloors(spec: FloorSpec, parentKey: string, buildingCode: string): GeneratedNode[] {
  const nodes: GeneratedNode[] = [];
  const prefix = spec.unitPrefix.trim();
  for (let f = spec.floorFrom, index = 0; f <= spec.floorTo; f++, index++) {
    const fKey = `${parentKey}/f${f}`;
    const fCode = floorCode(buildingCode, f);
    nodes.push({ key: fKey, parentKey, kind: 'floor', name: floorName(f), code: fCode });
    for (const no of unitNumbers(spec, f, index)) {
      nodes.push({ key: `${fKey}/u${no}`, parentKey: fKey, kind: 'unit', name: prefix ? `${prefix} ${no}` : String(no), code: `${fCode}-${pad2(no)}` });
    }
  }
  return nodes;
}

/** A whole building in walking order: building, its common areas, then floor by floor. */
export function generateBuilding(spec: BuildingSpec): GeneratedNode[] {
  const code = spec.code.trim();
  const commons = spec.commons.map((name, i): GeneratedNode => ({
    key: `b/c${i}`,
    parentKey: 'b',
    kind: 'common',
    name,
    code: code ? `${code}-C${i + 1}` : `C${i + 1}`,
  }));
  return [{ key: 'b', parentKey: null, kind: 'building', name: spec.name.trim(), code }, ...commons, ...generateFloors(spec, 'b', code)];
}

/** "1–4", "101–104", or "—" — for previews. */
export function rangeLabel(numbers: number[]) {
  if (!numbers.length) return '—';
  return numbers.length === 1 ? String(numbers[0]) : `${numbers[0]}–${numbers[numbers.length - 1]}`;
}

/** "דירה 12" → "12": inside a floor row the number alone identifies the unit. Other names stay whole. */
export function unitShortLabel(name: string) {
  return /^\D*?\s*(\d+)$/.exec(name.trim())?.[1] ?? name;
}
