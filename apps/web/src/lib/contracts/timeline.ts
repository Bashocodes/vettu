/**
 * The edit timeline (FFMPEG_TOOLS §1 + BOARD_DATA §7). One per film section at
 * VETTU_DATA_DIR/timelines/<filmId>/<sectionId>.json. Chat, LIVE, the Director and
 * the page all change this same object through /api/cut/*. Never mixed into the film of record.
 * Browser-safe.
 */
import { z } from "zod";
import type { MediaSrc } from "./film";

export type TransitionType = "cut" | "fade" | "slideleft";
export interface Transition {
  type: TransitionType;
  dur: number; // seconds; 0 for cut
}

export interface Clip {
  id: string;
  media: MediaSrc;
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
}

export interface Shot {
  id: string; // "S3" for a seeded slot
  clipId: string;
  cardId: string | null; // "sec04/S3"
  slot: number | null;
  in: number;
  out: number;
  description: string;
  tags: string[];
}

export type EdlChange = "moved" | "trimmed" | "removed" | "new";

export interface EdlEntry {
  id: string; // stable entry id ("e1"…)
  ref: string; // shotId | insertId, e.g. "S3" or "ins_…"
  in: number;
  out: number;
  transition: Transition; // transition INTO this entry (ignored on entry 0)
  change: EdlChange | null; // neutral chip on the board: moved · trimmed −0.5 s · new
  delta: number | null; // seconds added (+) or cut (−) by trims
  recordIn: number | null; // where the seeded slot plays on the running cut
  recordOut: number | null;
  temp?: boolean; // inserted (drawn/animated) shot
}

export interface WordCard {
  id: string;
  text: string;
  png: MediaSrc | null; // Pillow PNG in VETTU_WORK
  start: number;
  end: number;
}

export type InsertStatus = "drawing" | "placeholder" | "animating" | "ready" | "failed";
export interface Insert {
  id: string;
  prompt: string;
  still: MediaSrc | null;
  video: MediaSrc | null; // push-in placeholder first, the Kling clip when it lands
  sfx: MediaSrc | null;
  temp: true;
  status: InsertStatus;
  jobIds: string[];
  error: string | null;
}

export interface LaidSound {
  id: string;
  media: MediaSrc;
  at: number; // seconds on the section timeline (placed by RMS peak)
  gainDb: number;
}

export interface TimelineMusic {
  media: MediaSrc;
  offset: number; // seconds into the music file at the section head
  fadeOutAt: number | null; // seconds on the section timeline
}

export interface PreviewInfo {
  draft: number; // the number shown as "VETTU PREVIEW v<draft>" (= version + 1)
  url: string; // /api/media?root=VETTU_WORK&p=…
  secs: number;
  renderedAt: string;
}

export interface Timeline {
  filmId: string;
  section: string; // section id
  baseRev: number; // film store rev when seeded (drift banner when it differs)
  version: number; // last APPROVED version (0 = none yet); +1 on each approved final render
  status: "draft" | "approved"; // "approved" until the next edit
  clips: Clip[];
  shots: Shot[];
  edl: EdlEntry[];
  words: WordCard[];
  inserts: Insert[];
  sounds: LaidSound[];
  music: TimelineMusic | null;
  jobs: string[]; // job ids touching this timeline
  preview: PreviewInfo | null;
  lastChange: string | null; // chip text: "trimmed +0.5 s"
  updatedAt: string;
}

// ── request bodies (the same schemas validate in the routes) ─────────────────

const target = {
  filmId: z.string().min(1).max(100),
  section: z.string().min(1).max(40), // section id or code
};
/** A shot reference: entry id ("e3"), shot id ("S3"), slot number ("3") or card id ("sec04/S3"). */
const shotRef = z.string().min(1).max(100);

export const timelineBody = z.object({ ...target, reseed: z.boolean().optional() }).strict();
export const trimBody = z
  .object({
    ...target,
    shot: shotRef,
    in: z.number().min(0).optional(),
    out: z.number().positive().optional(),
    delta: z.number().min(-30).max(30).optional(), // + holds longer, − shortens
    edge: z.enum(["in", "out"]).optional(), // which edge `delta` moves (default "out")
  })
  .strict();
export const moveBody = z.object({ ...target, shot: shotRef, index: z.number().int().min(0) }).strict();
export const removeBody = z.object({ ...target, shot: shotRef }).strict();
export const transitionBody = z
  .object({
    ...target,
    index: z.number().int().min(1), // the entry that the transition leads INTO
    type: z.enum(["cut", "fade", "slideleft"]),
    dur: z.number().min(0).max(2),
  })
  .strict();
export const wordsBody = z
  .object({
    ...target,
    text: z.string().trim().min(1).max(80),
    start: z.number().min(0),
    end: z.number().positive(),
  })
  .strict();
export const previewBody = z.object({ ...target }).strict();

export type TrimBody = z.infer<typeof trimBody>;
export type MoveBody = z.infer<typeof moveBody>;
export type RemoveBody = z.infer<typeof removeBody>;
export type TransitionBody = z.infer<typeof transitionBody>;
export type WordsBody = z.infer<typeof wordsBody>;

/** Every /api/cut/* POST answers with this. */
export interface CutResult {
  timeline: Timeline;
  previewUrl: string | null;
  chip: string | null; // "trimmed +0.5 s"
}
