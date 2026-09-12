/**
 * Mirror of the web contract `apps/web/src/lib/contracts/review.ts`, field for
 * field. The channel listener is a separate process and never imports from
 * apps/web, so keep this file in step with that contract by hand.
 */
import { z } from "zod";

// ── channel → web (server to server, loopback) ───────────────────────────────
/** GET /api/review/queue → ReviewQueueItem[] (approved, not yet posted). */
export interface ReviewQueueItem {
  cutId: string;
  version: number;
  title: string;
  previewPath: string; // absolute path of the 540p MP4 on this machine (the channel reads the file)
  posterPath?: string | null; // absolute path of a PNG poster
}

/** Response-side check for one queue item. Unknown extra fields are ignored. */
export const reviewQueueItem = z.object({
  cutId: z.string().min(1).max(200),
  version: z.number().finite(),
  title: z.string(),
  previewPath: z.string().min(1),
  posterPath: z.string().nullable().optional(),
});

/** POST /api/review/posted { cutId } → { ok: true } — only after postFile ok AND the card posted. */
export const reviewPostedBody = z.object({ cutId: z.string().min(1).max(200) }).strict();

/** POST /api/change-orders — idempotent on idempotencyKey. → { changeOrder, duplicate } */
export const changeOrderBody = z
  .object({
    idempotencyKey: z.string().min(1).max(300),
    cutId: z.string().min(1).max(200),
    kind: z.enum(["approve", "changes"]),
    text: z.string().max(4000).optional(),
    reviewer: z.object({ id: z.string().max(200), name: z.string().max(200) }).strict(),
    source: z.enum(["button", "reply"]),
  })
  .strict();
export type ChangeOrderBody = z.infer<typeof changeOrderBody>;

export interface WorkplaceTaskRef {
  id: string;
  title: string;
  url: string | null; // never invented
}

export interface ChangeOrder {
  id: string;
  idempotencyKey: string;
  cutId: string;
  filmId: string;
  section: string;
  version: number;
  kind: "approve" | "changes";
  text: string | null;
  reviewer: { id: string; name: string };
  source: "button" | "reply";
  createdAt: string;
  task: WorkplaceTaskRef | null; // Ambiguous create_task for "changes"
  taskStatus: "pending" | "created" | "skipped" | "failed";
  error: string | null;
}

// ── channel-only ─────────────────────────────────────────────────────────────
/**
 * Per-thread state of the review thread. On the managed launcher (Intelligence
 * API key set) thread state lives in Intelligence KV, keyed by the canonical
 * thread id; without one it is in-memory and lost on restart.
 */
export interface ReviewThreadState {
  /** Set by Request changes: the next human reply is that cut's change order. */
  awaitingNotesFor?: string;
  /** The card title of that cut, for the confirmation line. */
  awaitingTitle?: string;
  /**
   * The first decision per cut in this thread. A later card for the same cut
   * (re-posted after a failed upload or a listener restart) can never decide it
   * again, the other way or the same way.
   */
  decided?: Record<string, ReviewDecision>;
  /**
   * Which listener process posted a live review card per cut. That process does
   * not post a second card for the cut, because a second card with the same
   * props would take over the first card's buttons.
   */
  carded?: Record<string, string>;
  /** This thread already has its kickoff card: a later mention or welcome posts no second one. */
  kickoffPosted?: boolean;
}

export interface ReviewDecision {
  kind: "approve" | "changes";
  /** Reviewer display name, for the settled card. */
  reviewer: string;
}

const reviewDecision = z.object({
  kind: z.enum(["approve", "changes"]),
  reviewer: z.string(),
});

/** Read-side check for stored thread state. Anything malformed counts as absent. */
export const reviewThreadState = z.object({
  awaitingNotesFor: z.string().min(1).optional(),
  awaitingTitle: z.string().optional(),
  decided: z.record(z.string(), reviewDecision).optional(),
  carded: z.record(z.string(), z.string()).optional(),
  kickoffPosted: z.boolean().optional(),
});
