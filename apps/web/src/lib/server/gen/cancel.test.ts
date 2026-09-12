import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Insert } from "@/lib/contracts/timeline";

// roots.ts reads the env at call time, so setting it before any test runs is enough. No keys, no network.
process.env.VETTU_DATA_DIR = mkdtempSync(join(tmpdir(), "vettu-cancel-"));
process.env.VETTU_WORK = join(process.env.VETTU_DATA_DIR, "work");
for (const k of ["KLING_API_KEY", "ELEVENLABS_API_KEY", "FILM_ROOT", "FILM_REPORTS_DIR", "LABS_OUT"]) delete process.env[k];

async function placeholderFilm() {
  const { createFilm, newFilmId } = await import("../film-store");
  return createFilm({
    id: newFilmId(),
    name: "PLACEHOLDER",
    source: { kind: "new" },
    activeSection: "s01",
    targetSecs: null,
    letters: {},
    sections: [
      { id: "s01", code: "§01", name: "THE PLACEHOLDER", order: 1, targetSecs: null, cutSecs: 7, full: false, locked: false, done: 2, total: 2, parked: false, derived: true },
    ],
    cards: [1, 2].map((slot) => ({
      id: `s01/S${slot}`,
      section: "s01",
      slot,
      kind: "clip" as const,
      media: { root: "VETTU_WORK" as const, p: `missing/placeholder_${slot}.mp4` },
      poster: null,
      secs: 3.5,
      in: 0,
      out: 3.5,
      letters: [],
      caption: `placeholder shot ${slot}`,
      maker: null,
      status: "cut" as const,
      takes: [],
      reserve: false,
    })),
    sounds: [],
    plans: [],
    notes: [],
    world: { cast: [], locations: [], props: [] },
    runningCut: null,
  });
}

async function animateSetup() {
  const film = await placeholderFilm();
  const { changeTimeline, newJob, openTimeline } = await import("./bridge");
  const tl = await openTimeline(film.id, "s01");
  const insertId = `ins_${randomBytes(6).toString("hex")}`;
  const dir = join(process.env.VETTU_WORK!, "inserts", insertId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "still.png"), Buffer.from("placeholder still"));
  const pushin = { root: "VETTU_WORK" as const, p: `inserts/${insertId}/pushin.mp4` };
  const insert: Insert = {
    id: insertId,
    prompt: "placeholder insert",
    still: { root: "VETTU_WORK", p: `inserts/${insertId}/still.png` },
    video: pushin,
    sfx: null,
    temp: true,
    status: "placeholder",
    jobIds: [],
    error: null,
  };
  await changeTimeline(film.id, tl.section, (t) => ({ ...t, inserts: [...t.inserts, insert] }));
  const job = await newJob({ filmId: film.id, section: tl.section, kind: "animate", title: "animate · placeholder", insertId, status: "running" });
  const input = { filmId: film.id, sectionId: tl.section, insertId, jobId: job.id, secs: 5, prompt: "placeholder", previewFirst: false };
  return { film, sectionId: tl.section, insertId, job, pushin, input };
}

function previewCounter() {
  const calls: string[] = [];
  const preview = async (_filmId: string, sectionId: string) => {
    calls.push(sectionId);
    return null;
  };
  return { calls, preview };
}

test("animate: cancelled while Kling polls → polling stops, no swap, no preview, no done", async () => {
  const { cancelJob } = await import("../jobs");
  const { openTimeline, readJob } = await import("./bridge");
  const { runKling } = await import("./start");
  const s = await animateSetup();
  const p = previewCounter();
  let pollsAfterCancel = 0;
  const outcome = await runKling(s.input, {
    preview: p.preview,
    kling: async (input, deps) => {
      await deps?.onProgress?.("Kling: submitted");
      await cancelJob(s.job.id); // the user clicks Cancel mid-run
      await deps?.onProgress?.("Kling: processing (1/60 polls)");
      pollsAfterCancel += 1;
      return { taskId: "task_placeholder", path: input.outAbs };
    },
  });
  assert.equal(outcome, "cancelled");
  assert.equal(pollsAfterCancel, 0, "the progress callback stopped the poll loop");
  const t = await openTimeline(s.film.id, s.sectionId);
  const ins = t.inserts.find((x) => x.id === s.insertId)!;
  assert.deepEqual(ins.video, s.pushin, "the push-in stays");
  assert.equal(ins.status, "placeholder", "the insert is not left animating");
  assert.equal(p.calls.length, 0);
  const job = await readJob(s.job.id);
  assert.equal(job?.status, "cancelled");
  assert.equal(job?.result, null);
});

test("animate: cancel lands as Kling finishes → the re-read before the swap stops it", async () => {
  const { cancelJob } = await import("../jobs");
  const { openTimeline, readJob } = await import("./bridge");
  const { runKling } = await import("./start");
  const s = await animateSetup();
  const p = previewCounter();
  const outcome = await runKling(s.input, {
    preview: p.preview,
    kling: async (input) => {
      await cancelJob(s.job.id);
      return { taskId: "task_placeholder", path: input.outAbs };
    },
  });
  assert.equal(outcome, "cancelled");
  const ins = (await openTimeline(s.film.id, s.sectionId)).inserts.find((x) => x.id === s.insertId)!;
  assert.deepEqual(ins.video, s.pushin);
  assert.equal(p.calls.length, 0);
  assert.equal((await readJob(s.job.id))?.status, "cancelled");
});

test("animate control: not cancelled → the clip swaps in, one preview, done", async () => {
  const { openTimeline, readJob } = await import("./bridge");
  const { runKling } = await import("./start");
  const s = await animateSetup();
  const p = previewCounter();
  const outcome = await runKling(s.input, {
    preview: p.preview,
    kling: async (input) => ({ taskId: "task_placeholder", path: input.outAbs }),
  });
  assert.equal(outcome, "done");
  const ins = (await openTimeline(s.film.id, s.sectionId)).inserts.find((x) => x.id === s.insertId)!;
  assert.match("p" in ins.video! ? ins.video.p : "", /^inserts\/ins_[a-f0-9]+\/kling_[a-f0-9]+\.mp4$/);
  assert.equal(ins.status, "ready");
  assert.equal(p.calls.length, 1);
  assert.equal((await readJob(s.job.id))?.status, "done");
});

test("sound: cancelled while ElevenLabs generates → nothing laid, no preview, no done", async () => {
  const film = await placeholderFilm();
  const { cancelJob } = await import("../jobs");
  const { newJob, openTimeline, readJob } = await import("./bridge");
  const { runSound } = await import("./start");
  const tl = await openTimeline(film.id, "s01");
  const job = await newJob({ filmId: film.id, section: tl.section, kind: "sound", title: "sound · placeholder" });
  const p = previewCounter();
  let measured = 0;
  const body = { kind: "sound" as const, filmId: film.id, section: tl.section, target: "S2", prompt: "a placeholder click", duration: 2 };
  const outcome = await runSound(body, tl.section, job.id, {
    preview: p.preview,
    requestSound: async () => {
      await cancelJob(job.id);
    },
    measurePeak: async () => {
      measured += 1;
      return 0.5;
    },
    normalise: async () => undefined,
  });
  assert.equal(outcome, "cancelled");
  assert.equal(measured, 0);
  assert.equal((await openTimeline(film.id, tl.section)).sounds.length, 0);
  assert.equal(p.calls.length, 0);
  const after = await readJob(job.id);
  assert.equal(after?.status, "cancelled");
  assert.equal(after?.progress, "Cancelled");
});

test("sound control: not cancelled → laid by its peak, one preview, done", async () => {
  const film = await placeholderFilm();
  const { newJob, openTimeline, readJob } = await import("./bridge");
  const { runSound } = await import("./start");
  const tl = await openTimeline(film.id, "s01");
  const job = await newJob({ filmId: film.id, section: tl.section, kind: "sound", title: "sound · placeholder" });
  const p = previewCounter();
  const body = { kind: "sound" as const, filmId: film.id, section: tl.section, target: "S2", prompt: "a placeholder click", duration: 2 };
  const outcome = await runSound(body, tl.section, job.id, {
    preview: p.preview,
    requestSound: async () => undefined,
    measurePeak: async () => 0.5,
    normalise: async () => undefined,
  });
  assert.equal(outcome, "done");
  assert.equal((await openTimeline(film.id, tl.section)).sounds.length, 1);
  assert.equal(p.calls.length, 1);
  assert.equal((await readJob(job.id))?.status, "done");
});

test("cancelled is sticky on disk: a late background patch cannot flip it to done", async () => {
  const film = await placeholderFilm();
  const { cancelJob } = await import("../jobs");
  const { newJob, patchJob, readJob } = await import("./bridge");
  const job = await newJob({ filmId: film.id, section: "s01", kind: "sound", title: "sound · placeholder", status: "running" });
  await cancelJob(job.id);
  const back = await patchJob(job.id, { status: "done", progress: "late", error: null });
  assert.equal(back.status, "cancelled");
  assert.equal((await readJob(job.id))?.status, "cancelled");
});
