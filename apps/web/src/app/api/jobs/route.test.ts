import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.VETTU_DATA_DIR = mkdtempSync(join(tmpdir(), "vettu-jobs-route-"));
process.env.VETTU_WORK = join(process.env.VETTU_DATA_DIR, "work");
for (const k of ["KLING_API_KEY", "ELEVENLABS_API_KEY"]) delete process.env[k];

const post = (body: unknown) =>
  new Request("http://127.0.0.1:3100/api/jobs", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3100",
      origin: "http://127.0.0.1:3100",
      "content-type": "application/json",
      cookie: "vettu-session=" + "a".repeat(64),
    },
    body: JSON.stringify(body),
  });

test("cancel on a finished job → 409 'That job already finished.' and the file stays done", async () => {
  const { POST } = await import("./route");
  const { createJob, getJob, updateJob } = await import("@/lib/server/jobs");
  const job = await createJob({ filmId: "f_placeholder1", section: "s01", kind: "sound", title: "sound · placeholder", status: "running" });
  await updateJob(job.id, { status: "done" });
  const res = await POST(post({ operation: "cancel", jobId: job.id }), undefined);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "That job already finished." });
  assert.equal((await getJob(job.id))?.status, "done");

  const failed = await createJob({ filmId: "f_placeholder1", section: "s01", kind: "animate", title: "animate · placeholder" });
  await updateJob(failed.id, { status: "failed", error: "Kling key not set" });
  const again = await POST(post({ operation: "cancel", jobId: failed.id }), undefined);
  assert.equal(again.status, 409);
});

test("cancel a running job → 200 cancelled on disk; a second cancel → 409", async () => {
  const { POST } = await import("./route");
  const { createJob, getJob } = await import("@/lib/server/jobs");
  const job = await createJob({ filmId: "f_placeholder1", section: "s01", kind: "animate", title: "animate · placeholder", status: "running" });
  const res = await POST(post({ operation: "cancel", jobId: job.id }), undefined);
  assert.equal(res.status, 200);
  const { job: back } = (await res.json()) as { job: { status: string; finishedAt: string | null } };
  assert.equal(back.status, "cancelled");
  assert.ok(back.finishedAt);
  assert.equal((await getJob(job.id))?.status, "cancelled");
  const twice = await POST(post({ operation: "cancel", jobId: job.id }), undefined);
  assert.equal(twice.status, 409);
});

test("cancel an unknown job → 404", async () => {
  const { POST } = await import("./route");
  const res = await POST(post({ operation: "cancel", jobId: "job_00000000deadbeef" }), undefined);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "No such job." });
});
