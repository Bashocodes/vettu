/**
 * The ONE file in gen/ + director/ that calls W4's jobs and timeline modules.
 * A signature drift there is a one-file fix here. Server only.
 */
import type { Job, JobKind, JobStatus } from "@/lib/contracts/jobs";
import type { CutResult, Timeline } from "@/lib/contracts/timeline";
import { createJob, getJob, listJobs, updateJob } from "@/lib/server/jobs";
import { loadTimeline, renderPreviewFor, updateTimeline } from "@/lib/server/timeline";

export type JobPatch = Partial<Omit<Job, "id" | "filmId" | "section" | "kind" | "createdAt">>;

export function newJob(input: {
  filmId: string;
  section: string;
  kind: JobKind;
  title: string;
  insertId?: string | null;
  status?: JobStatus;
}): Promise<Job> {
  return createJob(input);
}

export function patchJob(id: string, patch: JobPatch): Promise<Job> {
  return updateJob(id, patch);
}

export function readJob(id: string): Promise<Job | null> {
  return getJob(id);
}

export function jobsFor(filter: { filmId?: string; section?: string }): Promise<Job[]> {
  return listJobs(filter);
}

/** Load by section ref (id, code or name). `timeline.section` is the resolved id for writes. */
export function openTimeline(filmId: string, sectionRef: string): Promise<Timeline> {
  return loadTimeline(filmId, sectionRef);
}

/** Every generator change (a new insert, a swapped clip, a laid sound) makes the edit a draft again. */
export function changeTimeline(
  filmId: string,
  sectionId: string,
  change: (t: Timeline) => Timeline,
): Promise<Timeline> {
  return updateTimeline(filmId, sectionId, (t) => ({ ...change(t), status: "draft" }));
}

/** Render the 540p preview; a failed preview never fails a generator job. */
export async function previewFor(filmId: string, sectionId: string): Promise<CutResult | null> {
  try {
    return await renderPreviewFor(filmId, sectionId);
  } catch {
    return null;
  }
}
