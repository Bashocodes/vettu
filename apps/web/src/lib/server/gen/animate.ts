/**
 * Pure helpers for animate jobs: body checks, where the new insert lands, and which
 * frame of a shot becomes its still. No I/O. Server + tests.
 */
import type { MediaSrc } from "@/lib/contracts/film";
import type { JobCreateBody } from "@/lib/contracts/jobs";
import type { Timeline } from "@/lib/contracts/timeline";
import { HttpError } from "../guard";
import { resolveEntryIndex } from "./placement";

export type AnimateBody = Extract<JobCreateBody, { kind: "animate" }>;

export const DRAW_OFF_MESSAGE = "Drawing is off in this build — VETTU has no image model. Animate an existing shot instead.";
export const DEFAULT_ANIMATE_SECS = 5;

const STILL_EXT = /\.(png|jpe?g|webp)$/i;
export function isStill(media: MediaSrc): boolean {
  return STILL_EXT.test("src" in media ? media.src : media.p);
}

/** One of fromShot / insertId is required. Throws HttpError 400. */
export function checkAnimateBody(body: Pick<AnimateBody, "fromShot" | "insertId">): "fromShot" | "insertId" {
  const from = body.fromShot?.trim();
  const insert = body.insertId?.trim();
  if (insert) return "insertId";
  if (from) return "fromShot";
  throw new HttpError(400, "Say which shot to animate (fromShot) or which insert to re-animate (insertId).");
}

/** The ref the new insert follows: afterShot when given, else the fromShot's own entry id. */
export function animateAfter(t: Pick<Timeline, "edl" | "shots">, fromShot: string, afterShot?: string): string | undefined {
  if (afterShot?.trim()) return afterShot.trim();
  const idx = resolveEntryIndex(t, fromShot);
  return idx >= 0 ? t.edl[idx]!.id : undefined;
}

/**
 * Seconds to ask Kling for when re-animating an insert: never shorter than its EDL entry.
 * The body's secs always arrives filled (the schema default is 5), so a longer entry would
 * otherwise get a 5 s clip and the preview would end early under it.
 */
export function reanimateSecs(entry: Pick<Timeline["edl"][number], "in" | "out"> | undefined, secs?: number): number {
  const entryLen = entry ? Math.max(0, entry.out - entry.in) : 0;
  return Math.max(secs ?? DEFAULT_ANIMATE_SECS, entryLen);
}

export interface StillSource {
  media: MediaSrc;
  /** Seconds into the source media (0 for a still). */
  at: number;
  still: boolean;
}

/**
 * The frame an entry gives up as a still. A still clip (image card) is used whole.
 * Otherwise `at` is seconds into the ENTRY (default: its middle), mapped to clip time
 * as entry.in + at, clamped inside the entry and the clip.
 */
export function stillSourceFor(t: Timeline, entryIndex: number, at?: number): StillSource | null {
  const e = t.edl[entryIndex];
  if (!e) return null;
  const len = Math.max(0, e.out - e.in);
  const offset = at === undefined || !Number.isFinite(at) ? len / 2 : Math.min(Math.max(0, at), len);
  const insert = t.inserts.find((x) => x.id === e.ref);
  if (insert) {
    if (insert.still) return { media: insert.still, at: 0, still: true };
    if (insert.video) return { media: insert.video, at: round3(e.in + offset), still: false };
    return null;
  }
  const shot = t.shots.find((s) => s.id === e.ref);
  const clip = t.clips.find((c) => c.id === (shot ? shot.clipId : e.ref));
  if (!clip) return null;
  if (isStill(clip.media)) return { media: clip.media, at: 0, still: true };
  const limit = Math.max(0, clip.duration - 0.05);
  return { media: clip.media, at: round3(Math.min(e.in + offset, limit)), still: false };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
