/** Saves a file through the browser's download (Safari: Downloads folder; iOS: the share/save sheet). */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari reads the blob asynchronously after the click.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Shares a file with the system share sheet when the browser can; returns false otherwise. */
export async function shareFile(blob: Blob, name: string, title: string): Promise<boolean> {
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (!nav.share || !nav.canShare?.({ files: [file] })) return false;
  try {
    await nav.share({ files: [file], title });
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  }
  return true;
}
