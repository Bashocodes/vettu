/**
 * Jobs — truth on disk at VETTU_DATA_DIR/jobs/<id>.json (atomic), never module memory.
 * A job still `running` 15 min after startedAt reads back as failed "stalled". Server only.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Job, JobKind, JobStatus } from "@/lib/contracts/jobs";
import { HttpError } from "./guard";
import { dataDir } from "./roots";
import { atomicWriteJson, listJsonFiles, readJson, serial } from "./ffmpeg/disk";

const ID = /^job_[a-f0-9]{8,32}$/;
export const STALL_MS = 15 * 60_000;

const jobsDir = () => join(dataDir(), "jobs");
function jobPath(id: string): string {
  if (!ID.test(id)) throw new HttpError(404, "No such job.");
  return join(jobsDir(), `${id}.json`);
}

function readBack(job: Job, now = Date.now()): Job {
  if (job.status === "running" && job.startedAt && now - Date.parse(job.startedAt) > STALL_MS) {
    return { ...job, status: "failed", error: job.error ?? "stalled", finishedAt: job.finishedAt ?? new Date(now).toISOString() };
  }
  return job;
}

export async function createJob(input: {
  filmId: string;
  section: string;
  kind: JobKind;
  title: string;
  insertId?: string | null;
  status?: JobStatus;
}): Promise<Job> {
  const now = new Date().toISOString();
  const status = input.status ?? "queued";
  const job: Job = {
    id: `job_${randomBytes(8).toString("hex")}`,
    filmId: input.filmId,
    section: input.section,
    kind: input.kind,
    status,
    title: input.title,
    createdAt: now,
    startedAt: status === "running" ? now : null,
    finishedAt: null,
    progress: null,
    insertId: input.insertId ?? null,
    result: null,
    error: null,
  };
  await atomicWriteJson(jobPath(job.id), job);
  return job;
}

export async function updateJob(
  id: string,
  patch: Partial<Omit<Job, "id" | "filmId" | "section" | "kind" | "createdAt">>,
): Promise<Job> {
  const path = jobPath(id);
  return serial(path, async () => {
    const current = await readJson<Job>(path);
    if (!current) throw new HttpError(404, "No such job.");
    const next: Job = { ...current, ...patch, id: current.id, filmId: current.filmId, section: current.section, kind: current.kind, createdAt: current.createdAt };
    if (patch.status === "running" && !next.startedAt) next.startedAt = new Date().toISOString();
    if (patch.status && ["done", "failed", "cancelled"].includes(patch.status) && !next.finishedAt)
      next.finishedAt = new Date().toISOString();
    await atomicWriteJson(path, next);
    return next;
  });
}

export async function getJob(id: string): Promise<Job | null> {
  if (!ID.test(id)) return null;
  const job = await readJson<Job>(jobPath(id)).catch(() => null);
  return job ? readBack(job) : null;
}

export async function listJobs(filter: { filmId?: string; section?: string }): Promise<Job[]> {
  const names = await listJsonFiles(jobsDir());
  const jobs = await Promise.all(names.map((n) => getJob(n.slice(0, -5))));
  return jobs
    .filter((j): j is Job => !!j)
    .filter((j) => (!filter.filmId || j.filmId === filter.filmId) && (!filter.section || j.section === filter.section))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function cancelJob(id: string): Promise<Job> {
  const job = await getJob(id);
  if (!job) throw new HttpError(404, "No such job.");
  if (job.status !== "queued" && job.status !== "running") return job;
  return updateJob(id, { status: "cancelled", finishedAt: new Date().toISOString() });
}
