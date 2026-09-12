import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "@/lib/contracts/jobs";
import {
  anyLive,
  canCancel,
  cancelledLine,
  errorLine,
  nextPollMs,
  progressLine,
  statusTone,
  STRIP_IDLE_MS,
  STRIP_MAX,
  STRIP_POLL_MS,
  stripJobs,
  titleText,
  withJob,
} from "./job-strip-logic";

const job = (n: number, extra: Partial<Job> = {}): Job => ({
  id: `job_${String(n).padStart(8, "0")}`,
  filmId: "f_placeholder",
  section: "s01",
  kind: "sound",
  status: "done",
  title: `sound · placeholder ${n}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  startedAt: null,
  finishedAt: null,
  progress: null,
  insertId: null,
  result: null,
  error: null,
  ...extra,
});

test("strip: newest first, at most 6", () => {
  const list = [1, 5, 3, 9, 2, 8, 7, 4].map((n) => job(n));
  const shown = stripJobs(list);
  assert.equal(STRIP_MAX, 6);
  assert.deepEqual(
    shown.map((j) => j.id),
    [9, 8, 7, 5, 4, 3].map((n) => job(n).id),
  );
  assert.equal(list[0]!.id, job(1).id, "the input is untouched");
});

test("poll every 3 s only while a job is queued or running", () => {
  assert.equal(anyLive([job(1), job(2, { status: "failed" }), job(3, { status: "cancelled" })]), false);
  assert.equal(nextPollMs([job(1)]), STRIP_IDLE_MS);
  assert.equal(nextPollMs([job(1), job(2, { status: "running" })]), STRIP_POLL_MS);
  assert.equal(nextPollMs([job(1, { status: "queued" })]), 3000);
  assert.equal(nextPollMs([]), STRIP_IDLE_MS);
});

test("Cancel only on non-terminal jobs", () => {
  assert.equal(canCancel({ status: "queued", kind: "sound" }), true);
  assert.equal(canCancel({ status: "running", kind: "animate" }), true);
  for (const status of ["done", "failed", "cancelled"] as const) assert.equal(canCancel({ status, kind: "sound" }), false);
});

test("no Cancel on an assembly (Director) job; a cancelled one says its child jobs keep running", () => {
  for (const status of ["queued", "running", "done", "failed", "cancelled"] as const) {
    assert.equal(canCancel({ status, kind: "assembly" }), false);
  }
  assert.equal(cancelledLine("assembly"), "Cancelled. Jobs the Director already queued keep running.");
  assert.equal(cancelledLine("animate"), "Cancelled. Nothing more lands from this job.");
  assert.equal(cancelledLine(null), "Cancelled. Nothing more lands from this job.");
});

test("tones: done ok · failed bad · cancelled off · live busy", () => {
  assert.equal(statusTone("done"), "ok");
  assert.equal(statusTone("failed"), "bad");
  assert.equal(statusTone("cancelled"), "off");
  assert.equal(statusTone("running"), "busy");
  assert.equal(statusTone("queued"), "busy");
});

test("error line: the controlled message, clipped; none for a cancelled job", () => {
  assert.equal(errorLine(job(1, { status: "failed", error: "ElevenLabs refused the sound (HTTP 401)." })), "ElevenLabs refused the sound (HTTP 401).");
  assert.equal(errorLine(job(1, { status: "failed", error: null })), null);
  assert.equal(errorLine(job(1, { status: "cancelled", error: "stalled" })), null);
  const long = errorLine(job(1, { status: "failed", error: "x".repeat(400) }));
  assert.equal(long?.length, 160);
  assert.ok(long?.endsWith("…"));
});

test("progress only while live; title drops a repeated kind prefix", () => {
  assert.equal(progressLine(job(1, { status: "running", progress: "Kling: processing (2/60 polls)" })), "Kling: processing (2/60 polls)");
  assert.equal(progressLine(job(1, { status: "done", progress: "Kling clip swapped in" })), null);
  assert.equal(titleText(job(1)), "placeholder 1");
  assert.equal(titleText(job(1, { kind: "assembly", title: "director · a placeholder brief" })), "director · a placeholder brief");
  assert.equal(titleText(job(1, { title: "" })), "sound");
});

test("withJob replaces a cancelled job in place, or adds a new one", () => {
  const list = stripJobs([job(1, { status: "running" }), job(2)]);
  const next = withJob(list, job(1, { status: "cancelled" }));
  assert.deepEqual(
    next.map((j) => [j.id, j.status]),
    [
      [job(2).id, "done"],
      [job(1).id, "cancelled"],
    ],
  );
  assert.equal(withJob(list, job(3, { status: "queued" }))[0]!.id, job(3).id);
});
