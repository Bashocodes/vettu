import assert from "node:assert/strict";
import test from "node:test";
import type { Card, Film, MediaRoot, Section, Take } from "@/lib/contracts/film";
import type { BoardCard, BoardTake, BoardView } from "@/lib/contracts/board-view";
import storedSample from "../../../../samples/sample-film.json";
import importFixture from "../../contracts/fixtures/board-view.import.json";
import sampleFixture from "../../contracts/fixtures/board-view.sample.json";
import { buildBoardView, chipSecs, durText, sectionTabs } from "./board-view";

const noMedia = (url: string | null) => {
  assert.equal(url, null, "fixture cards carry no media");
  return null;
};
const toTake = (t: BoardTake): Take => ({
  id: t.id,
  kind: t.kind,
  media: noMedia(t.url),
  poster: noMedia(t.poster),
  caption: t.caption,
  maker: t.maker,
  letters: t.letters,
  lead: t.lead,
  secs: t.secs,
});
const toCard = (c: BoardCard): Card => ({
  id: c.id,
  section: c.section,
  slot: c.slot,
  kind: c.kind,
  media: noMedia(c.url),
  poster: noMedia(c.poster),
  secs: c.secs,
  in: c.in,
  out: c.out,
  letters: c.letters,
  caption: c.caption,
  maker: c.maker,
  status: c.status,
  takes: c.takes.map(toTake),
  reserve: c.reserve,
  inCut: c.inCut,
  cutIn: c.cutIn,
  cutOut: c.cutOut,
  deity: c.deity,
  upload: c.upload,
});

/** A store Film (placeholder words) rebuilt from a BoardView fixture. */
function filmFromView(view: BoardView): Film {
  const rc = view.runningCut;
  const rcUrl = rc ? new URL(rc.url, "http://127.0.0.1") : null;
  return {
    id: view.filmId,
    rev: view.rev,
    name: view.film,
    source: view.source,
    activeSection: view.active,
    targetSecs: view.stats.target?.secs ?? null,
    letters: view.letters,
    sections: view.sections.map(
      (s): Section => ({
        id: s.id,
        code: s.code,
        name: s.name,
        order: s.order,
        targetSecs: s.targetSecs,
        cutSecs: s.cutSecs,
        full: s.full,
        locked: s.locked,
        done: s.done,
        total: s.total,
        parked: s.out,
        derived: false,
      }),
    ),
    cards: view.sections.flatMap((s) => [...s.cards, ...s.reserve].map(toCard)),
    sounds: view.sections.flatMap((s) =>
      [...s.music, ...s.narration, ...s.sfx].map((x) => ({
        id: x.id,
        section: s.id,
        kind: x.kind,
        code: x.code,
        name: x.name,
        media: noMedia(x.url),
        selected: x.selected,
      })),
    ),
    plans: view.sections.flatMap((s) => s.plans.map((p) => ({ id: p.id, section: s.id, title: p.title }))),
    notes: view.sections.flatMap((s) => s.notes.map((text) => ({ section: s.id, text }))),
    world: { cast: [], locations: [], props: [] },
    runningCut:
      rc && rcUrl
        ? {
            media: { root: rcUrl.searchParams.get("root") as MediaRoot, p: rcUrl.searchParams.get("p") ?? "" },
            from: rc.from,
            to: rc.to,
            poster: null,
            musicBed: null,
          }
        : null,
    createdAt: "t",
    updatedAt: "t",
  };
}

const withoutTabs = (view: BoardView) => ({
  ...view,
  sections: view.sections.map(({ tabs: _tabs, ...rest }) => rest),
});

test("imported film → PLAN 3:27 · M 3:27 · 100% · 38/38 · §04 1:12.1–1:55.3, deep-equal to the fixture", () => {
  const fixture = importFixture as unknown as BoardView;
  const view = buildBoardView(filmFromView(fixture), { importAvailable: true });
  assert.deepEqual(withoutTabs(view), withoutTabs(fixture));
  assert.equal(view.stats.plan.text, "PLAN 3:27");
  assert.equal(view.stats.master.text, "M 3:27");
  assert.equal(view.stats.pct.text, "100%");
  assert.equal(view.stats.clips.text, "38/38");
  const s04 = view.sections.find((s) => s.code === "§04");
  assert.equal(s04?.range.text, "1:12.1–1:55.3");
  assert.equal(s04?.durText, "43s");
  assert.equal(s04?.cards.length, 15);
});

test("sample film (samples/sample-film.json) → board view deep-equals the sample fixture; letters = every film letter", () => {
  const stored = storedSample as unknown as Film;
  const view = buildBoardView({ ...stored, rev: 7 }, { importAvailable: false });
  const { letters, ...rest } = view;
  const { letters: fixtureLetters, ...fixtureRest } = sampleFixture as unknown as BoardView;
  assert.deepEqual(rest, fixtureRest);
  // The board carries EVERY film letter, so the legend's THE CAST row (kind "who") and PROPS (a thing) show.
  assert.deepEqual(letters, stored.letters);
  assert.notEqual(letters, stored.letters, "a copy, never the store object");
  for (const [code, letter] of Object.entries(fixtureLetters)) assert.deepEqual(letters[code], letter, code);
  assert.deepEqual(
    Object.entries(letters)
      .filter(([, l]) => l.inUse !== false && l.kind === "who")
      .map(([code]) => code),
    ["LEAD", "FRIEND"],
  );
  assert.equal(letters.PROPS?.kind, "thing");
});

test("tabs: non-empty only, in TAB_ORDER, never SUBS or ASSETS", () => {
  assert.deepEqual(sectionTabs({ reserve: [], music: 0, narration: 0, sfx: 0, plans: 0 }), []);
  assert.deepEqual(
    sectionTabs({ reserve: [{ kind: "image" }, { kind: "clip" }], music: 1, narration: 1, sfx: 2, plans: 1 }),
    ["R·CLIPS", "R·IMAGES", "MUSIC", "NARRATION", "SFX", "PLANS"],
  );
  assert.deepEqual(sectionTabs({ reserve: [{ kind: "words" }], music: 0, narration: 0, sfx: 1, plans: 0 }), [
    "R·IMAGES",
    "SFX",
  ]);
  const film = storedSample as unknown as Film;
  const view = buildBoardView(
    {
      ...film,
      cards: [
        ...film.cards,
        { ...film.cards[0], id: "s_start/R1", slot: null, reserve: true, kind: "clip", media: { src: "clips/a b.mp4" } },
      ],
      sounds: [{ id: "s_start/Q1", section: "s_start", kind: "sfx", code: "Q1", name: "a sound", media: null }],
      plans: [{ id: "s_start/PLAN1", section: "s_start", title: "a plan" }],
    },
    { importAvailable: false },
  );
  assert.deepEqual(view.sections[0].tabs, ["R·CLIPS", "SFX", "PLANS"]);
  assert.equal(view.sections[0].reserve[0].url, "/api/media?src=clips%2Fa%20b.mp4");
  assert.equal(view.sections[0].cards.length, 2);
});

test("maths: part sections, ≈ ranges, parked, target pill, PLAN 0", () => {
  assert.equal(durText({ full: false, cutSecs: 31.083, targetSecs: 60 }), "31/60s");
  assert.equal(chipSecs({ full: false, cutSecs: 31.083, targetSecs: 60 }), "31/60");
  assert.equal(durText({ full: true, cutSecs: 31.083, targetSecs: 60 }), "31s");
  assert.equal(chipSecs({ full: false, cutSecs: 0, targetSecs: 60 }), "60");
  assert.equal(durText({ full: false, cutSecs: 0, targetSecs: null }), "0/0s");

  const base = storedSample as unknown as Film;
  const section = (id: string, over: Partial<Section>): Section => ({
    id,
    code: "",
    name: `THE ${id.toUpperCase()}`,
    order: 0,
    targetSecs: 10,
    cutSecs: 10,
    full: true,
    locked: false,
    done: 1,
    total: 1,
    parked: false,
    derived: false,
    ...over,
  });
  const film: Film = {
    ...base,
    cards: [],
    targetSecs: 325.5,
    sections: [
      section("a", {}),
      section("b", { full: false, cutSecs: 5, targetSecs: 20, done: 1, total: 2 }),
      section("p", { parked: undefined as unknown as boolean, cutSecs: 0, full: false, targetSecs: 5, done: 0, total: 1 }),
      section("q", { parked: true }),
    ],
  };
  const view = buildBoardView(film, { importAvailable: false });
  assert.deepEqual(
    view.sections.map((s) => [s.range.text, s.range.exact, s.out]),
    [
      ["0:00–0:10.0", true, false],
      ["≈0:10.0–0:30.0", false, false],
      ["≈0:30.0–0:35.0", false, false],
      ["—", false, true],
    ],
  );
  assert.deepEqual(view.stats.target, { secs: 325.5, text: "→ 5:26" });
  assert.equal(view.stats.plan.text, "PLAN 0:35");
  assert.equal(view.stats.master.text, "M 0:15");
  assert.equal(view.stats.pct.value, 43);
  assert.equal(view.stats.clips.text, "2/4");
  assert.equal(view.stats.secsLeft.text, "20 s");
  assert.deepEqual(view.sections[1].colour, { bg: "#3b3012", fg: "#f2b53d" });

  const empty = buildBoardView({ ...base, sections: [], cards: [], targetSecs: null }, { importAvailable: true });
  assert.equal(empty.stats.plan.text, "PLAN 0:00");
  assert.equal(empty.stats.pct.text, "0%");
  assert.equal(empty.stats.clips.text, "0/0");
  assert.equal(empty.stats.toCreate.text, "X 0");
  assert.equal(empty.stats.target, null);
  assert.equal(empty.importAvailable, true);
});
