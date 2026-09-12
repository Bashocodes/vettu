import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enqueueReview } from "@/lib/server/review-queue";
import * as postedRoute from "./posted/route";
import * as queueRoute from "./queue/route";

process.env.VETTU_DATA_DIR = mkdtempSync(join(tmpdir(), "vettu-review-"));

const req = (path: string, init: { method?: string; origin?: string | null; body?: unknown } = {}) => {
  const headers: Record<string, string> = { host: "127.0.0.1:3100", "content-type": "application/json" };
  if (init.origin !== null) headers.origin = init.origin ?? "http://127.0.0.1:3100";
  return new Request(`http://127.0.0.1:3100/api/review/${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
};

test("service routes refuse a foreign Origin", async () => {
  const res = await queueRoute.GET(req("queue", { origin: "http://evil.example" }), undefined);
  assert.equal(res.status, 403);
  const posted = await postedRoute.POST(req("posted", { method: "POST", origin: "http://evil.example", body: { cutId: "f_x00001:s1:v1" } }), undefined);
  assert.equal(posted.status, 403);
});

test("queue lists unposted cuts oldest first; posted is idempotent", async () => {
  await enqueueReview({ cutId: "f_rev0001:s_one:v1", version: 1, title: "A · §01 ONE · v1", previewPath: "/placeholder/a.mp4" });
  await enqueueReview({ cutId: "f_rev0001:s_one:v2", version: 2, title: "A · §01 ONE · v2", previewPath: "/placeholder/b.mp4" });
  const first = await (await queueRoute.GET(req("queue", { origin: null }), undefined)).json();
  assert.deepEqual(first.map((q: { version: number }) => q.version), [1, 2]);
  for (let i = 0; i < 2; i++) {
    const r = await postedRoute.POST(req("posted", { method: "POST", origin: null, body: { cutId: "f_rev0001:s_one:v1" } }), undefined);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  }
  const after = await (await queueRoute.GET(req("queue", { origin: null }), undefined)).json();
  assert.deepEqual(after.map((q: { version: number }) => q.version), [2]);
  const missing = await postedRoute.POST(req("posted", { method: "POST", origin: null, body: { cutId: "f_rev0001:s_one:v9" } }), undefined);
  assert.equal(missing.status, 404);
});
