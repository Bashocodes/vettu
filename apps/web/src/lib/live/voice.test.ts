import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { VETTU_TOOL_NAMES } from "@/lib/contracts/tools";
import {
  LIVE_DROPPED,
  LIVE_MIC_BLOCKED,
  LIVE_NEEDS_AGENT,
  LIVE_START_FAILED,
  MAX_CONTEXT_CHARS,
  MAX_LINES,
  MAX_SPOKEN_CHARS,
  TOOL_NOT_READY,
  TYPED_ONLY_TOOL_NAMES,
  VOICE_TOOL_NAMES,
  boardContextText,
  checkToolArgs,
  clearLines,
  createLines,
  disconnectOutcome,
  filmIdFrom,
  liveStateOf,
  midCallErrorLine,
  parseAvailability,
  pushLine,
  spokenResult,
  startFailureReason,
  stripEmpty,
  toolLine,
  toolOutcome,
  typedOnlyOutcome,
  unknownToolLine,
  type ContextBoard,
} from "./voice";

test("rows get stable ids, collapse whitespace, skip empties and keep at most MAX_LINES", () => {
  let model = createLines("p");
  model = pushLine(model, "you", "  hold   the third\nshot ");
  model = pushLine(model, "vettu", "");
  model = pushLine(model, "vettu", "holding it");
  assert.deepEqual(model.lines, [
    { id: "p-1", who: "you", text: "hold the third shot" },
    { id: "p-2", who: "vettu", text: "holding it" },
  ]);
  const before = model;
  assert.equal(pushLine(before, "status", "   "), before, "an empty row changes nothing");

  for (let i = 0; i < 60; i++) model = pushLine(model, "status", `row ${i}`);
  assert.equal(model.lines.length, MAX_LINES);
  assert.equal(model.lines[0].id, "p-13");
  assert.equal(model.lines.at(-1)?.id, "p-62");

  const cleared = clearLines(model);
  assert.deepEqual(cleared.lines, []);
  assert.equal(pushLine(cleared, "you", "again").lines[0].id, "p-63", "ids never repeat after a clear");
});

test("the voice tool set is the brief's twelve, and the rest of the registry is typed-only", () => {
  assert.equal(VOICE_TOOL_NAMES.length, 12);
  for (const name of VOICE_TOOL_NAMES) assert.ok(VETTU_TOOL_NAMES.includes(name), name);
  assert.deepEqual(
    [...VOICE_TOOL_NAMES, ...TYPED_ONLY_TOOL_NAMES].sort(),
    [...VETTU_TOOL_NAMES].sort(),
  );
  for (const name of ["propose_render", "remove_section", "first_assembly", "draw_insert"]) {
    assert.ok(TYPED_ONLY_TOOL_NAMES.includes(name as (typeof TYPED_ONLY_TOOL_NAMES)[number]), name);
  }
});

test("tool arguments validate with the registry, drop nulls and empty strings, and coerce spoken scalars once", () => {
  assert.deepEqual(checkToolArgs("trim_shot", { shot: "3", delta: 0.5 }), { ok: true, data: { shot: "3", delta: 0.5 } });
  assert.deepEqual(checkToolArgs("trim_shot", { shot: "S3", delta: null, section: "", edge: undefined }), {
    ok: true,
    data: { shot: "S3" },
  });
  assert.deepEqual(checkToolArgs("trim_shot", { shot: 3, delta: "-0.5" }), { ok: true, data: { shot: "3", delta: -0.5 } });
  assert.deepEqual(checkToolArgs("move_shot", { shot: "S2", index: "1" }), { ok: true, data: { shot: "S2", index: 1 } });
  assert.deepEqual(checkToolArgs("select_section", { section: "§04", extra: "ignored" }), {
    ok: true,
    data: { section: "§04" },
  });

  const badType = checkToolArgs("set_transition", { index: 2, type: "wipe", dur: 0.5 });
  assert.equal(badType.ok, false);
  assert.match(badType.ok ? "" : badType.message, /^Invalid arguments: type/);

  const missing = checkToolArgs("find_shot", "not an object");
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.message, /^Invalid arguments: query/);

  const words = checkToolArgs("set_words", { text: "A PLACEHOLDER", start: "1.5", end: "one" });
  assert.equal(words.ok, false, "a word that is not a number is never guessed");

  assert.deepEqual(checkToolArgs("delete_everything", {}), { ok: false, message: "That tool does not exist in VETTU." });
  assert.deepEqual(stripEmpty(null), {});
});

test("runTool results become one short spoken sentence, links never read out", () => {
  const ok = toolOutcome({ result: JSON.stringify({ status: "ok", message: "S3 holds 0.5 s longer · preview v3" }) });
  assert.deepEqual(ok, { ok: true, message: "S3 holds 0.5 s longer · preview v3" });
  assert.equal(spokenResult(ok), "done · S3 holds 0.5 s longer · preview v3");

  const refused = toolOutcome({ result: JSON.stringify({ status: "error", message: "No shot S9 in §04." }) });
  assert.equal(spokenResult(refused), "failed · No shot S9 in §04.");

  assert.deepEqual(toolOutcome({ result: "plain words" }), { ok: true, message: "plain words" });
  assert.deepEqual(toolOutcome({ result: "", error: "handler failed" }), { ok: false, message: "handler failed" });
  assert.deepEqual(toolOutcome(null), { ok: false, message: TOOL_NOT_READY });
  assert.equal(spokenResult({ ok: true, message: "" }), "done");
  assert.equal(spokenResult({ ok: false, message: "" }), "failed · VETTU could not finish that.");

  const linked = spokenResult({ ok: true, message: "preview ready /api/media?root=VETTU_WORK&p=x.mp4 at https://example.test/a" });
  assert.equal(linked, "done · preview ready at");
  assert.ok(spokenResult({ ok: true, message: "x".repeat(1000) }).length <= MAX_SPOKEN_CHARS);

  assert.equal(toolLine("trim_shot", ok), "trim_shot · done · S3 holds 0.5 s longer · preview v3");
  assert.equal(toolLine("render_preview", { ok: false, message: "" }), "render_preview · failed");
  assert.equal(spokenResult(typedOnlyOutcome("propose_render")), "failed · propose render works in the typed VETTU chat only.");
  assert.equal(unknownToolLine("weird<tool>name"), "LIVE · the agent asked for a tool VETTU does not have (weirdtoolname)");
  assert.equal(unknownToolLine(undefined), "LIVE · the agent asked for a tool VETTU does not have");
});

test("button state: availability first, then the session phase", () => {
  const base = { available: true, phase: "idle" as const, speaking: false, failed: false };
  assert.equal(liveStateOf({ ...base, available: null }), "unavailable");
  assert.equal(liveStateOf({ ...base, available: false }), "unavailable");
  assert.equal(liveStateOf(base), "off");
  assert.equal(liveStateOf({ ...base, failed: true }), "error");
  assert.equal(liveStateOf({ ...base, phase: "token" }), "connecting");
  assert.equal(liveStateOf({ ...base, phase: "connecting" }), "connecting");
  assert.equal(liveStateOf({ ...base, phase: "connected" }), "listening");
  assert.equal(liveStateOf({ ...base, phase: "connected", speaking: true }), "speaking");
  assert.equal(liveStateOf({ ...base, phase: "idle", speaking: true }), "off", "speaking only counts on a call");
});

test("availability, start failures, mid-call errors and disconnects map to controlled texts", () => {
  assert.deepEqual(parseAvailability({ available: true, reason: null }), { available: true, reason: null });
  assert.deepEqual(parseAvailability({ available: false, reason: "LIVE · needs ELEVENLABS_API_KEY" }), {
    available: false,
    reason: "LIVE · needs ELEVENLABS_API_KEY",
  });
  assert.deepEqual(parseAvailability("nonsense"), { available: false, reason: LIVE_NEEDS_AGENT });

  assert.equal(startFailureReason("Permission denied", new DOMException("Permission denied", "NotAllowedError")), LIVE_MIC_BLOCKED);
  assert.equal(startFailureReason("Permission denied by system"), LIVE_MIC_BLOCKED);
  assert.equal(startFailureReason("x", { name: "NotFoundError" }), "LIVE · no microphone found.");
  assert.equal(startFailureReason("x", { name: "NotReadableError" }), "LIVE · the microphone is busy in another app.");
  assert.equal(startFailureReason("provider said something long and private"), LIVE_START_FAILED);

  assert.equal(midCallErrorLine("Microphone permission denied"), LIVE_MIC_BLOCKED);
  assert.equal(midCallErrorLine("Server error: provider text"), "LIVE · a request was refused");

  assert.deepEqual(disconnectOutcome({ reason: "user" }), { failed: false, reason: null, line: "LIVE · ended" });
  assert.deepEqual(disconnectOutcome({ reason: "agent" }), { failed: false, reason: null, line: "LIVE · VETTU ended the call" });
  assert.deepEqual(disconnectOutcome({ reason: "error", message: "provider text", context: { type: "close" } }), {
    failed: true,
    reason: LIVE_DROPPED,
    line: "LIVE · connection lost",
  });
  assert.deepEqual(disconnectOutcome({ reason: "error", message: "x", context: { type: "max_duration_exceeded" } }), {
    failed: false,
    reason: null,
    line: "LIVE · the call reached its time limit",
  });
});

test("the film id comes from ?film=", () => {
  assert.equal(filmIdFrom("?film=film_placeholder&x=1"), "film_placeholder");
  assert.equal(filmIdFrom("?x=1"), null);
  assert.equal(filmIdFrom("?film="), null);
  assert.equal(filmIdFrom(`?film=${"a".repeat(101)}`), null);
});

test("board context: film, sections, the open section and its shots, capped", () => {
  const board: ContextBoard = {
    film: "PLACEHOLDER FILM",
    active: "sec02",
    sections: [
      { id: "sec01", code: "§01", name: "FIRST PART", durText: "20s", out: false, cards: [] },
      {
        id: "sec02",
        code: "§02",
        name: "SECOND PART",
        durText: "12s",
        out: false,
        cards: [
          { id: "sec02/S1", slot: 1, caption: "a placeholder caption", secs: 2.64 },
          { id: "sec02/S2", slot: null, caption: "", secs: null },
        ],
      },
      { id: "sec03", code: "§03", name: "LATER PART", durText: "0s", out: true, cards: [] },
    ],
  };
  assert.equal(
    boardContextText(board),
    [
      "VETTU board · film PLACEHOLDER FILM",
      "Sections: §01 FIRST PART 20s · §02 SECOND PART 12s · §03 LATER PART 0s (parked)",
      "Open section: §02 SECOND PART",
      "Shots in §02: S1 a placeholder caption 2.6 s · S2",
      'Shot refs: "S3" or "3". Section refs: "§04" or the section name.',
    ].join("\n"),
  );

  const none = boardContextText({ ...board, active: null });
  assert.match(none, /No section is open/);

  const huge: ContextBoard = {
    film: "PLACEHOLDER",
    active: "s0",
    sections: Array.from({ length: 40 }, (_, i) => ({
      id: `s${i}`,
      code: `§${String(i + 1).padStart(2, "0")}`,
      name: "A VERY LONG PLACEHOLDER SECTION NAME",
      durText: "10s",
      out: false,
      cards: Array.from({ length: 30 }, (_, j) => ({ id: `s${i}/S${j + 1}`, slot: j + 1, caption: "y".repeat(90), secs: 1 })),
    })),
  };
  assert.ok(boardContextText(huge).length <= MAX_CONTEXT_CHARS);
});

test("board context reads the contract's sample fixture when present", (t) => {
  const path = join(process.cwd(), "src/lib/contracts/fixtures/board-view.sample.json");
  if (!existsSync(path)) {
    t.skip("fixture not found from this cwd");
    return;
  }
  const board = JSON.parse(readFileSync(path, "utf8")) as ContextBoard;
  const text = boardContextText(board);
  assert.ok(text.startsWith("VETTU board · film "));
  assert.ok(text.length <= MAX_CONTEXT_CHARS);
});
