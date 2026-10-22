import { db, type LocalPhoto } from './db';

const FULL_EDGE = 1600;
const FULL_QUALITY = 0.8;
const THUMB_EDGE = 320;

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Older WebKit can fail on some files; fall back to an <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function encode(src: ImageBitmap | HTMLImageElement, edge: number, quality: number) {
  const w = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const h = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const scale = Math.min(1, edge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', quality),
  );
  const out = { bytes: await blob.arrayBuffer(), width: canvas.width, height: canvas.height };
  canvas.width = canvas.height = 0; // release memory early; iOS is strict about canvas memory
  return out;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Downscales one camera photo and stores it in IndexedDB immediately, before the finding is saved.
 * Photos are processed one at a time to stay within iOS memory limits.
 */
export async function storePhoto(file: Blob): Promise<LocalPhoto> {
  const src = await decode(file);
  const full = await encode(src, FULL_EDGE, FULL_QUALITY);
  const thumb = await encode(src, THUMB_EDGE, 0.7);
  if ('close' in src) src.close();
  const photo: LocalPhoto = {
    id: crypto.randomUUID(),
    findingId: null,
    bytes: full.bytes,
    thumb: thumb.bytes,
    type: 'image/jpeg',
    width: full.width,
    height: full.height,
    size: full.bytes.byteLength,
    sha256: hex(await crypto.subtle.digest('SHA-256', full.bytes)),
    uploaded: 0,
    uploadedAt: null,
    createdAt: new Date().toISOString(),
  };
  await db.photos.add(photo);
  return photo;
}
