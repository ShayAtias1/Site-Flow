import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium, type Browser } from 'playwright';
import type { ReportSnapshot } from '../../shared/types';
import { renderReport } from './template';

const require = createRequire(import.meta.url);

function fontFace(weight: number, subset: 'hebrew' | 'latin', range: string) {
  const file = require.resolve(`@fontsource/heebo/files/heebo-${subset}-${weight}-normal.woff2`);
  const b64 = readFileSync(file).toString('base64');
  return `@font-face{font-family:'Heebo';font-weight:${weight};font-style:normal;
    src:url(data:font/woff2;base64,${b64}) format('woff2');unicode-range:${range};}`;
}

const HEBREW_RANGE = 'U+0307-0308,U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F';
const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

let fontCss: string | null = null;
const getFontCss = () =>
  (fontCss ??= [400, 700].flatMap((w) => [fontFace(w, 'hebrew', HEBREW_RANGE), fontFace(w, 'latin', LATIN_RANGE)]).join('\n'));

let browserPromise: Promise<Browser> | null = null;
const getBrowser = () => (browserPromise ??= chromium.launch());

export async function closeRenderer() {
  if (browserPromise) await (await browserPromise).close();
  browserPromise = null;
}

/** Longest edge and JPEG quality of photos embedded in the PDF. */
const PRINT_EDGE = 1100;
const PRINT_QUALITY = 0.72;

/** Chromium embeds JPEGs as-is, so photos are downscaled before they reach the page. */
async function resizeForPrint(photos: Map<string, Buffer>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (photos.size === 0) return out;
  const page = await (await getBrowser()).newPage();
  try {
    for (const [id, buf] of photos) {
      // A damaged or unreadable photo is left out rather than failing the whole report.
      const dataUri = await page.evaluate(
        async ({ b64, edge, q }) => {
          const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
          const bmp = await createImageBitmap(blob);
          const scale = Math.min(1, edge / Math.max(bmp.width, bmp.height));
          const c = document.createElement('canvas');
          c.width = Math.round(bmp.width * scale);
          c.height = Math.round(bmp.height * scale);
          c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
          return c.toDataURL('image/jpeg', q);
        },
        { b64: buf.toString('base64'), edge: PRINT_EDGE, q: PRINT_QUALITY },
      ).catch(() => null);
      if (dataUri) out.set(id, dataUri);
    }
  } finally {
    await page.close();
  }
  return out;
}

export async function renderPdf(snapshot: ReportSnapshot, loadPhoto: (id: string) => Buffer | undefined): Promise<Buffer> {
  const photoBytes = new Map<string, Buffer>();
  if (snapshot.format === 'detailed') {
    for (const f of snapshot.findings)
      for (const id of f.photoIds) {
        const b = loadPhoto(id);
        if (b) photoBytes.set(id, b);
      }
  }
  const photos = await resizeForPrint(photoBytes);
  const r = renderReport({ snapshot, photos, fontCss: getFontCss() });

  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(r.html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    return await page.pdf({
      format: 'A4',
      landscape: r.landscape,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: r.headerTemplate,
      footerTemplate: r.footerTemplate,
      margin: { top: '24mm', bottom: '17mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await page.close();
  }
}
