// Renders PDF pages to PNG with pdf.js inside Chromium, and extracts page text.
// Usage: tsx scripts/pdf-to-png.ts <file.pdf> <outDir> [maxPages]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [pdfPath, outDir, maxPagesArg] = process.argv.slice(2);
const maxPages = Number(maxPagesArg ?? 99);
const pdfjsDir = fileURLToPath(new URL('../node_modules/pdfjs-dist/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1.5 });
await page.route('http://pdf.local/**', (route) => {
  const p = new URL(route.request().url()).pathname;
  if (p === '/') return route.fulfill({ contentType: 'text/html', body: '<body style="margin:0"></body>' });
  if (p === '/doc.pdf') return route.fulfill({ contentType: 'application/pdf', body: readFileSync(pdfPath) });
  return route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(pdfjsDir, p.replace('/pdfjs/', ''))) });
});
await page.goto('http://pdf.local/');
const info = await page.evaluate(async (max) => {
  // @ts-expect-error runtime import served by the route above
  const pdfjs = await import('http://pdf.local/pdfjs/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'http://pdf.local/pdfjs/build/pdf.worker.mjs';
  const doc = await pdfjs.getDocument('http://pdf.local/doc.pdf').promise;
  const texts: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, max); i++) {
    const pg = await doc.getPage(i);
    const vp = pg.getViewport({ scale: 1.4 });
    const c = document.createElement('canvas');
    c.width = vp.width;
    c.height = vp.height;
    c.id = `p${i}`;
    c.style.display = 'block';
    document.body.appendChild(c);
    await pg.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
    const tc = await pg.getTextContent();
    texts.push(tc.items.map((it: { str: string }) => it.str).join(' '));
  }
  return { pages: doc.numPages, texts };
}, maxPages);
for (let i = 1; i <= Math.min(info.pages, maxPages); i++) {
  await page.locator(`#p${i}`).screenshot({ path: join(outDir, `${basename(pdfPath, '.pdf')}-p${i}.png`) });
}
writeFileSync(join(outDir, `${basename(pdfPath, '.pdf')}-text.json`), JSON.stringify(info, null, 1));
console.log(`${basename(pdfPath)}: ${info.pages} pages`);
await browser.close();
