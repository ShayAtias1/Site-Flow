// The findings table as an Excel sheet (M8): one row per finding, typed columns.
import type { ProjectModel } from './projectModel';
import { CLASSIFICATION_LABEL, STATUS_LABEL, TOUR_KIND_LABEL, type FindingData, type TourKind } from './types';
import type { Cell, Column, SheetSpec } from './xlsx';

export interface SheetFinding extends FindingData {
  id: string;
  displayNo: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SheetTour {
  id: string;
  kind: TourKind;
  tour_date: string;
}

const COLUMNS: Column[] = [
  { header: 'מס׳ ממצא', width: 10, type: 'number' },
  { header: 'פרויקט', width: 24, type: 'text' },
  { header: 'בניין / אזור', width: 16, type: 'text' },
  { header: 'קומה', width: 10, type: 'text' },
  { header: 'דירה / חלל', width: 16, type: 'text' },
  { header: 'קוד מיקום', width: 14, type: 'text' },
  { header: 'מיקום מדויק', width: 22, type: 'text' },
  { header: 'תיאור', width: 60, type: 'longtext' },
  { header: 'קטגוריה', width: 16, type: 'text' },
  { header: 'קבלן', width: 22, type: 'text' },
  { header: 'סיווג', width: 18, type: 'text' },
  { header: 'סטטוס', width: 14, type: 'text' },
  { header: 'סיור', width: 18, type: 'text' },
  { header: 'תאריך סיור', width: 12, type: 'date' },
  { header: 'נוצר', width: 17, type: 'datetime' },
  { header: 'עודכן', width: 17, type: 'datetime' },
  { header: 'תמונות', width: 8, type: 'number' },
  { header: 'נמחק', width: 8, type: 'text' },
];

/** "2026-10-20" → local midnight, so the cell shows the same day in Excel. */
const day = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, (m || 1) - 1, dd || 1);
};

export function findingsSheet(m: ProjectModel, findings: SheetFinding[], tours: Map<string, SheetTour>): SheetSpec {
  const rows: Cell[][] = findings.map((f) => {
    const path = m.locationPath(f.locationId);
    const top = path[0];
    const floor = path.find((n) => n.kind === 'floor');
    const leaf = path.at(-1);
    const tour = f.tourId ? tours.get(f.tourId) : undefined;
    return [
      f.displayNo ?? null,
      m.project.name,
      top?.name ?? '',
      floor?.name ?? '',
      leaf && leaf !== top && leaf !== floor ? leaf.name : '',
      leaf?.code ?? '',
      f.locationDetail,
      f.description,
      m.categoryById(f.categoryId)?.name ?? '',
      m.contractorById(f.contractorId)?.name ?? '',
      CLASSIFICATION_LABEL[f.classification],
      STATUS_LABEL[f.status],
      tour ? TOUR_KIND_LABEL[tour.kind] : f.tourId ? 'סיור' : 'לפני הגדרת סיורים',
      tour ? day(tour.tour_date) : null,
      new Date(f.createdAt),
      new Date(f.updatedAt),
      f.photoIds.length,
      f.deletedAt ? 'כן' : '',
    ];
  });
  return { name: 'ממצאים', columns: COLUMNS, rows };
}

export function exportFileName(m: ProjectModel, now = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  const code = m.project.code.replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'project';
  return `SiteFlow-${code}-findings-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.xlsx`;
}
