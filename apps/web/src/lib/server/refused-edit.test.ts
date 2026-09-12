import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Card, Film } from "@/lib/contracts/film";

process.env.VETTU_DATA_DIR = mkdtempSync(join(tmpdir(), "vettu-refused-"));
for (const k of ["FILM_ROOT", "FILM_REPORTS_DIR", "LABS_OUT", "VETTU_WORK"]) delete process.env[k];

function card(slot: number): Card {
  return {
    id: `s_one/S${slot}`,
    section: "s_one",
    slot,
    kind: "clip",
    media: { root: "FILM_ROOT", p: `clips/placeholder_${slot}.mp4` },
    poster: null,
    secs: 4,
    in: 0,
    out: 4,
    letters: [],
    caption: `placeholder ${slot}`,
    maker: null,
    status: "locked",
    takes: [],
    reserve: false,
    inCut: null,
    cutIn: null,
    cutOut: null,
  };
}

function placeholderFilm(id: string): Omit<Film, "rev" | "createdAt" | "updatedAt"> {
  return {
    id,
    name: "Placeholder Film",
    source: { kind: "new" },
    activeSection: "s_one",
    letters: {},
    sections: [
      { id: "s_one", code: "§01", name: "THE ONE", order: 1, targetSecs: null, cutSecs: 0, full: false, locked: false, done: 0, total: 0, parked: false, derived: true },
    ],
    cards: [card(1), card(2), card(3)],
    sounds: [],
    plans: [],
    notes: [],
    world: { cast: [], locations: [], props: [] },
    runningCut: null,
  };
}

/** A plain reason: no path, no stack, no provider or class name. */
const plain = (m: string) => !/[\\/]{1}\w|Error|at \w+ \(|undefined|NaN/.test(m);

const refused = (status: number, text: RegExp) => (e: unknown) => {
  const err = e as { status?: number; message?: string };
  assert.equal(err.status, status);
  assert.match(err.message ?? "", text);
  assert.ok(plain(err.message ?? ""), `not plain: ${err.message}`);
  return true;
};

test("impossible trims, moves and transitions are refused with a plain 422 reason", async () => {
  const { createFilm } = await import("./film-store");
  const T = await import("./timeline");
  const film = await createFilm(placeholderFilm("f_refu0001"));
  const t = await T.seedTimeline(film, film.sections[0], async () => ({ duration: 7, width: 1920, height: 1080, fps: 24, hasAudio: false }));

  assert.throws(() => T.applyTrim(t, { shot: "S1", delta: 5 }), refused(422, /^S1: the clip is only 7 s long\.$/));
  assert.throws(() => T.applyTrim(t, { shot: "S1", in: 4 }), refused(422, /^S1: the out point must come after the in point\.$/));
  assert.throws(() => T.applyTrim(t, { shot: "S9", delta: 1 }), refused(422, /^There is no shot S9 in this edit\.$/));
  assert.throws(() => T.applyMove(t, { shot: "S1", index: 9 }), refused(422, /^There is no position #10; the edit has 3 entries\.$/));
  assert.throws(
    () => T.applyTransition(t, { index: 1, type: "fade", dur: 5 }),
    refused(422, /^S1 is shorter than the fade after it \(5 s\)\.$/),
  );
  assert.throws(() => T.applyTransition(t, { index: 3, type: "fade", dur: 0.5 }), refused(422, /^There is no entry 3 to lead into\./));
});

test("the refusal reaches the chat tool as { status: 'error', message } with the same plain reason", async () => {
  const { createFilm } = await import("./film-store");
  const { POST } = await import("@/app/api/cut/trim/route");
  const { ApiError, createApiClient } = await import("@/lib/api-client");
  const { errorMessage, fail } = await import("@/lib/tool-run");
  await createFilm(placeholderFilm("f_refu0002"));

  const headers = {
    host: "127.0.0.1:3100",
    origin: "http://127.0.0.1:3100",
    "content-type": "application/json",
    cookie: "vettu-session=" + "a".repeat(64),
  };
  const request = createApiClient(async (url, init) => {
    if (url.startsWith("/api/films?session=1")) return Response.json({ status: "ready" });
    assert.equal(url, "/api/cut/trim");
    return POST(new Request(`http://127.0.0.1:3100${url}`, { method: init?.method, headers, body: init?.body as string }), undefined);
  });

  // Without a probe the seeded clip holds out + 30 s (34 s); out 99 is past it.
  const run = async () => {
    try {
      await request("/cut/trim", { body: { filmId: "f_refu0002", section: "s_one", shot: "S1", out: 99 } });
      return { status: "ok" as const, message: "trimmed" };
    } catch (error) {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 422);
      return fail(errorMessage(error)); // exactly what vettu-control's useVettuTool handler returns
    }
  };
  assert.deepEqual(await run(), { status: "error", message: "S1: the clip is only 34 s long." });
});
