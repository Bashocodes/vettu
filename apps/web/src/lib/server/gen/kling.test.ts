import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KLING_BASE, klingAnimate, klingPrompt, klingSubmitBody, parseKlingSubmit, parseKlingTask } from "./kling";

// roots.ts reads the env at call time, so setting it before any test runs is enough.
const base = mkdtempSync(join(tmpdir(), "vettu-kling-"));
process.env.VETTU_DATA_DIR = base;
delete process.env.VETTU_WORK;

type Call = { url: string; init?: RequestInit };

function fakeFetch(replies: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected fetch");
    return reply(call);
  }) as typeof fetch;
  return { f, calls };
}

async function still() {
  const dir = join(base, "work", "inserts", "ins_aaaaaa");
  await mkdir(dir, { recursive: true });
  const p = join(dir, "still.png");
  await writeFile(p, Buffer.from("fake-png-bytes"));
  return { dir, p };
}

test("submit id: data.id, data.task_id, or nested", () => {
  assert.equal(parseKlingSubmit({ code: 0, data: { id: "t1" } }), "t1");
  assert.equal(parseKlingSubmit({ data: { task_id: "t2" } }), "t2");
  assert.equal(parseKlingSubmit({ result: { deep: { taskId: "t3" } } }), "t3");
  assert.equal(parseKlingSubmit({ data: {} }), null);
});

test("poll parsing: status + https video url", () => {
  assert.deepEqual(parseKlingTask({ data: [{ id: "t1", status: "processing" }] }), { status: "processing", videoUrl: null });
  assert.deepEqual(
    parseKlingTask({ data: [{ id: "t1", status: "succeeded", outputs: [{ type: "video", url: "https://cdn.example/v.mp4" }] }] }),
    { status: "succeeded", videoUrl: "https://cdn.example/v.mp4" },
  );
  assert.equal(parseKlingTask({ data: [{ status: "succeeded", outputs: [{ type: "video", url: "http://x/v.mp4" }] }] }).videoUrl, null);
  assert.equal(parseKlingTask({ data: [{ status: "failed" }] }).status, "failed");
  assert.equal(parseKlingTask(null).status, "unknown");
});

test("the prompt keeps beat order and forbids the travel move", () => {
  const p = klingPrompt("a hand lifts the lantern.");
  assert.match(p, /^a hand lifts the lantern\. Beat order/);
  assert.match(p, /no travel move until that action has finished/);
  const body = klingSubmitBody({ imageB64: "AAAA", prompt: "x y z", duration: 5, externalId: "vettu-1" }) as {
    contents: Array<{ type: string; url?: string }>;
    settings: Record<string, unknown>;
  };
  assert.equal(body.contents[1]!.type, "first_frame");
  assert.equal(body.settings.audio, "off");
});

test("submit → poll → download with a mocked fetch", async () => {
  const { dir, p } = await still();
  const out = join(dir, "kling.mp4");
  const { f, calls } = fakeFetch([
    () => Response.json({ code: 0, data: { id: "task_abc" } }),
    () => Response.json({ data: [{ id: "task_abc", status: "processing" }] }),
    () => Response.json({ data: [{ id: "task_abc", status: "succeeded", outputs: [{ type: "video", url: "https://cdn.example/v.mp4" }] }] }),
    () => new Response(new Uint8Array(2048)),
  ]);
  const progress: string[] = [];
  const result = await klingAnimate(
    { stillAbs: p, outAbs: out, prompt: "a hand lifts the lantern", secs: 3, externalId: "vettu-test" },
    { fetch: f, key: "test-key", sleep: async () => {}, onProgress: (t) => void progress.push(t) },
  );
  assert.equal(result.taskId, "task_abc");
  assert.equal(calls[0]!.url, `${KLING_BASE}/image-to-video/kling-3.0`);
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal((calls[0]!.init?.headers as Record<string, string>).Authorization, "Bearer test-key");
  const body = JSON.parse(String(calls[0]!.init?.body)) as {
    contents: Array<{ type: string; url?: string; text?: string }>;
    settings: { duration: number; audio: string };
    options: { external_task_id: string };
  };
  assert.equal(body.contents[0]!.type, "prompt");
  assert.equal(body.contents[1]!.url, Buffer.from("fake-png-bytes").toString("base64"));
  assert.equal(body.settings.duration, 5);
  assert.equal(body.options.external_task_id, "vettu-test");
  assert.equal(calls[1]!.url, `${KLING_BASE}/tasks?task_ids=task_abc`);
  assert.equal(calls[3]!.url, "https://cdn.example/v.mp4");
  assert.equal((await stat(out)).size, 2048);
  assert.ok(progress.some((t) => /processing \(1\/60 polls\)/.test(t)));
  assert.equal((await readFile(out)).byteLength, 2048);
});

test("no key → Kling key not set; a failed task → controlled error", async () => {
  const { dir, p } = await still();
  await assert.rejects(
    klingAnimate({ stillAbs: p, outAbs: join(dir, "k.mp4"), prompt: "x", secs: 3, externalId: "e" }, { key: null }),
    /Kling key not set/,
  );
  const { f } = fakeFetch([
    () => Response.json({ data: { task_id: "t9" } }),
    () => Response.json({ data: [{ id: "t9", status: "failed", message: "secret provider text" }] }),
  ]);
  await assert.rejects(
    klingAnimate(
      { stillAbs: p, outAbs: join(dir, "k.mp4"), prompt: "x", secs: 3, externalId: "e" },
      { fetch: f, key: "k", sleep: async () => {} },
    ),
    (error: Error) => error.message === "Kling failed the job.",
  );
});
