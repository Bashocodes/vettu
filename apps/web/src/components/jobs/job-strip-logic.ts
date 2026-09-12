/**
 * Pure helpers for the job strip (no I/O, no React). Browser-safe + tests.
 */
import type { Job, JobStatus } from "@/lib/contracts/jobs";

export const STRIP_MAX = 6;
/** Poll cadence while any shown job is queued/running. */
export const STRIP_POLL_MS = 3000;
/** Slow re-check while nothing is live, so a job queued from the chat still shows up. */
export const STRIP_IDLE_MS = 15000;

export type StripTone = "ok" | "bad" | "busy" | "off";

export function clipText(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

export function isLiveStatus(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * Only a non-terminal job offers Cancel, and never an assembly (Director) job: the Director run
 * does not check for cancel yet, so its child jobs would keep landing after the card said stop.
 */
export function canCancel(job: Pick<Job, "status" | "kind">): boolean {
  return isLiveStatus(job.status) && job.kind !== "assembly";
}

/** What a cancelled job's card says — honest for assembly jobs, whose child jobs keep running. */
export function cancelledLine(kind: Job["kind"] | null | undefined): string {
  return kind === "assembly"
    ? "Cancelled. Jobs the Director already queued keep running."
    : "Cancelled. Nothing more lands from this job.";
}

export function anyLive(jobs: ReadonlyArray<Pick<Job, "status">>): boolean {
  return jobs.some((j) => isLiveStatus(j.status));
}

export function nextPollMs(jobs: ReadonlyArray<Pick<Job, "status">>): number {
  return anyLive(jobs) ? STRIP_POLL_MS : STRIP_IDLE_MS;
}

/** Newest first (createdAt, then id for a stable order), at most `max`. */
export function stripJobs(jobs: ReadonlyArray<Job>, max = STRIP_MAX): Job[] {
  return [...jobs]
    .filter((j) => !!j && typeof j.id === "string")
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id))
    .slice(0, Math.max(0, max));
}

/** Replace one job (by id) with its fresh copy; a job not shown yet joins the list. */
export function withJob(jobs: ReadonlyArray<Job>, job: Job, max = STRIP_MAX): Job[] {
  const found = jobs.some((j) => j.id === job.id);
  return stripJobs(found ? jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...jobs], max);
}

export function statusTone(status: JobStatus): StripTone {
  if (status === "done") return "ok";
  if (status === "failed") return "bad";
  if (status === "cancelled") return "off";
  return "busy";
}

/** The title without a repeated "kind · " prefix ("sound · a latch" → "a latch"). */
export function titleText(job: Pick<Job, "kind" | "title">, max = 60): string {
  const title = clipText(job.title, 400);
  const prefix = `${job.kind} · `;
  return clipText(title.toLowerCase().startsWith(prefix) ? title.slice(prefix.length) : title, max) || job.kind;
}

/** Progress only while the job is live (a finished job shows its status, note or error instead). */
export function progressLine(job: Pick<Job, "status" | "progress">, max = 90): string | null {
  if (!isLiveStatus(job.status)) return null;
  return clipText(job.progress, max) || null;
}

/** The job's controlled error message, clipped; nothing when there is none. */
export function errorLine(job: Pick<Job, "status" | "error">, max = 160): string | null {
  if (job.status === "cancelled") return null;
  return clipText(job.error, max) || null;
}
