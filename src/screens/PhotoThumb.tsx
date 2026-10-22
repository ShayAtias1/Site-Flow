import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../db';
import { photoUrl } from '../remote';

/** Shows a photo from local storage, or from the server when it only exists there. */
export function PhotoThumb({ id, onRemove }: { id: string; onRemove?: () => void }) {
  // null = not on this device (undefined only while loading).
  const photo = useLiveQuery(async () => (await db.photos.get(id)) ?? null, [id]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (photo === undefined) return;
    if (!photo) {
      let alive = true;
      photoUrl(id).then((u) => alive && setUrl(u), () => undefined);
      return () => {
        alive = false;
      };
    }
    const u = URL.createObjectURL(new Blob([photo.thumb], { type: 'image/jpeg' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [photo, id]);
  return (
    <div className="thumb">
      {url && <img src={url} alt="" />}
      {photo && !photo.uploaded && <span className="dot" title="ממתינה להעלאה" />}
      {onRemove && (
        <button className="x" aria-label="הסר תמונה" onClick={onRemove}>×</button>
      )}
    </div>
  );
}
