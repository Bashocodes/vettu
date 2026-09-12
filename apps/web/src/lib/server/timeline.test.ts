import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Card, Film } from "@/lib/contracts/film";
import type { Timeline } from "@/lib/contracts/timeline";
import { createFilm } from "./film-store";
import * as T from "./timeline";

process.env.VETTU_DATA_DIR = mkdtempSync(join(tmpdir(), "vettu-timeline-"));
for (const k of ["FILM_ROOT", "FILM_REPORTS_DIR", "LABS_OUT", "VETTU_WORK"]) delete process.env[k];

function card(slot: number, extra: Partial<Card> = {}): Card {
  return {
    id: `s_one/S${slot}`,
    section: "s_one",
    slot,
    kind: "clip",
    media: { root: "FILM_ROOT", p: `clips/placeholder_${slot}.mp4` },
    poster: null,
    secs: 4,
    in: 0,
    out: null,
    letters: [],
    caption: `placeholder ${slot}`,
    maker: null,
    status: "locked",
    takes: [],
    reserve: false,
    inCut: null,
    cutIn: null,
    cutOut: null,
    ...extra,
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
    cards: [
      card(2),
      card(1, { cutIn: 10, cutOut: 13 }),
      card(3),
      card(3, { id: "s_one/S3x", inCut: false }),
      card(4, { reserve: true }),
      card(5, { kind: "words", media: null }),
    ],
    sounds: [
      { id: "m1", section: "s_one", kind: "music", code: "M1", name: "cue", media: { root: "FILM_ROOT", p: "music/placeholder.mp3" }, selected: true },
    ],
    plans: [],
    notes: [],
    world: { cast: [], locations: [], props: [] },
    runningCut: null,
  };
}

const noProbe = async () => null;

test("seed: slotted, non-reserve media cards sorted by slot, inCut false and words skipped", async () => {
  const film = await createFilm(placeholderFilm("f_seed0001"));
  const t = await T.seedTimeline(film, film.sections[0], noProbe);
  assert.deepEqual(t.edl.map((e) => e.ref), ["S1", "S2", "S3"]);
  assert.equal(t.edl[0].out, 3); // cut length wins over data-secs
  assert.equal(t.edl[1].out, 4);
  assert.equal(t.edl[0].recordIn, 10);
  assert.equal(t.baseRev, 1);
  assert.equal(t.music?.offset, 0);
  assert.equal(t.music?.fadeOutAt, null);
  assert.equal(t.status, "draft");
});

test("load seeds once by section id or code; a fresh seed survives its first trim", async () => {
  await createFilm(placeholderFilm("f_load0001"));
  const a = await T.loadTimeline("f_load0001", "§01");
  const b = await T.loadTimeline("f_load0001", "s_one");
  assert.equal(a.updatedAt, b.updatedAt);
  const saved = await T.updateTimeline("f_load0001", "01", (t) => T.applyTrim(t, { shot: "S2", delta: 0.5 }));
  assert.equal(saved.edl[1].out, 4.5);
  assert.equal(saved.lastChange, "trimmed +0.5 s");
  assert.equal(saved.edl[1].change, "trimmed");
  assert.equal((await T.loadTimeline("f_load0001", "s_one")).edl[1].out, 4.5);
});

async function seeded(id: string): Promise<Timeline> {
  const film = await createFilm(placeholderFilm(id));
  return T.seedTimeline(film, film.sections[0], async () => ({ duration: 5, width: 1920, height: 1080, fps: 24, hasAudio: false }));
}

test("mutations: trim edges, refs, move, remove, transition, words", async () => {
  const t = await seeded("f_muta0001");
  assert.equal(T.applyTrim(t, { shot: "2", delta: -0.5 }).edl[1].out, 3.5);
  assert.equal(T.applyTrim(t, { shot: "s_one/S2", in: 1 }).edl[1].in, 1);
  const inTrim = T.applyTrim(t, { shot: "e2", delta: -0.25, edge: "in" });
  assert.equal(inTrim.edl[1].in, 0.25);
  assert.equal(inTrim.lastChange, "trimmed −0.25 s");
  const moved = T.applyMove(t, { shot: "S3", index: 0 });
  assert.deepEqual(moved.edl.map((e) => e.ref), ["S3", "S1", "S2"]);
  assert.equal(moved.lastChange, "moved to 0");
  const removed = T.applyRemove(t, { shot: "S2" });
  assert.deepEqual(removed.edl.map((e) => e.ref), ["S1", "S3"]);
  assert.equal(removed.lastChange, "removed S2");
  const faded = T.applyTransition(t, { index: 2, type: "fade", dur: 0.5 });
  assert.equal(faded.lastChange, "fade 0.5 s into 2");
  assert.equal(T.edlSecs(faded), 10.5);
  const worded = T.applyWords(t, { text: "WORDS", start: 1, end: 3, png: null });
  assert.equal(worded.words.length, 1);
  assert.equal(worded.lastChange, "words ‘WORDS’");
  assert.equal(t.edl[1].out, 4); // pure: the input is untouched
});

test("guards: unknown ref, past the clip end, in ≥ out, transition longer than an entry, bad index", async () => {
  const t = await seeded("f_guar0001");
  const is422 = (e: unknown) => e instanceof Error && (e as { status?: number }).status === 422;
  assert.throws(() => T.applyTrim(t, { shot: "S9", delta: 1 }), is422);
  assert.throws(() => T.applyTrim(t, { shot: "S1", delta: 5 }), is422);
  assert.throws(() => T.applyTrim(t, { shot: "S1", in: 3 }), is422);
  assert.throws(() => T.applyTransition(t, { index: 1, type: "fade", dur: 3.5 }), is422);
  assert.throws(() => T.applyTransition(t, { index: 3, type: "fade", dur: 0.5 }), is422);
  assert.throws(() => T.applyMove(t, { shot: "S1", index: 7 }), is422);
  const one = T.applyRemove(T.applyRemove(t, { shot: "S1" }), { shot: "S2" });
  assert.throws(() => T.applyRemove(one, { shot: "S3" }), is422);
  const many = structuredClone(t);
  many.edl = Array.from({ length: 21 }, (_, i) => ({ ...t.edl[0], id: `e${i + 1}` }));
  assert.throws(() => T.validateEdl(many), is422);
});

test("edlHash changes with the edit", async () => {
  const t = await seeded("f_hash0001");
  assert.notEqual(T.edlHash(t), T.edlHash(T.applyTrim(t, { shot: "S1", delta: 0.5 })));
});
