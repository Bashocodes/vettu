import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Insert, Timeline } from "@/lib/contracts/timeline";
import {
  entryHeads,
  MAX_EDL_ENTRIES,
  placeByPeak,
  placeInsert,
  PlacementError,
  resolveEntryIndex,
  spreadAfter,
} from "./placement";

const fixture = (): Timeline =>
  JSON.parse(readFileSync(new URL("../../contracts/fixtures/timeline.json", import.meta.url), "utf8")) as Timeline;

const insert = (id = "ins_abc123"): Insert => ({
  id,
  prompt: "placeholder insert",
  still: { root: "VETTU_WORK", p: `inserts/${id}/ref_0.png` },
  video: { root: "VETTU_WORK", p: `inserts/${id}/pushin.mp4` },
  sfx: null,
  temp: true,
  status: "placeholder",
  jobIds: ["job_1"],
  error: null,
});

test("shot refs resolve by entry id, shot id, slot number and card id", () => {
  const t = fixture();
  assert.equal(resolveEntryIndex(t, "e3"), 2);
  assert.equal(resolveEntryIndex(t, "S3"), 2);
  assert.equal(resolveEntryIndex(t, "3"), 2);
  assert.equal(resolveEntryIndex(t, "sec04/S3"), 2);
  assert.equal(resolveEntryIndex(t, "S99"), -1);
});

test("an insert lands right after afterShot as a temp new entry", () => {
  const t = fixture();
  const p = placeInsert(t, insert(), 3, "S3");
  assert.equal(p.index, 3);
  assert.equal(p.note, null);
  const e = p.timeline.edl[3]!;
  assert.equal(e.ref, "ins_abc123");
  assert.equal(e.temp, true);
  assert.equal(e.change, "new");
  assert.equal(e.in, 0);
  assert.equal(e.out, 3);
  assert.equal(e.id, "e14");
  assert.equal(p.timeline.edl.length, 14);
  assert.equal(p.timeline.edl[4]!.ref, "S4");
  assert.equal(p.timeline.inserts.length, 1);
  assert.equal(t.edl.length, 13, "input timeline untouched");
});

test("a fade into the following shot moves onto the insert", () => {
  const t = fixture();
  t.edl[3]!.transition = { type: "fade", dur: 0.5 };
  const p = placeInsert(t, insert(), 3, "S3");
  assert.deepEqual(p.timeline.edl[3]!.transition, { type: "fade", dur: 0.5 });
  assert.equal(p.timeline.edl[4]!.ref, "S4");
  assert.deepEqual(p.timeline.edl[4]!.transition, { type: "cut", dur: 0 });
  const short = placeInsert(t, insert(), 0.4, "S3");
  assert.deepEqual(short.timeline.edl[3]!.transition, { type: "cut", dur: 0 });
});

test("no afterShot → the end; unknown afterShot → the end with a note", () => {
  const t = fixture();
  assert.equal(placeInsert(t, insert(), 2).index, 13);
  const p = placeInsert(t, insert(), 2, "S77");
  assert.equal(p.index, 13);
  assert.match(p.note ?? "", /S77/);
});

test("the edit refuses a 21st entry", () => {
  const t = fixture();
  while (t.edl.length < MAX_EDL_ENTRIES) t.edl.push({ ...t.edl[0]!, id: `x${t.edl.length}` });
  assert.throws(() => placeInsert(t, insert(), 3), PlacementError);
});

test("entry heads subtract transition overlaps", () => {
  const cut = { type: "cut" as const, dur: 0 };
  const fade = { type: "fade" as const, dur: 0.5 };
  assert.deepEqual(
    entryHeads([
      { in: 0, out: 3, transition: cut },
      { in: 1, out: 4, transition: fade },
      { in: 0, out: 2, transition: cut },
    ]),
    [0, 2.5, 5.5],
  );
  const heads = entryHeads(fixture().edl);
  assert.equal(heads[2], 8.166);
});

test("a sound's peak lands on the head; clamps at zero", () => {
  assert.deepEqual(placeByPeak(8.166, 0.4), { at: 7.766, clamped: false });
  assert.deepEqual(placeByPeak(0.2, 0.9), { at: 0, clamped: true });
});

test("draws spread across the edit", () => {
  const ids = spreadAfter(fixture().edl, 3);
  assert.equal(ids.length, 3);
  assert.deepEqual(ids, ["e3", "e7", "e10"]);
  assert.deepEqual(spreadAfter([], 2), [undefined, undefined]);
});
