/**
 * Approve → 1080p → Ambiguous → review queue → Slack (KIT_WEB §3d/§4, KIT_CHANNEL §7b).
 * Browser-safe.
 */
import { z } from "zod";

// ── ids ──────────────────────────────────────────────────────────────────────
export function cutIdOf(filmId: string, section: string, version: number): string {
  return `${filmId}:${section}:v${version}`;
}
/** Marker line written into the Ambiguous record description. */
export function markerOf(filmId: string, section: string, version: number): string {
  return `vettu:${filmId}:${section}:v${version}`;
}
export function parseCutId(cutId: string): { filmId: string; section: string; version: number } | null {
  const m = /^([^:]+):([^:]+):v(\d+)$/.exec(cutId);
  return m ? { filmId: m[1], section: m[2], version: Number(m[3]) } : null;
}

// ── approvals: POST /api/approvals · GET /api/approvals?filmId=&section= ────
const target = {
  filmId: z.string().min(1).max(100),
  section: z.string().min(1).max(40),
};
export const approvalBody = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("propose_render"),
      ...target,
      summary: z.string().trim().min(1).max(500),
    })
    .strict(),
  z.object({ operation: z.literal("approve"), proposalId: z.string().min(1).max(100) }).strict(),
  z.object({ operation: z.literal("deny"), proposalId: z.string().min(1).max(100) }).strict(),
]);
export type ApprovalBody = z.infer<typeof approvalBody>;

export interface RenderProposal {
  id: string;
  filmId: string;
  section: string;
  version: number; // the version this approval will create
  edlHash: string;
  summary: string;
  entries: number;
  secs: number;
  createdAt: string;
  expiresAt: string;
}

export interface WorkplaceTaskRef {
  id: string;
  title: string;
  url: string | null; // never invented
}

export interface VersionRecord {
  version: number;
  filmId: string;
  section: string;
  cutId: string;
  marker: string;
  edlHash: string;
  summary: string;
  secs: number;
  finalUrl: string; // 1080p in VETTU_WORK/renders
  previewUrl: string; // 540p queued for Slack
  task: WorkplaceTaskRef | null; // the Ambiguous record, read back
  ambiguous: "saved" | "unconfigured" | "failed";
  ambiguousError: string | null;
  approvedAt: string;
  slack: "queued" | "posted";
  postedAt: string | null;
}

export interface ApprovalsView {
  proposal: RenderProposal | null;
  versions: VersionRecord[]; // newest first
  ambiguous: "configured" | "unconfigured";
}

// ── channel → web (server to server, loopback) ───────────────────────────────
/** GET /api/review/queue → ReviewQueueItem[] (approved, not yet posted). */
export interface ReviewQueueItem {
  cutId: string;
  version: number;
  title: string;
  previewPath: string; // absolute path of the 540p MP4 on this Mac (the channel reads the file)
  posterPath?: string | null; // absolute path of a PNG poster
}

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

/** GET /api/change-orders?filmId= → { changeOrders } (newest first) — the overlay card. */
export interface ChangeOrdersView {
  changeOrders: ChangeOrder[];
}
