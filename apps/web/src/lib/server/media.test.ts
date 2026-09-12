import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

let work = "";
let media: typeof import("./media");
let route: typeof import("../../app/api/media/route");

before(async () => {
  const base = await mkdtemp(join(tmpdir(), "vettu-media-"));
  work = join(base, "work");
  const outside = join(base, "outside");
  await mkdir(join(work, "sub"), { recursive: true });
  await mkdir(outside);
  process.env.VETTU_WORK = work;
  process.env.VETTU_DATA_DIR = join(base, "data");
  delete process.env.FILM_REPORTS_DIR;
  delete process.env.FILM_ROOT;
  delete process.env.LABS_OUT;
  await writeFile(join(work, "clip.mp4"), Buffer.from(Array.from({ length: 100 }, (_, i) => i)));
  await writeFile(join(work, "sub", "a b.png"), "png");
  await writeFile(join(work, "notes.json"), "{}");
  await writeFile(join(work, ".hidden.png"), "x");
  await writeFile(join(outside, "secret.png"), "s");
  await symlink(join(outside, "secret.png"), join(work, "link.png"));
  media = await import("./media");
  route = await import("../../app/api/media/route");
});

const get = (qs: string, headers: Record<string, string> = {}, method = "GET") => {
  const url = new URL(`http://127.0.0.1:3100/api/media?${qs}`);
  return media.serveMedia(new Request(url, { method, headers }), url);
};

test("parseRange: single ranges, suffix, clamp, invalid → 416, multi → whole file", () => {
  assert.equal(media.parseRange(null, 100), null);
  assert.deepEqual(media.parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(media.parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(media.parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(media.parseRange("bytes=50-500", 100), { start: 50, end: 99 });
  assert.equal(media.parseRange("bytes=100-", 100), "invalid");
  assert.equal(media.parseRange("bytes=20-10", 100), "invalid");
  assert.equal(media.parseRange("bytes=-0", 100), "invalid");
  assert.equal(media.parseRange("items=0-1", 100), "invalid");
  assert.equal(media.parseRange("bytes=0-1,5-6", 100), null);
});

test("parseMediaQuery: shapes and refusals", () => {
  const q = (s: string) => media.parseMediaQuery(new URLSearchParams(s));
  assert.deepEqual(q("root=VETTU_WORK&p=clip.mp4"), {
    ok: true,
    ref: { root: "VETTU_WORK", p: "clip.mp4" },
    rel: "clip.mp4",
  });
  const board = q(`src=${encodeURIComponent("../film/a%20b.mp4")}`);
  assert.deepEqual(board, { ok: true, ref: { src: "../film/a%20b.mp4" }, rel: "../film/a b.mp4" });
  assert.deepEqual(q("root=NOPE&p=a.mp4"), { ok: false, status: 400 });
  assert.deepEqual(q("p=a.mp4"), { ok: false, status: 400 });
  assert.deepEqual(q("src=a.mp4&root=VETTU_WORK&p=a.mp4"), { ok: false, status: 400 });
  assert.deepEqual(q("root=VETTU_WORK&p=%252e%252e%2Fx.mp4"), { ok: false, status: 403 });
  assert.deepEqual(q("root=VETTU_WORK&p=notes.json"), { ok: false, status: 403 });
  assert.deepEqual(q("root=VETTU_WORK&p=page.html"), { ok: false, status: 403 });
  assert.deepEqual(q("root=VETTU_WORK&p=.hidden.png"), { ok: false, status: 403 });
  assert.deepEqual(q("root=VETTU_WORK&p=%2Fetc%2Fx.png"), { ok: false, status: 403 });
  assert.deepEqual(q("root=VETTU_WORK&p=a%00.png"), { ok: false, status: 403 });
  assert.deepEqual(q("root=VETTU_WORK&p=%25E0%25A4%25A.png"), { ok: false, status: 403 });
});

test("serves: 200 whole · 206 range · 416 · HEAD · content types", async () => {
  let res = await get("root=VETTU_WORK&p=clip.mp4");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "video/mp4");
  assert.equal(res.headers.get("content-length"), "100");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("cache-control"), "private, max-age=60");
  assert.equal((await res.arrayBuffer()).byteLength, 100);

  res = await get("root=VETTU_WORK&p=clip.mp4", { range: "bytes=10-19" });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 10-19/100");
  assert.equal(res.headers.get("content-length"), "10");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

  res = await get("root=VETTU_WORK&p=clip.mp4", { range: "bytes=500-" });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get("content-range"), "bytes */100");

  res = await get("root=VETTU_WORK&p=clip.mp4", {}, "HEAD");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), "100");
  assert.equal(await res.text(), "");

  res = await get(`root=VETTU_WORK&p=${encodeURIComponent("sub/a%20b.png")}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});

test("refuses escapes (403) and missing files (404) without leaking paths", async () => {
  const cases: [string, number][] = [
    ["root=VETTU_WORK&p=..%2Foutside%2Fsecret.png", 403],
    ["root=VETTU_WORK&p=sub%2F..%2F..%2Foutside%2Fsecret.png", 403],
    ["root=VETTU_WORK&p=link.png", 403],
    ["root=VETTU_WORK&p=notes.json", 403],
    ["root=VETTU_WORK&p=missing.mp4", 404],
    ["root=FILM_ROOT&p=a.mp4", 404],
    ["src=a.mp4", 404],
  ];
  for (const [qs, expected] of cases) {
    const res = await get(qs);
    assert.equal(res.status, expected, qs);
    const text = await res.text();
    assert.ok(!text.includes(work), "no filesystem path in the reply");
  }
});

test("route: GET and HEAD through the read guard", async () => {
  const headers = { host: "127.0.0.1:3100" };
  let res = await route.GET(new Request("http://127.0.0.1:3100/api/media?root=VETTU_WORK&p=clip.mp4", { headers }), undefined);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("set-cookie")?.startsWith("vettu-session="));
  await res.arrayBuffer();
  res = await route.HEAD(
    new Request("http://127.0.0.1:3100/api/media?root=VETTU_WORK&p=clip.mp4", { method: "HEAD", headers }),
    undefined,
  );
  assert.equal(res.status, 200);
  res = await route.GET(new Request("http://evil.example/api/media?root=VETTU_WORK&p=clip.mp4", { headers: { host: "evil.example" } }), undefined);
  assert.equal(res.status, 403);
});
