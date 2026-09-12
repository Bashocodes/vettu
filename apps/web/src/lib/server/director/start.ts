/**
 * POST /api/director → startDirector: an `assembly` job returned at once; the background run
 * is a Claude tool loop (≤3 queued jobs) and falls back to the server queue (one add_sound)
 * when there is no ANTHROPIC_API_KEY or the API errors. The job never hangs. Server only.
 */
import type { DirectorBody, Job } from "@/lib/contracts/jobs";
import type { Timeline } from "@/lib/contracts/timeline";
import { HttpError } from "../guard";
import { newJob, openTimeline, patchJob } from "../gen/bridge";
import { GenError } from "../gen/ffmpeg";
import { startGeneratorJob } from "../gen/start";
import { directorFailure, directorModelId, directorTools, runClaudeDirector, type QueuedJob, type StartJob } from "./claude";
import { planFallback } from "./fallback";

const now = () => new Date().toISOString();
const short = (s: string, n = 48) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

export async function startDirector(body: DirectorBody, startJob: StartJob = startGeneratorJob): Promise<{ jobId: string }> {
  const tl = await openTimeline(body.filmId, body.section);
  const job = await newJob({
    filmId: body.filmId,
    section: tl.section,
    kind: "assembly",
    title: `director · ${short(body.brief)}`,
    insertId: null,
    status: "queued",
  });
  void runDirector(body, tl, job.id, startJob).catch(async () => {
    await patchJob(job.id, {
      status: "failed",
      finishedAt: now(),
      error: "The Director stopped.",
      progress: "The Director stopped.",
    }).catch(() => null);
  });
  return { jobId: job.id };
}

export async function runDirector(body: DirectorBody, tl: Timeline, jobId: string, startJob: StartJob): Promise<void> {
  const sectionId = tl.section;
  const target = { filmId: body.filmId, section: sectionId };
  const queued: QueuedJob[] = [];
  let latest: Pick<Timeline, "edl" | "shots" | "inserts"> = tl;
  const ids = () => queued.map((q) => q.jobId).join(" · ");

  await patchJob(jobId, { status: "running", startedAt: now(), progress: "Director (Claude): planning" });

  const key = process.env.ANTHROPIC_API_KEY?.trim();
  let why = "no Anthropic key";
  if (key) {
    try {
      const tools = directorTools({
        target,
        timeline: () => latest,
        startJob: async (request) => {
          const job = await startJob(request);
          latest = await openTimeline(body.filmId, sectionId).catch(() => latest);
          return job;
        },
        onQueued: (q) => void queued.push(q),
      });
      const out = await runClaudeDirector({
        apiKey: key,
        model: directorModelId(),
        brief: body.brief,
        timeline: tl,
        tools,
        onStep: async (step) => {
          const bits = [
            "Director (Claude)",
            step.toolNames.length ? `tools ${step.toolNames.join(" · ")}` : null,
            queued.length ? `queued ${ids()}` : null,
            step.text ? tail(step.text, 300) : null,
          ];
          await patchJob(jobId, { progress: bits.filter(Boolean).join(" · ") }).catch(() => null);
        },
      });
      const said = tail(out.text, 700);
      const note = [said || null, queued.length ? `Queued: ${ids()}` : "Queued no jobs."].filter(Boolean).join(" · ");
      await patchJob(jobId, {
        status: "done",
        finishedAt: now(),
        progress: `Director (Claude) · queued ${queued.length} job${queued.length === 1 ? "" : "s"}${queued.length ? `: ${ids()}` : ""}`,
        result: { note },
        error: null,
      });
      return;
    } catch (error) {
      why = directorFailure(error);
    }
  }

  if (queued.length > 0) {
    const note = `The Director stopped early (${why}) after queueing ${ids()}.`;
    await patchJob(jobId, { status: "done", finishedAt: now(), progress: note, result: { note }, error: null });
    return;
  }

  // The server queue: one add_sound on the first shot the brief names.
  const fresh = await openTimeline(body.filmId, sectionId).catch(() => tl);
  const plan = planFallback(body.brief, fresh.edl);
  if (!plan) {
    const msg = `Server queue (${why}): the edit is empty, nothing to queue.`;
    await patchJob(jobId, { status: "failed", finishedAt: now(), progress: msg, error: msg });
    return;
  }
  await patchJob(jobId, { progress: `Server queue (${why}) · add_sound on ${plan.target}` }).catch(() => null);
  let line: string;
  let job: Job | null = null;
  try {
    job = await startJob({ ...target, ...plan });
    line = `sound ${job.id} on ${plan.target}${job.status === "failed" ? ` (failed: ${job.error ?? "unknown"})` : ""}`;
  } catch (error) {
    line = `sound refused · ${error instanceof HttpError || error instanceof GenError ? error.message : "could not start"}`;
  }
  const note = `Server queue (${why}): ${line}`;
  await patchJob(jobId, {
    status: job ? "done" : "failed",
    finishedAt: now(),
    progress: note,
    result: { note },
    error: job ? null : "No job could start.",
  });
}
