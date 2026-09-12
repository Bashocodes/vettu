/**
 * Pure edit-list helpers for generators: resolve a shot ref, place an insert entry,
 * section-timeline heads, and sound placement by RMS peak. No I/O. Server + tests.
 */
import type { EdlEntry, Insert, Shot, Timeline } from "@/lib/contracts/timeline";

export const MAX_EDL_ENTRIES = 20;

/** Index of the EDL entry a ref names: entry id "e3", shot id "S3", slot "3", card id "sec04/S3", insert id. */
export function resolveEntryIndex(t: Pick<Timeline, "edl" | "shots">, ref: string): number {
  const r = ref.trim();
  if (!r) return -1;
  let i = t.edl.findIndex((e) => e.id === r || e.ref === r);
  if (i >= 0) return i;
  const shot = findShot(t.shots, r);
  if (shot) {
    i = t.edl.findIndex((e) => e.ref === shot.id);
    if (i >= 0) return i;
  }
  if (/^\d{1,2}$/.test(r)) {
    i = t.edl.findIndex((e) => e.ref === `S${Number(r)}`);
    if (i >= 0) return i;
  }
  return -1;
}

export function findShot(shots: Shot[], ref: string): Shot | undefined {
  const r = ref.trim();
  const upper = r.toUpperCase();
  return (
    shots.find((s) => s.id === r) ??
    shots.find((s) => s.id.toUpperCase() === upper) ??
    shots.find((s) => s.cardId === r) ??
    (/^\d{1,2}$/.test(r) ? shots.find((s) => s.slot === Number(r)) : undefined)
  );
}

export function nextEntryId(edl: EdlEntry[]): string {
  let max = 0;
  for (const e of edl) {
    const m = /^e(\d+)$/.exec(e.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `e${max + 1}`;
}

export function insertEntry(edl: EdlEntry[], insertId: string, secs: number): EdlEntry {
  return {
    id: nextEntryId(edl),
    ref: insertId,
    in: 0,
    out: round3(secs),
    transition: { type: "cut", dur: 0 },
    change: "new",
    delta: null,
    recordIn: null,
    recordOut: null,
    temp: true,
  };
}

export interface Placement {
  timeline: Timeline;
  index: number;
  note: string | null;
}

/**
 * Add the insert record and its EDL entry after `afterShot` (or at the end).
 * Refuses when the edit already holds MAX_EDL_ENTRIES. An unknown afterShot lands at the end with a note.
 */
export function placeInsert(t: Timeline, insert: Insert, secs: number, afterShot?: string): Placement {
  if (t.edl.length >= MAX_EDL_ENTRIES) {
    throw new PlacementError(`The edit already holds ${MAX_EDL_ENTRIES} entries. Remove one first.`);
  }
  const entry = insertEntry(t.edl, insert.id, secs);
  let index = t.edl.length;
  let note: string | null = null;
  if (afterShot) {
    const at = resolveEntryIndex(t, afterShot);
    if (at >= 0) index = at + 1;
    else note = `No shot ${afterShot} in this edit; the insert went to the end.`;
  }
  // A fade into the entry that now follows the insert moves onto the insert (the picture keeps
  // one crossfade from the previous shot); the following entry becomes a cut.
  const following = t.edl[index];
  let edl: EdlEntry[];
  if (following && following.transition.type !== "cut") {
    const moved = following.transition;
    const placed: EdlEntry = entry.out - entry.in > moved.dur ? { ...entry, transition: { ...moved } } : entry;
    edl = [
      ...t.edl.slice(0, index),
      placed,
      { ...following, transition: { type: "cut", dur: 0 } },
      ...t.edl.slice(index + 1),
    ];
  } else {
    edl = [...t.edl.slice(0, index), entry, ...t.edl.slice(index)];
  }
  const inserts = [...t.inserts.filter((x) => x.id !== insert.id), insert];
  return { timeline: { ...t, edl, inserts }, index, note };
}

export class PlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacementError";
  }
}

/**
 * Where each entry starts on the section timeline (seconds). Joins follow FFMPEG_TOOLS §2.6:
 * entry k starts at Σ d(0..k-1) − Σ t(1..k), t = the transition INTO an entry (0 for a cut).
 */
export function entryHeads(edl: Pick<EdlEntry, "in" | "out" | "transition">[]): number[] {
  const heads: number[] = [];
  let acc = 0;
  edl.forEach((e, k) => {
    const t = k === 0 || e.transition.type === "cut" ? 0 : Math.max(0, e.transition.dur);
    const start = Math.max(0, acc - t);
    heads.push(round3(start));
    acc = start + Math.max(0, e.out - e.in);
  });
  return heads;
}

/** Lay a sound so its RMS peak lands on `head`. Clamped at 0 (then the peak lands late). */
export function placeByPeak(head: number, peakOffset: number): { at: number; clamped: boolean } {
  const raw = head - Math.max(0, peakOffset);
  return raw < 0 ? { at: 0, clamped: true } : { at: round3(raw), clamped: false };
}

/** Spread n draw inserts across an edit: the entry id each one follows. */
export function spreadAfter(edl: Pick<EdlEntry, "id">[], n: number): (string | undefined)[] {
  if (edl.length === 0) return Array.from({ length: n }, () => undefined);
  return Array.from({ length: n }, (_, i) => {
    const idx = Math.min(edl.length - 1, Math.max(0, Math.round(((i + 1) * edl.length) / (n + 1)) - 1));
    return edl[idx]!.id;
  });
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
