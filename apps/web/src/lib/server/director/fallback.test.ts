import assert from "node:assert/strict";
import test from "node:test";
import { jobCreateBody } from "@/lib/contracts/jobs";
import { planFallback, shotRefIn, soundPrompt } from "./fallback";

const edl = Array.from({ length: 13 }, (_, i) => ({ id: `e${i + 1}`, ref: `S${i + 1}` }));

test("shot refs are read from the brief", () => {
  assert.equal(shotRefIn("a latch clicks on S3"), "S3");
  assert.equal(shotRefIn("a latch clicks on shot 4"), "4");
  assert.equal(shotRefIn("after e12 a door"), "e12");
  assert.equal(shotRefIn("a quiet door"), undefined);
});

test("the fallback plan is one add_sound on the named shot, else the first entry", () => {
  const named = planFallback("a latch clicks on S9", edl);
  assert.deepEqual(named && { kind: named.kind, target: named.target, duration: named.duration }, {
    kind: "sound",
    target: "S9",
    duration: 3,
  });
  assert.equal(planFallback("a latch clicks on S77", edl)?.target, "e1");
  assert.equal(planFallback("a quiet door", edl)?.target, "e1");
  assert.equal(planFallback("a quiet door", []), null);
});

test("the fallback body passes the job schema even for a long brief", () => {
  const long = "placeholder words ".repeat(120);
  assert.ok(soundPrompt(long).length <= 450);
  const plan = planFallback(long, edl)!;
  const parsed = jobCreateBody.safeParse({ ...plan, filmId: "f_fixture01", section: "s04" });
  assert.equal(parsed.success, true);
});
