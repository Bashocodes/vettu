/** Parser, grouping and world-page tests on synthetic placeholder text only (no film files). */
import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../guard";
import { parsePosters } from "./html";
import { recordMapFor, saaksheRules, stateLetters, stateSections } from "./import";
import { buildCards, buildPlans, buildSounds, kindOf, parseBoardIndex } from "./index-cards";
import { parseFilmState } from "./parse-state";
import { parseWorldPage } from "./world-pages";

const STATE = `/* the state — "quoted" window.NOT_ME = 1 */
window.FILM_SECTIONS=[
 {"id":"01","lk":true,"name":"ALPHA","plan":10,"ms":10.5,"done":1,"total":1,"m":"full"}, // a note
 {"id":"02","name":"BETA","plan":20,"ms":0,"done":0,"total":2,"m":null,"out":true},
];
window.FILM_LETTERS={
 "F" :{label:"image",   colour:"#111111",kind:"thing",inUse:true },
 WHO :{label:"a // not a comment, {not: a key}", colour:"#222222",kind:"who",inUse:true,},
 "ODD":{label:"odd", kind:"nope"},
};
window.letterColour=function(code){
  var e=(window.FILM_LETTERS||{})[code];
  return e?e.colour:"#333333";
};
window.FILM_TARGET=12.5; /* seconds */
window.FILM_LASTCUT=1700000000000;
window.FILM_CAST=[
 {code:"WHO", page:"who.html"}
];
`;

const unreadable = (error: unknown) =>
  error instanceof HttpError && error.status === 503 && error.extra?.error === "film_state_unreadable";

test("parseFilmState: comments, bare keys, trailing commas, numbers; functions skipped", () => {
  const state = parseFilmState(STATE);
  assert.deepEqual(Object.keys(state).sort(), ["FILM_CAST", "FILM_LASTCUT", "FILM_LETTERS", "FILM_SECTIONS", "FILM_TARGET"]);
  assert.equal((state.FILM_SECTIONS as unknown[]).length, 2);
  assert.equal((state.FILM_SECTIONS as { ms: number }[])[0].ms, 10.5);
  assert.equal((state.FILM_LETTERS as Record<string, { label: string }>).WHO.label, "a // not a comment, {not: a key}");
  assert.equal(state.FILM_TARGET, 12.5);
  assert.equal(state.FILM_LASTCUT, 1700000000000);
  assert.deepEqual(state.FILM_CAST, [{ code: "WHO", page: "who.html" }]);
  const letters = stateLetters(state);
  assert.deepEqual(letters.WHO, { label: "a // not a comment, {not: a key}", colour: "#222222", kind: "who", inUse: true });
  assert.equal(letters.ODD, undefined);
});

test("parseFilmState fails closed (503 film_state_unreadable)", () => {
  assert.throws(() => parseFilmState("window.FILM_SECTIONS=[{id:'01'}];"), unreadable);
  assert.throws(() => parseFilmState("window.X={a:1"), unreadable);
  assert.throws(() => parseFilmState("window.X={a:undefined};"), unreadable);
  assert.throws(() => parseFilmState('window.X={"a":"open'), unreadable);
  assert.throws(() => stateSections(parseFilmState(STATE)), unreadable);
});

test("stateSections: §01–§07 only, THE + name, imported numbers", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({
    id: String(i + 1).padStart(2, "0"),
    name: `PART${i + 1}`,
    plan: 10,
    ms: i === 6 ? 4 : 10,
    done: 1,
    total: 1,
    m: "full",
    ...(i === 0 ? { lk: true } : {}),
  }));
  const sections = stateSections({ FILM_SECTIONS: rows });
  assert.equal(sections.length, 7);
  assert.deepEqual(
    [sections[0].id, sections[0].code, sections[0].name, sections[0].locked, sections[0].derived],
    ["s01", "§01", "THE PART1", true, false],
  );
  assert.deepEqual([sections[6].cutSecs, sections[6].targetSecs, sections[6].full], [4, 10, true]);
});

const INDEX = JSON.stringify({
  board: "board.html",
  records: [
    { sec: "04", s: 1, f: "1", c: ["10"], secs: 3.1, ef: null, x: null, src: "../film/a.mp4", caption: "K · placeholder one", reserve: false, state: "locked", caption_maker: "K", cut: true, master: true, locked: true },
    { sec: "04", s: 3, f: "3", c: ["40"], secs: 5, ef: "5", x: null, src: "../film/old.mp4", caption: "K · older take", reserve: false, state: "locked", caption_maker: "K" },
    { sec: "04", s: 3, f: "3", c: ["92"], secs: 5, ef: "6", x: null, src: "../film/new.mp4", caption: "K · newer take", reserve: false, state: "locked", caption_maker: "K" },
    { sec: "04", s: 15, f: "9", c: [], secs: null, ef: null, x: null, src: "../film/still.png", caption: "MJ · a still", reserve: false, state: "locked", caption_maker: "MJ" },
    { sec: "04", s: 15, f: "9", c: ["94"], secs: 7, ef: "8", x: null, src: "../film/k1.mp4", caption: "K · take one", reserve: false, state: "locked", caption_maker: "K" },
    { sec: "04", s: null, f: "7", c: [], secs: null, ef: null, x: null, src: "img/r.jpg", caption: "a reserve still", reserve: true, state: "locked", caption_maker: "none" },
    { sec: "04", s: null, f: null, c: [], secs: null, ef: null, x: null, src: "../film/untitled.mp4", caption: "", reserve: true, state: "locked", caption_maker: "none" },
    { sec: "04", s: null, f: null, c: [], secs: null, ef: null, x: null, src: "../film/untitled2.mp4", caption: "", reserve: true, state: "locked", caption_maker: "none" },
    { sec: "06", s: null, f: null, c: [], secs: null, ef: null, x: 1, src: "", caption: "X · to make", reserve: true, state: "todo", caption_maker: "X" },
    { sec: "01", s: null, f: null, c: [], secs: null, ef: null, x: null, src: null, caption: "a plan", reserve: false, state: "plan", caption_maker: "none", plan: 1, title: "a plan" },
    { sec: "08", s: 1, f: "2", c: ["3"], secs: 2, ef: null, x: null, src: "../film/later.mp4", caption: "K · later", reserve: false, state: "locked", caption_maker: "K" },
    { sec: "arc", s: 1, f: "2", c: [], secs: null, ef: null, x: null, src: "img/arc.jpg", caption: "", reserve: false, state: "placed", caption_maker: "none" },
  ],
  music: [
    { m: 5, sec: "04", name: "a cue", src: "../film/cue.mp3" },
    { m: 17, sec: "08", name: "later cue", src: "../film/l.mp3" },
  ],
  narration: [{ l: 1, sec: "03", text: "a line", src: "../film/l1.mp3" }],
  sfx: [{ q: 1, sec: "01", name: "a sound", src: "../film/q1.mp3" }],
  plans: [
    { sec: "01", plan: 1, title: "a plan" },
    { sec: "08", plan: 8, title: "later plan" },
  ],
});

test("posters: <video> attributes in any order, entities decoded", () => {
  const posters = parsePosters(
    '<video controls poster="img/p1.jpg" src="../film/a.mp4"></video><video src="../film/k1.mp4" preload="none" poster="img/p&amp;2.jpg">',
  );
  assert.deepEqual([...posters], [
    ["../film/a.mp4", "img/p1.jpg"],
    ["../film/k1.mp4", "img/p&2.jpg"],
  ]);
});

test("grid groups by (sec, s) in index order; §04 lead take + record map; reserve, sounds, plans", () => {
  const index = parseBoardIndex(INDEX);
  const rules = saaksheRules(parsePosters('<video poster="img/p1.jpg" src="../film/a.mp4">'));
  const cards = buildCards(index, rules);
  const grid = cards.filter((c) => !c.reserve);
  assert.deepEqual(grid.map((c) => c.id), ["sec04/S1", "sec04/S3", "sec04/S15"]);

  const [s1, s3, s15] = grid;
  assert.deepEqual(
    { kind: s1.kind, media: s1.media, poster: s1.poster, caption: s1.caption, maker: s1.maker, section: s1.section },
    { kind: "clip", media: { src: "../film/a.mp4" }, poster: { src: "img/p1.jpg" }, caption: "placeholder one", maker: "K", section: "s04" },
  );
  assert.deepEqual(s1.letters, [{ code: "F", text: "1" }, { code: "C", text: "10" }]);
  assert.deepEqual([s1.inCut, s1.cutIn, s1.cutOut, s1.in, s1.out], [true, 72.0833, 75.1666, 0, 3.083]);
  assert.deepEqual(s1.takes.map((t) => [t.id, t.lead]), [["sec04/C10", true]]);

  assert.deepEqual(s3.takes.map((t) => [t.id, t.lead]), [["sec04/C92", true], ["sec04/C40", false]]);
  assert.deepEqual(s3.media, { src: "../film/new.mp4" });
  assert.deepEqual(s3.letters, [{ code: "F", text: "3" }, { code: "C", text: "92" }, { code: "F", text: "6 · EF" }]);
  assert.deepEqual([s3.inCut, s3.cutIn, s3.cutOut, s3.out, s3.deity], [true, 80.25, 85.2916, 5.042, "caption"]);

  assert.deepEqual([s15.kind, s15.poster, s15.maker, s15.caption, s15.inCut, s15.cutIn, s15.out], ["image", null, "MJ", "a still", false, null, null]);
  assert.deepEqual(s15.takes.map((t) => [t.id, t.kind, t.lead]), [["sec04/C94", "clip", false]]);

  const reserve = cards.filter((c) => c.reserve);
  assert.deepEqual(reserve.map((c) => [c.id, c.kind, c.slot]), [
    ["sec04/F7", "image", null],
    ["sec04/R1", "clip", null],
    ["sec04/R2", "clip", null],
    ["sec06/X1", "words", null],
  ]);
  assert.deepEqual([reserve[3].media, reserve[3].status, reserve[3].maker, reserve[3].caption, reserve[3].letters], [
    null,
    "todo",
    "X",
    "to make",
    [{ code: "X", text: "1" }],
  ]);
  assert.ok(cards.every((c) => c.section !== "s08" && c.section !== "sarc"));

  assert.deepEqual(buildSounds(index, rules).map((s) => [s.id, s.kind, s.code, s.section, s.selected]), [
    ["sec04/M5", "music", "M5", "s04", true],
    ["sec03/L1", "narration", "L1", "s03", false],
    ["sec01/Q1", "sfx", "Q1", "s01", false],
  ]);
  assert.deepEqual(buildPlans(index, rules), [{ id: "sec01/PLAN1", section: "s01", title: "a plan" }]);
  assert.equal(kindOf("a%20b.MP4"), "clip");
  assert.equal(kindOf("x.webp"), "image");
  assert.equal(kindOf(""), "words");
  assert.throws(() => parseBoardIndex("{"), unreadable);
  assert.throws(() => parseBoardIndex("{}"), unreadable);
});

test("§04 record map: S1–S13 in the cut (43.25 s from 72.0833), S14+ out, other sections unknown", () => {
  const first = recordMapFor("04", 1);
  const last = recordMapFor("04", 13);
  assert.deepEqual(last, { inCut: true, cutIn: 111.0416, cutOut: 115.3333, out: 4.292 });
  assert.equal(Math.round(((last?.cutOut ?? 0) - (first?.cutIn ?? 0)) * 1000) / 1000, 43.25);
  assert.deepEqual(recordMapFor("04", 14), { inCut: false, cutIn: null, cutOut: null, out: null });
  assert.equal(recordMapFor("05", 1), null);
});

test("world page: tabs ↔ panes, todo words, entities, no-tab pages, family codes", () => {
  const page = `<div class="tabs" id="tabs"><button class="tab on" data-tab="face">THE FACE</button><button class="tab" data-tab="caf">THE CAF&#xC9;</button><button class="tab" data-tab="none">EMPTY</button></div>
<section class="pane on" data-pane="face"><div class="cards"><figure class="cc" data-ar="9:16"><div class="media"><img src="img/a.png" alt="a"></div><div class="body"><div class="bar"><span class="bd who"><em>LEAD</em><i class="w">face</i></span></div></div></figure><div class="stack"><figure class="cc sm todo" data-ar="1:1"><div class="media"><div class="xbox">profile</div></div><div class="body"><div class="bar"><span class="bd x"><em>X</em><i class="w">profile</i></span></div></div></figure></div></div></section>
<section class="pane" data-pane="caf"><div class="cards"><figure class="cc todo" data-ar="7:3"><div class="media"><div class="xbox">the front</div></div></figure></div></section>`;
  const lead = parseWorldPage(page, { code: "LEAD", label: "the lead", colour: "#7fd0ff" }, "cast");
  assert.deepEqual(lead, {
    code: "LEAD",
    label: "the lead",
    colour: "#7fd0ff",
    tabs: [
      {
        id: "face",
        label: "THE FACE",
        cards: [
          { id: "lead/face1", label: "face", code: "LEAD", todo: false, ar: "9:16", media: { src: "img/a.png" } },
          { id: "lead/face2", label: "profile", code: "LEAD", todo: true, ar: "1:1", media: null },
        ],
      },
      {
        id: "caf",
        label: "THE CAFÉ",
        cards: [{ id: "lead/caf1", label: "the front", code: "LEAD", todo: true, ar: "7:3", media: null }],
      },
      { id: "none", label: "EMPTY", cards: [] },
    ],
  });
  const plain = '<section class="pane on" data-pane="x"><figure class="cc" data-ar="1:1"><img src="img/p.png"><i class="w">the thing</i></figure></section>';
  const lamp = parseWorldPage(plain, { code: "LAMP", label: "lamp", colour: "#b87333" }, "props");
  assert.deepEqual(lamp.tabs, [
    { id: "all", label: "", cards: [{ id: "lamp/1", label: "the thing", code: "LAMP", todo: false, ar: "1:1", media: { src: "img/p.png" } }] },
  ]);
  const places = parseWorldPage(plain, { code: "LOCATIONS", label: "the locations", colour: null }, "locations");
  assert.equal(places.tabs[0].cards[0].code, null);
});
