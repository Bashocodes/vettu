import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { BoardView } from "./contracts/board-view";
import type { Timeline } from "./contracts/timeline";
import {
  centis,
  changeText,
  clipWords,
  editDiff,
  ladderClass,
  rangeText,
  secsText,
  sectionNumber,
  signedSecs,
  splitCode,
  tenths,
} from "./board-format";

function fixture<T>(name: string): T {
  const candidates = [
    path.resolve(process.cwd(), "src/lib/contracts/fixtures", name),
    path.resolve(process.cwd(), "apps/web/src/lib/contracts/fixtures", name),
  ];
  const file = candidates.find((p) => existsSync(p));
  assert.ok(file, `fixture ${name} not found`);
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test("centis: running-cut readout m:ss.cc", () => {
  assert.equal(centis(0), "0:00.00");
  assert.equal(centis(5.1), "0:05.10");
  assert.equal(centis(72.0833), "1:12.08");
  assert.equal(centis(59.999), "1:00.00");
  assert.equal(centis(Number.NaN), "0:00.00");
});

test("tenths + signedSecs build the EDIT pill parts", () => {
  assert.equal(tenths(40.3), "0:40.3");
  assert.equal(tenths(207.166), "3:27.2");
  assert.equal(signedSecs(0.5), "+0.5 s");
  assert.equal(signedSecs(-3), "−3.0 s");
  assert.equal(signedSecs(-0.002), "±0.0 s");
});

test("clipWords keeps 7 words then an ellipsis", () => {
  assert.equal(clipWords("one two three"), "one two three");
  assert.equal(clipWords("a b c d e f g"), "a b c d e f g");
  assert.equal(clipWords("a b c — d e f g h"), "a b c — d e f …");
});

test("ladderClass follows the S ladder", () => {
  assert.equal(ladderClass("locked"), "b-locked");
  assert.equal(ladderClass("master"), "b-master");
  assert.equal(ladderClass("cut"), "b-cut");
  assert.equal(ladderClass("placed"), "b-placed");
  assert.equal(ladderClass("todo"), "b-placed");
});

test("small formatters", () => {
  assert.equal(secsText(3.1), "3.1s");
  assert.equal(secsText(5), "5s");
  assert.equal(secsText(null), null);
  assert.equal(rangeText(72.0833, 75.1666), "1:12.1–1:15.2");
  assert.equal(rangeText(null, 3), null);
  assert.deepEqual(splitCode("M5"), { letter: "M", rest: "5" });
  assert.equal(sectionNumber("§04"), "04");
  assert.equal(changeText({ change: "trimmed", delta: 0.5 }), "trimmed +0.5 s");
  assert.equal(changeText({ change: null, delta: null }), null);
});

test("editDiff: a freshly seeded timeline shows no YOUR EDIT strip", () => {
  const timeline = fixture<Timeline>("timeline.json");
  const diff = editDiff(timeline);
  assert.ok(diff);
  assert.equal(diff.show, false);
  assert.equal(diff.label, "VETTU v1 · DRAFT");
  assert.equal(diff.pill, "EDIT 0:43.2 (±0.0 s)");
  assert.ok(Math.abs(diff.recordSecs - 43.25) < 0.001);
  assert.deepEqual(diff.chips, {});
  assert.equal(editDiff(null), null);
});

test("editDiff: a trim shows the strip, the delta pill and the card chip", () => {
  const timeline = clone(fixture<Timeline>("timeline.json"));
  const e3 = timeline.edl.find((e) => e.ref === "S3");
  assert.ok(e3);
  e3.out += 0.5;
  e3.change = "trimmed";
  e3.delta = 0.5;
  timeline.lastChange = "trimmed +0.5 s";
  const diff = editDiff(timeline);
  assert.ok(diff);
  assert.equal(diff.show, true);
  assert.equal(diff.pill, "EDIT 0:43.7 (+0.5 s)");
  assert.equal(diff.chips.S3?.text, "trimmed +0.5 s");
  assert.equal(diff.lastChange, "trimmed +0.5 s");
});

test("editDiff: a slot dropped from the EDL is removed; the record length stays", () => {
  const timeline = clone(fixture<Timeline>("timeline.json"));
  const board = fixture<BoardView>("board-view.import.json");
  const cards = board.sections.find((s) => s.id === "s04")?.cards ?? [];
  timeline.edl = timeline.edl.filter((e) => e.ref !== "S2");
  const diff = editDiff(timeline, cards);
  assert.ok(diff);
  assert.equal(diff.show, true);
  assert.equal(diff.chips.S2?.text, "removed");
  assert.ok(Math.abs(diff.recordSecs - 43.25) < 0.01);
  assert.equal(diff.pill, "EDIT 0:38.2 (−5.1 s)");
});

test("editDiff: without recordIn/recordOut the seeded shots are the record", () => {
  const base = clone(fixture<Timeline>("timeline.json"));
  for (const e of base.edl) {
    e.recordIn = null;
    e.recordOut = null;
  }
  const seeded = editDiff(base);
  assert.ok(seeded);
  assert.equal(seeded.show, false);
  assert.equal(seeded.pill, "EDIT 0:43.2 (±0.0 s)");

  const trimmed = clone(base);
  const e3 = trimmed.edl.find((e) => e.ref === "S3");
  assert.ok(e3);
  e3.out += 0.5;
  e3.change = "trimmed";
  e3.delta = 0.5;
  trimmed.lastChange = "trimmed +0.5 s";
  const trim = editDiff(trimmed);
  assert.ok(trim);
  assert.equal(trim.show, true);
  assert.equal(trim.pill, "EDIT 0:43.7 (+0.5 s)");

  // A removal on a film with no record timecodes: no card needs inCut.
  const removed = clone(base);
  removed.edl = removed.edl.filter((e) => e.ref !== "S2");
  removed.lastChange = "removed S2";
  const cards = [{ id: "sec04/S2", slot: 2, inCut: null, cutIn: null, cutOut: null }];
  const rm = editDiff(removed, cards);
  assert.ok(rm);
  assert.equal(rm.show, true);
  assert.equal(rm.chips.S2?.text, "removed");
  assert.equal(rm.pill, "EDIT 0:38.2 (−5.1 s)");
  assert.equal(editDiff(removed)?.chips.S2?.text, "removed");
});

test("editDiff: a transition-only edit shows the strip without chips", () => {
  const timeline = clone(fixture<Timeline>("timeline.json"));
  const e3 = timeline.edl[3];
  assert.ok(e3);
  e3.transition = { type: "fade", dur: 0.5 };
  timeline.lastChange = "fade 0.5 s into 3";
  const diff = editDiff(timeline);
  assert.ok(diff);
  assert.equal(diff.show, true);
  assert.equal(diff.lastChange, "fade 0.5 s into 3");
  assert.deepEqual(diff.chips, {});
  assert.equal(diff.pill, "EDIT 0:43.2 (±0.0 s)");

  // Even with lastChange cleared, a non-cut join still differs from the record.
  timeline.lastChange = null;
  assert.equal(editDiff(timeline)?.show, true);
});

test("editDiff: approved versions and inserted shots", () => {
  const timeline = clone(fixture<Timeline>("timeline.json"));
  timeline.version = 2;
  timeline.status = "approved";
  timeline.edl.push({
    id: "e14",
    ref: "ins_a1",
    in: 0,
    out: 2,
    transition: { type: "cut", dur: 0 },
    change: "new",
    delta: null,
    recordIn: null,
    recordOut: null,
    temp: true,
  });
  timeline.inserts.push({
    id: "ins_a1",
    prompt: "placeholder drawn shot",
    still: null,
    video: null,
    sfx: null,
    temp: true,
    status: "placeholder",
    jobIds: [],
    error: null,
  });
  const diff = editDiff(timeline);
  assert.ok(diff);
  assert.equal(diff.show, true);
  assert.equal(diff.label, "VETTU v2 · APPROVED");
  assert.equal(diff.inserted.length, 1);
  assert.equal(diff.inserted[0]?.text, "new");
  assert.equal(diff.chips.ins_a1, undefined);
});
