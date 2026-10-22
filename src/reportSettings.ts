// Report branding of the organization (table report_settings, M7): company, author, logo, signature.
// Edited online, like project setup; a save based on an outdated version is refused, never overwritten.
import { supabase } from './auth';

export interface ReportSettings {
  id: string;
  org_id: string;
  company_name: string;
  company_details: string;
  logo: string | null;
  author_name: string;
  author_title: string;
  author_registration: string;
  signature: string | null;
  version: number;
}

export type ReportSettingsFields = Omit<ReportSettings, 'id' | 'org_id' | 'version'>;

export const EMPTY_SETTINGS: ReportSettingsFields = {
  company_name: '',
  company_details: '',
  logo: null,
  author_name: '',
  author_title: '',
  author_registration: '',
  signature: null,
};

const offline = (msg: string) => /fetch|network|Load failed/i.test(msg);

export async function loadReportSettings(orgId: string): Promise<ReportSettings | null> {
  const { data, error } = await supabase.from('report_settings').select('*').eq('org_id', orgId).maybeSingle();
  if (error) throw new Error(offline(error.message) ? 'אין חיבור לשרת' : error.message);
  return data as ReportSettings | null;
}

export async function saveReportSettings(orgId: string, current: ReportSettings | null, fields: ReportSettingsFields): Promise<ReportSettings> {
  const clean = {
    ...fields,
    company_name: fields.company_name.trim(),
    company_details: fields.company_details.trim(),
    author_name: fields.author_name.trim(),
    author_title: fields.author_title.trim(),
    author_registration: fields.author_registration.trim(),
  };
  const res = current
    ? await supabase.from('report_settings').update(clean).eq('id', current.id).eq('version', current.version).select()
    : await supabase.from('report_settings').insert({ id: crypto.randomUUID(), org_id: orgId, ...clean }).select();
  if (res.error) {
    if (res.error.code === '42501' || /row-level security|permission/i.test(res.error.message)) throw new Error('אין לך הרשאת עריכה בארגון הזה.');
    if (res.error.code === '23505') throw new Error('ההגדרות נשמרו בינתיים ממכשיר אחר. טען מחדש ונסה שוב.');
    if (res.error.code === '23514') throw new Error('קובץ התמונה גדול מדי או בפורמט לא נתמך.');
    throw new Error(offline(res.error.message) ? 'אין חיבור לשרת. שמירת הגדרות הדוח דורשת חיבור.' : res.error.message);
  }
  if (!res.data.length) throw new Error('ההגדרות שונו בינתיים ממכשיר אחר. טען מחדש ונסה שוב.');
  return res.data[0] as ReportSettings;
}

const MAX_DATA_URI = 780_000;

/**
 * A logo or signature image as a PNG data URI (JPEG if PNG would be too large), scaled to `edge` pixels.
 * Re-encoding through a canvas keeps only the pixels: nothing else from the uploaded file is stored.
 */
export async function imageToDataUri(file: Blob, edge: number): Promise<string> {
  if (!/^image\/(png|jpeg|jpg|webp|gif|heic|heif)$/i.test(file.type) && file.type !== '') throw new Error('יש לבחור קובץ תמונה (PNG או JPEG).');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('לא ניתן לקרוא את התמונה. נסה קובץ PNG או JPEG.');
  }
  const scale = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  let uri = c.toDataURL('image/png');
  if (uri.length > MAX_DATA_URI) {
    const ctx = c.getContext('2d')!;
    // JPEG has no transparency: paint white behind the image.
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    uri = c.toDataURL('image/jpeg', 0.85);
  }
  if (uri.length > MAX_DATA_URI) throw new Error('התמונה גדולה מדי גם אחרי הקטנה.');
  return uri;
}
