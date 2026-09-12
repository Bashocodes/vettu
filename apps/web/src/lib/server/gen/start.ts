/**
 * Generators: animate (still → push-in → Kling) and sound (ElevenLabs), FFMPEG_TOOLS §2.8–2.9.
 * Drawing is OFF in this build (no image model). POST /api/jobs and the Director call
 * startGeneratorJob. The fast placeholder step is awaited, the job returns AT ONCE and the slow
 * providers run fire-and-forget. All truth lives in the job file and the timeline. Server only.
 *
 * Cancel: the background runs re-read the job file right before every media swap, preview and
 * "done". A cancelled job stops there — no swap, no preview, no done (the job file stays cancelled).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Job, JobCreateBody } from "@/lib/contracts/jobs";
import type { Insert, InsertStatus, LaidSound, Timeline } from "@/lib/contracts/timeline";
import { HttpError } from "../guard";
import { resolveMedia, workDir } from "../roots";
import {
  animateAfter,
  checkAnimateBody,
  DEFAULT_ANIMATE_SECS,
  DRAW_OFF_MESSAGE,
  reanimateSecs,
  stillSourceFor,
  type AnimateBody,
} from "./animate";
import { changeTimeline, newJob, openTimeline, patchJob, previewFor, readJob } from "./bridge";
import { GenError } from "./ffmpeg";
import { ensureDir, insertDir, workMedia, writeStill } from "./frames";
import { klingAnimate } from "./kling";
import { entryHeads, MAX_EDL_ENTRIES, placeByPeak, placeInsert, PlacementError, resolveEntryIndex } from "./placement";
import { pushIn } from "./pushin";
import { measurePeak, normalise, requestSound } from "./sound";

type SoundBody = Extract<JobCreateBody, { kind: "sound" }>;

/** Injectable providers for the background runs (tests pass fakes; production uses the real ones). */
export interface RunDeps {
  kling?: typeof klingAnimate;
  preview?: typeof previewFor;
  requestSound?: (input: { prompt: string; duration: number; outAbs: string }) => Promise<void>;
  measurePeak?: (inAbs: string) => Promise<number>;
  normalise?: (inAbs: string, outAbs: string) => Promise<void>;
}

export type RunOutcome = "done" | "cancelled";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const now = () => new Date().toISOString();
const short = (s: string, n = 48) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const addUnique = (list: string[] | undefined, id: string) => (list?.includes(id) ? list : [...(list ?? []), id]);
const klingKey = () => !!process.env.KLING_API_KEY?.trim();

/** Thrown from inside a provider's progress callback to stop its polling once the job is cancelled. */
class JobCancelledStop extends Error {
  constructor() {
    super("cancelled");
    this.name = "JobCancelledStop";
  }
}

/** Re-read the job file: true when it was cancelled (or is gone). */
export async function jobCancelled(jobId: string): Promise<boolean> {
  const job = await readJob(jobId).catch(() => null);
  return !job || job.status === "cancelled";
}

function message(error: unknown, fallback: string): string {
  if (error instanceof GenError || error instanceof PlacementError || error instanceof HttpError) return error.message;
  return fallback;
}

async function failJob(jobId: string, text: string, progress = text): Promise<Job | null> {
  try {
    return await patchJob(jobId, { status: "failed", finishedAt: now(), error: text, progress });
  } catch {
    return null;
  }
}

function patchInsert(
  t: Timeline,
  insertId: string,
  jobId: string,
  patch: Partial<Omit<Insert, "id" | "temp" | "jobIds">>,
): Timeline {
  return {
    ...t,
    inserts: t.inserts.map((x) => (x.id === insertId ? { ...x, ...patch, jobIds: addUnique(x.jobIds, jobId) } : x)),
    jobs: addUnique(t.jobs, jobId),
  };
}

async function markInsert(
  filmId: string,
  sectionId: string,
  insertId: string,
  jobId: string,
  patch: Partial<Omit<Insert, "id" | "temp" | "jobIds">>,
) {
  try {
    await changeTimeline(filmId, sectionId, (t) => patchInsert(t, insertId, jobId, patch));
  } catch {
    // the job file still carries the error
  }
}

export async function startGeneratorJob(body: JobCreateBody): Promise<Job> {
  switch (body.kind) {
    case "draw":
      throw new HttpError(503, DRAW_OFF_MESSAGE);
    case "animate":
      return startAnimate(body);
    case "sound":
      return startSound(body);
  }
}

// ── animate ──────────────────────────────────────────────────────────────────

async function startAnimate(body: AnimateBody): Promise<Job> {
  const mode = checkAnimateBody(body);
  const tl = await openTimeline(body.filmId, body.section);
  return mode === "insertId" ? reanimate(body, tl) : animateFromShot(body, tl);
}

/** A background Kling run threw: mark the insert + job failed, unless the user cancelled it. */
async function klingStopped(filmId: string, sectionId: string, insertId: string, jobId: string, error: unknown) {
  if (await jobCancelled(jobId)) return;
  const text = message(error, "The animate job stopped.");
  await markInsert(filmId, sectionId, insertId, jobId, { status: "failed", error: text });
  await failJob(jobId, text);
}

async function animateFromShot(body: AnimateBody, tl: Timeline): Promise<Job> {
  const fromShot = body.fromShot!.trim();
  const sectionId = tl.section;
  const idx = resolveEntryIndex(tl, fromShot);
  if (idx < 0) throw new HttpError(404, `No shot ${fromShot} in this section's edit.`);
  if (tl.edl.length >= MAX_EDL_ENTRIES) {
    throw new HttpError(409, `The edit already holds ${MAX_EDL_ENTRIES} entries. Remove one first.`);
  }
  const secs = body.secs ?? DEFAULT_ANIMATE_SECS;
  const entry = tl.edl[idx]!;
  const shot = tl.shots.find((s) => s.id === entry.ref);
  const prompt = body.prompt?.trim() || shot?.description?.trim() || `a moment from ${entry.ref}`;
  const insertId = `ins_${hex(6)}`;
  const job = await newJob({
    filmId: body.filmId,
    section: sectionId,
    kind: "animate",
    title: `animate · ${short(body.prompt?.trim() || fromShot)}`,
    insertId,
    status: "queued",
  });

  // Fast step (≈1 s, awaited): still → push-in → EDL entry, so the edit shows it before we reply.
  let placed: Job;
  try {
    const dir = await ensureDir(insertDir(insertId));
    const stillAbs = join(dir, "still.png");
    const { blank } = await writeStill(stillSourceFor(tl, idx, body.at), stillAbs);
    const placeholder = join(dir, "pushin.mp4");
    await pushIn(stillAbs, placeholder, secs);
    const insert: Insert = {
      id: insertId,
      prompt,
      still: workMedia(stillAbs),
      video: workMedia(placeholder),
      sfx: null,
      temp: true,
      status: "placeholder",
      jobIds: [job.id],
      error: null,
    };
    let note: string | null = null;
    const after = animateAfter(tl, fromShot, body.afterShot);
    await changeTimeline(body.filmId, sectionId, (t) => {
      const p = placeInsert(t, insert, secs, after);
      note = p.note;
      return { ...p.timeline, jobs: addUnique(p.timeline.jobs, job.id), lastChange: `new insert after ${after ?? "the end"}` };
    });
    const bits = ["Push-in placeholder placed", blank ? "no source media, blank frame" : null, note];
    if (!klingKey()) {
      const text = "Kling key not set";
      await markInsert(body.filmId, sectionId, insertId, job.id, { error: text });
      void previewFor(body.filmId, sectionId);
      return (await failJob(job.id, text, [...bits, `${text} · the push-in stays`].filter(Boolean).join(" · "))) ?? job;
    }
    placed = await patchJob(job.id, {
      status: "running",
      startedAt: now(),
      progress: [...bits, "Kling: preparing"].filter(Boolean).join(" · "),
    });
  } catch (error) {
    return (await failJob(job.id, message(error, "The placeholder could not be made."))) ?? job;
  }

  void runKling({ filmId: body.filmId, sectionId, insertId, jobId: job.id, secs, prompt, previewFirst: true }).catch(
    (error) => klingStopped(body.filmId, sectionId, insertId, job.id, error),
  );
  return placed;
}

async function reanimate(body: AnimateBody, tl: Timeline): Promise<Job> {
  const insertId = body.insertId!.trim();
  const sectionId = tl.section;
  const insert = tl.inserts.find((x) => x.id === insertId);
  if (!insert) throw new HttpError(404, `No insert ${insertId} in this section.`);
  if (!insert.still) throw new HttpError(422, "That insert has no still to animate.");
  const entry = tl.edl.find((e) => e.ref === insert.id);
  const secs = reanimateSecs(entry, body.secs);
  const prompt = body.prompt?.trim() || insert.prompt;
  const job = await newJob({
    filmId: body.filmId,
    section: sectionId,
    kind: "animate",
    title: `animate · ${short(prompt || insertId)}`,
    insertId,
    status: "queued",
  });
  if (!klingKey()) {
    const text = "Kling key not set";
    await markInsert(body.filmId, sectionId, insertId, job.id, { error: text });
    return (await failJob(job.id, text, `${text} · the push-in stays`)) ?? job;
  }
  const running = await patchJob(job.id, { status: "running", startedAt: now(), progress: "Kling: preparing" }).catch(
    () => job,
  );
  void runKling({ filmId: body.filmId, sectionId, insertId, jobId: job.id, secs, prompt, previewFirst: false }).catch(
    (error) => klingStopped(body.filmId, sectionId, insertId, job.id, error),
  );
  return running;
}

/** Kling in the background. Exported for tests (inject `deps`). */
export async function runKling(
  input: {
    filmId: string;
    sectionId: string;
    insertId: string;
    jobId: string;
    secs: number;
    prompt: string;
    previewFirst: boolean;
  },
  deps: RunDeps = {},
): Promise<RunOutcome> {
  const kling = deps.kling ?? klingAnimate;
  const preview = deps.preview ?? previewFor;
  const { filmId, sectionId, insertId, jobId } = input;
  if (await jobCancelled(jobId)) return "cancelled";
  if (input.previewFirst) await preview(filmId, sectionId);
  const tl = await openTimeline(filmId, sectionId);
  const insert = tl.inserts.find((x) => x.id === insertId);
  if (!insert?.still) throw new GenError("That insert has no still to animate.");
  const stillAbs = await resolveMedia(insert.still);
  if (!stillAbs) throw new GenError("The insert's still could not be read.");

  if (await jobCancelled(jobId)) return "cancelled";
  const before: InsertStatus = insert.status === "animating" ? "placeholder" : insert.status;
  await changeTimeline(filmId, sectionId, (t) => patchInsert(t, insertId, jobId, { status: "animating", error: null }));
  // On cancel the insert keeps what it showed before (the push-in or the earlier clip) — no swap.
  const stop = async (): Promise<RunOutcome> => {
    await markInsert(filmId, sectionId, insertId, jobId, { status: before, error: null });
    return "cancelled";
  };

  const dir = await ensureDir(insertDir(insertId));
  const outAbs = join(dir, `kling_${hex(3)}.mp4`);
  try {
    await kling(
      { stillAbs, outAbs, prompt: input.prompt, secs: input.secs, externalId: `vettu-${insertId}-${hex(3)}` },
      {
        onProgress: async (text) => {
          if (await jobCancelled(jobId)) throw new JobCancelledStop(); // stop polling Kling
          await patchJob(jobId, { progress: text }).catch(() => null);
        },
      },
    );
  } catch (error) {
    if (error instanceof JobCancelledStop || (await jobCancelled(jobId))) return stop();
    throw error;
  }

  if (await jobCancelled(jobId)) return stop(); // right before the swap
  await changeTimeline(filmId, sectionId, (t) =>
    patchInsert(t, insertId, jobId, { video: workMedia(outAbs), status: "ready", error: null }),
  );
  if (await jobCancelled(jobId)) return "cancelled"; // no preview
  await preview(filmId, sectionId);
  if (await jobCancelled(jobId)) return "cancelled"; // no done
  await patchJob(jobId, {
    status: "done",
    finishedAt: now(),
    progress: "Kling clip swapped in for the push-in",
    result: { media: workMedia(outAbs), note: null },
    error: null,
  });
  return "done";
}

// ── sound ────────────────────────────────────────────────────────────────────

async function startSound(body: SoundBody): Promise<Job> {
  const tl = await openTimeline(body.filmId, body.section);
  const sectionId = tl.section;
  if (resolveEntryIndex(tl, body.target) < 0) {
    throw new HttpError(404, `No shot ${body.target} in this section's edit.`);
  }
  const job = await newJob({
    filmId: body.filmId,
    section: sectionId,
    kind: "sound",
    title: `sound · ${short(body.prompt)}`,
    insertId: null,
    status: "queued",
  });
  if (!process.env.ELEVENLABS_API_KEY?.trim()) {
    return (await failJob(job.id, "ElevenLabs key not set")) ?? job;
  }
  void runSound(body, sectionId, job.id).catch(async (error) => {
    if (await jobCancelled(job.id)) return;
    await failJob(job.id, message(error, "The sound job stopped."));
  });
  return job;
}

/** ElevenLabs in the background. Exported for tests (inject `deps`). */
export async function runSound(body: SoundBody, sectionId: string, jobId: string, deps: RunDeps = {}): Promise<RunOutcome> {
  const request = deps.requestSound ?? ((input) => requestSound(input));
  const peakOf = deps.measurePeak ?? measurePeak;
  const loudnorm = deps.normalise ?? normalise;
  const preview = deps.preview ?? previewFor;

  if (await jobCancelled(jobId)) return "cancelled";
  await patchJob(jobId, { status: "running", startedAt: now(), progress: "ElevenLabs: generating" });
  const soundId = `snd_${hex(4)}`;
  const dir = await ensureDir(join(workDir(), "sounds", soundId));
  const mp3 = join(dir, "sfx.mp3");
  const wav = join(dir, "sfx.wav");
  await request({ prompt: body.prompt, duration: body.duration, outAbs: mp3 });
  if (await jobCancelled(jobId)) return "cancelled";
  await patchJob(jobId, { progress: "Measuring the loudness peak" });
  const peak = await peakOf(mp3);
  await loudnorm(mp3, wav);

  const media = workMedia(wav);
  let placed: { at: number; clamped: boolean } = { at: 0, clamped: false };
  if (await jobCancelled(jobId)) return "cancelled"; // right before the swap
  await changeTimeline(body.filmId, sectionId, (t) => {
    const idx = resolveEntryIndex(t, body.target);
    if (idx < 0) throw new GenError(`Shot ${body.target} left the edit before the sound landed.`);
    const head = entryHeads(t.edl)[idx] ?? 0;
    placed = placeByPeak(head, peak);
    const laid: LaidSound = { id: soundId, media, at: placed.at, gainDb: 0 };
    const target = t.edl[idx]!;
    return {
      ...t,
      sounds: [...t.sounds, laid],
      inserts: t.inserts.map((x) => (x.id === target.ref ? { ...x, sfx: media, jobIds: addUnique(x.jobIds, jobId) } : x)),
      jobs: addUnique(t.jobs, jobId),
    };
  });
  if (await jobCancelled(jobId)) return "cancelled"; // no preview
  await preview(body.filmId, sectionId);
  if (await jobCancelled(jobId)) return "cancelled"; // no done
  const note = `Peak at ${peak.toFixed(2)} s · laid at ${placed.at.toFixed(2)} s${placed.clamped ? " (clamped at 0, the peak lands late)" : ""}`;
  await patchJob(jobId, {
    status: "done",
    finishedAt: now(),
    progress: note,
    result: { media, note },
    error: null,
  });
  return "done";
}
