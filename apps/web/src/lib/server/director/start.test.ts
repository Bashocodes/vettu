import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Job, JobCreateBody } from "@/lib/contracts/jobs";

// roots.ts reads the env at call time, so setting it before any test runs is enough.
process.env.VETTU_DATA_DIR = mkdtempSync(join(tmpdir(), "vettu-director-"));
process.env.VETTU_WORK = join(process.env.VETTU_DATA_DIR, "work");
delete process.env.ANTHROPIC_API_KEY;

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

test("no Anthropic key → the server queue lays one add_sound and the Director job finishes", async () => {
  const film = await placeholderFilm();
  const { openTimeline, newJob, readJob } = await import("../gen/bridge");
  const { runDirector } = await import("./start");
  const tl = await openTimeline(film.id, "s01");
  assert.equal(tl.edl.length, 2);
  const director = await newJob({ filmId: film.id, section: tl.section, kind: "assembly", title: "director · placeholder" });

  const bodies: JobCreateBody[] = [];
  const startJob = async (body: JobCreateBody): Promise<Job> => {
    bodies.push(body);
    return { ...director, id: "job_0000feed", kind: body.kind, status: "failed", error: "ElevenLabs key not set", title: "sound" };
  };
  await runDirector({ filmId: film.id, section: "s01", brief: "a latch clicks on S2" }, tl, director.id, startJob);

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.kind, "sound");
  assert.equal(bodies[0]!.kind === "sound" ? bodies[0]!.target : null, "S2");
  const done = await readJob(director.id);
  assert.equal(done?.status, "done");
  assert.match(done?.progress ?? "", /^Server queue \(no Anthropic key\): sound job_0000feed on S2 \(failed: ElevenLabs key not set\)/);
  assert.equal(done?.result?.note, done?.progress);
});

test("startDirector returns the assembly job id at once", async () => {
  const film = await placeholderFilm();
  const { readJob } = await import("../gen/bridge");
  const { startDirector } = await import("./start");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { jobId } = await startDirector({ filmId: film.id, section: "§01", brief: "placeholder brief words" }, async (body) => {
    await gate; // the queued job is still "starting" when startDirector has already returned
    throw new Error(`not started ${body.kind}`);
  });
  const job = await readJob(jobId);
  assert.equal(job?.kind, "assembly");
  assert.match(job?.title ?? "", /^director · placeholder brief words/);
  release();
  for (let i = 0; i < 50; i++) {
    const j = await readJob(jobId);
    if (j && j.status !== "queued" && j.status !== "running") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const final = await readJob(jobId);
  assert.equal(final?.status, "failed");
  assert.match(final?.progress ?? "", /sound refused · could not start/);
});
