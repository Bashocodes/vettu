import assert from "node:assert/strict";
import test from "node:test";
import type { Card, Film, Section } from "@/lib/contracts/film";
import {
  addSection,
  deriveSections,
  emptyFilm,
  filmName,
  moveSection,
  removeSection,
  renameFilm,
  renameSection,
  sectionName,
  setActive,
  setParked,
  setTargetSecs,
} from "./film-ops";
import { HttpError } from "./guard";

function blank(): Film {
  return { ...emptyFilm("f_test000001", "a film", {}), rev: 1, createdAt: "t", updatedAt: "t" };
}

let counter = 0;
const ids = () => `s_${(++counter).toString(16).padStart(8, "0")}`;

function card(section: string, slot: number | null, over: Partial<Card> = {}): Card {
  return {
    id: `${section}/S${slot ?? "r"}${Math.random().toString(16).slice(2, 6)}`,
    section,
    slot,
    kind: "clip",
    media: null,
    poster: null,
    secs: 4,
    in: 0,
    out: null,
    letters: [],
    caption: "placeholder",
    maker: null,
    status: "placed",
    takes: [],
    reserve: false,
    ...over,
  };
}

const status = (code: number) => (error: unknown) => error instanceof HttpError && error.status === code;

test("names: trim, collapse spaces, UPPERCASE, 1–60 (film 1–80)", () => {
  assert.equal(sectionName("  the   start "), "THE START");
  assert.equal(filmName("my\tfirst  film"), "MY FIRST FILM");
  assert.throws(() => sectionName("   "), status(400));
  assert.equal(sectionName("x".repeat(60)).length, 60);
  assert.throws(() => sectionName("x".repeat(61)), status(400));
  assert.equal(filmName("y".repeat(80)).length, 80);
  assert.throws(() => filmName("y".repeat(81)), status(400));
  assert.equal(renameFilm(blank(), " my  film ").name, "MY FILM");
});

test("addSection: s_<8 hex> id, derived, codes recomputed, first becomes active", () => {
  let film = addSection(blank(), { name: "the start", targetSecs: 30 });
  assert.match(film.sections[0].id, /^s_[0-9a-f]{8}$/);
  assert.equal(film.sections[0].code, "§01");
  assert.equal(film.sections[0].derived, true);
  assert.equal(film.sections[0].targetSecs, 30);
  assert.equal(film.activeSection, film.sections[0].id);
  film = addSection(film, { name: "the middle" }, ids);
  film = addSection(film, { name: "the opening", index: 0 }, ids);
  assert.deepEqual(
    film.sections.map((s) => [s.code, s.order, s.name]),
    [
      ["§01", 1, "THE OPENING"],
      ["§02", 2, "THE START"],
      ["§03", 3, "THE MIDDLE"],
    ],
  );
  assert.equal(film.sections[2].targetSecs, null);
  assert.throws(() => addSection(film, { name: "bad", targetSecs: -1 }), status(400));
  assert.throws(() => addSection(film, { name: "bad", index: -1 }), status(400));
});

test("move · rename · park · target accept id, code or name; ids never change", () => {
  let film = blank();
  for (const name of ["the one", "the two", "the three"]) film = addSection(film, { name }, ids);
  const two = film.sections[1];
  film = moveSection(film, "§02", 5);
  assert.equal(film.sections[2].id, two.id);
  assert.equal(film.sections[2].code, "§03");
  film = renameSection(film, two.id, "the beginning");
  assert.equal(film.sections[2].name, "THE BEGINNING");
  film = setParked(film, "THE BEGINNING", true);
  assert.equal(film.sections[2].parked, true);
  film = setTargetSecs(film, "3", 12.5);
  assert.equal(film.sections[2].targetSecs, 12.5);
  film = setActive(film, "beginning");
  assert.equal(film.activeSection, two.id);
  assert.equal(setActive(film, null).activeSection, null);
  assert.throws(() => moveSection(film, "§09", 0), status(404));
  assert.throws(() => setTargetSecs(film, two.id, Number.NaN), status(400));
});

test("removeSection: 409 section_has_cards unless withCards; then its cards go too", () => {
  let film = blank();
  film = addSection(film, { name: "the one" }, ids);
  film = addSection(film, { name: "the two" }, ids);
  const [one, two] = film.sections;
  film = {
    ...film,
    activeSection: one.id,
    cards: [card(one.id, 1), card(one.id, null, { reserve: true }), card(two.id, 1)],
    sounds: [{ id: "m1", section: one.id, kind: "music", code: "M1", name: "a cue", media: null }],
  };
  assert.throws(
    () => removeSection(film, one.id),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 409 &&
      error.message === "That section holds cards." &&
      error.extra?.error === "section_has_cards",
  );
  const after = removeSection(film, "§01", true);
  assert.deepEqual(
    after.sections.map((s) => [s.id, s.code]),
    [[two.id, "§01"]],
  );
  assert.equal(after.cards.length, 1);
  assert.equal(after.sounds.length, 0);
  assert.equal(after.activeSection, two.id);
  const empty = removeSection({ ...after, cards: [] }, two.id);
  assert.deepEqual(empty.sections, []);
  assert.equal(empty.activeSection, null);
});

test("deriveSections: user sections derive from their cards; imported sections keep numbers", () => {
  const user: Section = {
    id: "s_user",
    code: "§01",
    name: "THE USER",
    order: 1,
    targetSecs: 30,
    cutSecs: 99,
    full: true,
    locked: false,
    done: 9,
    total: 9,
    parked: false,
    derived: true,
  };
  const imported: Section = { ...user, id: "s_imp", code: "§02", order: 2, cutSecs: 40, done: 5, total: 5, derived: false };
  const film: Film = {
    ...blank(),
    sections: [user, imported],
    cards: [
      card("s_user", 1, { secs: 4 }),
      card("s_user", 2, { in: 1, out: 3, status: "master" }),
      card("s_user", 3, { kind: "words" }),
      card("s_user", 4, { status: "todo" }),
      card("s_user", null, { reserve: true }),
      card("s_user", null),
      card("s_imp", 1),
    ],
  };
  const [u, i] = deriveSections(film).sections;
  assert.deepEqual([u.done, u.total, u.cutSecs, u.full], [2, 4, 6, false]);
  assert.deepEqual(i, imported);
  const allDone: Film = { ...film, cards: [card("s_user", 1, { secs: 2.5 }), card("s_user", 2, { secs: null, out: null })] };
  const [full] = deriveSections(allDone).sections;
  assert.deepEqual([full.done, full.total, full.cutSecs, full.full], [2, 2, 2.5, true]);
  const none = deriveSections({ ...film, cards: [] }).sections[0];
  assert.deepEqual([none.done, none.total, none.cutSecs, none.full], [0, 0, 0, false]);
});
