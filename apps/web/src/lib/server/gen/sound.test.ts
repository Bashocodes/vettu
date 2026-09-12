import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { entryHeads, placeByPeak } from "./placement";
import { ELEVEN_URL, elevenBody, parseRmsPeak, peakArgs, requestSound } from "./sound";

// roots.ts reads the env at call time, so setting it before any test runs is enough.
const base = mkdtempSync(join(tmpdir(), "vettu-sound-"));
process.env.VETTU_DATA_DIR = base;
delete process.env.VETTU_WORK;

test("ElevenLabs body: text, clamped duration, v2 model", () => {
  assert.deepEqual(elevenBody("  close · clear · crisp latch  ", 2.345), {
    text: "close · clear · crisp latch",
    duration_seconds: 2.3,
    model_id: "eleven_text_to_sound_v2",
  });
  assert.equal(elevenBody("abc", 45).duration_seconds, 30);
  assert.equal(elevenBody("abc", 0.1).duration_seconds, 0.5);
});

test("requestSound posts with xi-api-key and writes the mp3", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(new Uint8Array(4096), { headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch;
  const out = join(base, "work", "sfx.mp3");
  await mkdir(join(base, "work"), { recursive: true });
  await requestSound({ prompt: "close · clear · crisp latch", duration: 2, outAbs: out }, { fetch: f, key: "el-test" });
  assert.equal(calls[0]!.url, ELEVEN_URL);
  assert.equal(calls[0]!.init?.method, "POST");
  assert.equal((calls[0]!.init?.headers as Record<string, string>)["xi-api-key"], "el-test");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    text: "close · clear · crisp latch",
    duration_seconds: 2,
    model_id: "eleven_text_to_sound_v2",
  });
  assert.equal((await stat(out)).size, 4096);
  await assert.rejects(requestSound({ prompt: "abc", duration: 1, outAbs: out }, { key: null }), /ElevenLabs key not set/);
  const refusing = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  await assert.rejects(
    requestSound({ prompt: "abc", duration: 1, outAbs: out }, { fetch: refusing, key: "k" }),
    /HTTP 401/,
  );
});

test("the RMS peak is the pts_time of the loudest frame", () => {
  const text = [
    "frame:0    pts:0       pts_time:0",
    "lavfi.astats.Overall.RMS_level=-inf",
    "frame:1    pts:2400    pts_time:0.05",
    "lavfi.astats.Overall.RMS_level=-47.1",
    "frame:25   pts:60000   pts_time:1.25",
    "lavfi.astats.Overall.RMS_level=-12.5",
    "frame:26   pts:62400   pts_time:1.3",
    "lavfi.astats.Overall.RMS_level=-18.0",
  ].join("\n");
  assert.equal(parseRmsPeak(text), 1.25);
  assert.equal(parseRmsPeak(""), null);
  assert.ok(peakArgs("in.mp3").includes("-f"));
});

test("peak placement: the peak lands on the target shot's head", () => {
  const cut = { type: "cut" as const, dur: 0 };
  const heads = entryHeads([
    { in: 0, out: 3, transition: cut },
    { in: 0, out: 4, transition: cut },
  ]);
  assert.deepEqual(placeByPeak(heads[1]!, 1.25), { at: 1.75, clamped: false });
  assert.deepEqual(placeByPeak(heads[0]!, 1.25), { at: 0, clamped: true });
});
