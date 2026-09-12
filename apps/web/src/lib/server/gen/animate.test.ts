import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Insert, Timeline } from "@/lib/contracts/timeline";
import { HttpError } from "../guard";
import { jobCreateBody } from "@/lib/contracts/jobs";
import { animateAfter, checkAnimateBody, DRAW_OFF_MESSAGE, reanimateSecs, stillSourceFor } from "./animate";
import { klingDuration } from "./kling";
import { placeInsert } from "./placement";
import { startGeneratorJob } from "./start";

// roots.ts reads the env at call time; nothing here should touch the disk anyway.
process.env.VETTU_DATA_DIR = mkdtempSync(join(tmpdir(), "vettu-animate-"));
delete process.env.VETTU_WORK;

const fixture = (): Timeline =>
  JSON.parse(readFileSync(new URL("../../contracts/fixtures/timeline.json", import.meta.url), "utf8")) as Timeline;

const insert = (id = "ins_abc123"): Insert => ({
  id,
  prompt: "placeholder insert",
  still: { root: "VETTU_WORK", p: `inserts/${id}/still.png` },
  video: { root: "VETTU_WORK", p: `inserts/${id}/pushin.mp4` },
  sfx: null,
  temp: true,
  status: "placeholder",
  jobIds: ["job_1"],
  error: null,
});

test("animate body: one of fromShot / insertId is required", () => {
  assert.equal(checkAnimateBody({ fromShot: "S3" }), "fromShot");
  assert.equal(checkAnimateBody({ insertId: "ins_abc123" }), "insertId");
  assert.equal(checkAnimateBody({ fromShot: "S3", insertId: "ins_abc123" }), "insertId");
  assert.throws(
    () => checkAnimateBody({}),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
  assert.throws(
    () => checkAnimateBody({ fromShot: "  " }),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});

test("startGeneratorJob: animate without a shot or insert → 400 before any I/O", async () => {
  await assert.rejects(
    startGeneratorJob({ kind: "animate", filmId: "f_nosuchfilm", section: "s04", secs: 5 }),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});

test("draw is OFF → 503 with the plain reason", async () => {
  await assert.rejects(
    startGeneratorJob({ kind: "draw", filmId: "f_nosuchfilm", section: "s04", prompt: "placeholder", refShots: [], secs: 3 }),
    (error: unknown) => error instanceof HttpError && error.status === 503 && error.message === DRAW_OFF_MESSAGE,
  );
});

test("the new insert lands right after fromShot by default, or after afterShot", () => {
  const t = fixture();
  assert.equal(animateAfter(t, "S3"), "e3");
  assert.equal(animateAfter(t, "3"), "e3");
  assert.equal(animateAfter(t, "S3", "S6"), "S6");
  assert.equal(animateAfter(t, "S99"), undefined);

  const p = placeInsert(t, insert(), 5, animateAfter(t, "S3"));
  assert.equal(p.index, 3);
  const e = p.timeline.edl[3]!;
  assert.deepEqual({ ref: e.ref, temp: e.temp, change: e.change, in: e.in, out: e.out }, {
    ref: "ins_abc123",
    temp: true,
    change: "new",
    in: 0,
    out: 5,
  });
  assert.equal(p.timeline.edl[4]!.ref, "S4");

  const later = placeInsert(t, insert(), 5, animateAfter(t, "S3", "S6"));
  assert.equal(later.index, 6);
  assert.equal(later.timeline.edl[5]!.ref, "S6");
});

test("re-animate never asks Kling for a clip shorter than the insert's entry", () => {
  // The route and the Director both parse through jobCreateBody, which always fills secs = 5.
  const parsed = jobCreateBody.parse({ kind: "animate", filmId: "f_placeholder", section: "s04", insertId: "ins_abc123" });
  assert.equal(parsed.kind === "animate" ? parsed.secs : null, 5);

  const six = { in: 0, out: 6 };
  assert.equal(reanimateSecs(six, 5), 6, "a 6 s entry beats the filled default");
  assert.equal(klingDuration(reanimateSecs(six, 5)), 10, "so Kling is asked for 10 s");
  assert.equal(reanimateSecs({ in: 1.5, out: 4 }, 5), 5, "a short entry keeps the asked secs");
  assert.equal(reanimateSecs({ in: 0, out: 5.042 }, 3), 5.042);
  assert.equal(klingDuration(reanimateSecs({ in: 0, out: 5.042 }, 3)), 10);
  assert.equal(reanimateSecs(six, 8), 8, "a longer ask is kept");
  assert.equal(reanimateSecs(undefined, 7), 7, "no entry: the asked secs");
  assert.equal(reanimateSecs(undefined), 5, "no entry, no secs: the default");
});

test("the still frame: `at` is seconds into the entry, mapped to clip time", () => {
  const t = fixture();
  const e = t.edl[2]!; // e3 · S3 · 0–5.042 on a 5.542 s clip
  const mid = stillSourceFor(t, 2);
  assert.equal(mid?.still, false);
  assert.equal(mid?.at, Math.round(((e.out - e.in) / 2 + e.in) * 1000) / 1000);
  assert.equal(stillSourceFor(t, 2, 1)?.at, 1);

  t.edl[2] = { ...e, in: 1.5, out: 4 };
  assert.equal(stillSourceFor(t, 2, 1)?.at, 2.5, "entry.in + at");
  assert.equal(stillSourceFor(t, 2, 99)?.at, 4, "clamped to the entry's out");
  assert.equal(stillSourceFor(t, 2)?.at, 2.75, "default: the entry's middle");

  const clip = t.clips.find((c) => c.id === t.shots.find((s) => s.id === "S3")!.clipId)!;
  clip.media = { root: "FILM_ROOT", p: "cards/placeholder.png" };
  assert.deepEqual(stillSourceFor(t, 2, 1), { media: clip.media, at: 0, still: true }, "an image card is used whole");
  assert.equal(stillSourceFor(t, 99), null);
});
