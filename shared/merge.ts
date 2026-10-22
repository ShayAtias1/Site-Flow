import { FINDING_FIELDS, type FindingData } from './types';

export function pickData(src: FindingData): FindingData {
  const out = {} as Record<string, unknown>;
  for (const f of FINDING_FIELDS) out[f] = src[f];
  return out as unknown as FindingData;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface MergeResult {
  merged: FindingData;
  /** Fields changed differently on both sides — these need a human decision. */
  conflicts: (keyof FindingData)[];
}

/**
 * Three-way merge of a local edit against a newer server row.
 * A field changed on one side only is taken from that side; a field changed
 * differently on both sides is reported as a conflict and left at the local value.
 * Photo lists are unioned, since photos are only ever added.
 */
export function threeWayMerge(base: FindingData | null, local: FindingData, server: FindingData): MergeResult {
  const merged = pickData(local) as unknown as Record<string, unknown>;
  const conflicts: (keyof FindingData)[] = [];
  for (const f of FINDING_FIELDS) {
    const l = local[f];
    const s = server[f];
    if (f === 'photoIds') {
      merged[f] = Array.from(new Set([...(server.photoIds ?? []), ...(local.photoIds ?? [])]));
      continue;
    }
    if (same(l, s)) continue;
    const b = base ? base[f] : undefined;
    if (base && same(l, b)) merged[f] = s;
    else if (base && same(s, b)) merged[f] = l;
    else conflicts.push(f);
  }
  return { merged: merged as unknown as FindingData, conflicts };
}
