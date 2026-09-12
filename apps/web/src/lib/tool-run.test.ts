import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardCard, BoardView } from "@/lib/contracts/board-view";
import type { CutResult, Timeline } from "@/lib/contracts/timeline";
import boardJson from "@/lib/contracts/fixtures/board-view.import.json";
import timelineJson from "@/lib/contracts/fixtures/timeline.json";
import {
  CONTEXT_BUDGET,
  LIVE_ROW_MAX,
  NO_FILM,
  agentContextValue,
  clip,
  errorMessage,
  fail,
  findShots,
  findShotsMessage,
  isNearBottom,
  isTypingTarget,
  liveRowText,
  ok,
  okCut,
  parseJobId,
  parseToolResult,
  resolveSectionRef,
  resolveShotRef,
  secsText,
  sectionLabel,
  validateToolArgs,
  worldCounts,
} from "./tool-run";

const board = boardJson as unknown as BoardView;
const timeline = timelineJson as unknown as Timeline;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ── sections ────────────────────────────────────────────────────────────────

test("section refs resolve by code, number, name, id and default to the open section", () => {
  for (const ref of ["§04", "04", "4", "section 4", "s04", "THE FOURTH", "fourth"]) {
    const res = resolveSectionRef(board, ref, "s01");
    assert.ok(res.ok, `ref ${ref}`);
    assert.equal(res.section.id, "s04", `ref ${ref}`);
  }
  const open = resolveSectionRef(board, undefined, "s04");
  assert.ok(open.ok);
  assert.equal(open.section.code, "§04");
  const blank = resolveSectionRef(board, "  ", "s02");
  assert.ok(blank.ok);
  assert.equal(blank.section.id, "s02");
});

test("unknown section refs list the valid codes; no board means no film", () => {
  const res = resolveSectionRef(board, "§99", "s04");
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.message.includes("§01 THE FIRST") && res.message.includes("§07 THE SEVENTH"));
  const none = resolveSectionRef(board, undefined, null);
  assert.equal(none.ok, false);
  assert.ok(!none.ok && /No section is open/.test(none.message));
  const noFilm = resolveSectionRef(null, "§04", "s04");
  assert.deepEqual(noFilm, { ok: false, message: NO_FILM });
});

// ── shots ───────────────────────────────────────────────────────────────────

test("shot refs resolve S3, s3, slot 3, entry id, card id and positions", () => {
  const expectE3 = ["S3", "s3", "3", "e3", "sec04/S3", "shot 3", "card 3", "#3"];
  for (const ref of expectE3) {
    const res = resolveShotRef(timeline, ref);
    assert.ok(res.ok, `ref ${ref}`);
    assert.equal(res.entry.id, "e3", `ref ${ref}`);
    assert.equal(res.position, 3, `ref ${ref}`);
    assert.equal(res.shot?.id, "S3", `ref ${ref}`);
  }
  const pos = resolveShotRef(timeline, "entry 5");
  assert.ok(pos.ok);
  assert.equal(pos.position, 5);
  const last = resolveShotRef(timeline, "position 13");
  assert.ok(last.ok);
  assert.equal(last.entry.id, timeline.edl[12].id);
});

test("a slot number follows its shot after a move; a removed shot is reported, not guessed", () => {
  const moved = clone(timeline);
  const [third] = moved.edl.splice(2, 1);
  moved.edl.splice(6, 0, third);
  const res = resolveShotRef(moved, "3");
  assert.ok(res.ok);
  assert.equal(res.entry.ref, "S3");
  assert.equal(res.position, 7);

  const removed = clone(timeline);
  removed.edl = removed.edl.filter((e) => e.ref !== "S3");
  const gone = resolveShotRef(removed, "S3");
  assert.equal(gone.ok, false);
  assert.ok(!gone.ok && /S3 is not in this edit/.test(gone.message));
});

test("unknown shot refs list the valid refs", () => {
  for (const ref of ["S99", "99", "nothing-here", ""]) {
    const res = resolveShotRef(timeline, ref);
    assert.equal(res.ok, false, `ref ${ref}`);
    assert.ok(!res.ok && res.message.includes("S1 · S2"), `ref ${ref}`);
  }
  const empty = resolveShotRef({ edl: [], shots: [] }, "S1");
  assert.equal(empty.ok, false);
});

test("find_shot searches shots, inserts and card captions, best match first", () => {
  const cards = board.sections[3].cards as BoardCard[];
  const matches = findShots("placeholder shot 3", timeline, cards);
  assert.ok(matches.length > 0);
  assert.equal(matches[0].ref, "S3");
  assert.equal(matches[0].entry, "e3");
  assert.equal(matches[0].position, 3);
  assert.deepEqual(findShots("zzzz", timeline, cards), []);
  assert.match(findShotsMessage("placeholder shot 3", board.sections[3], matches), /in §04 THE FOURTH: S3 \(#3\)/);
  assert.match(findShotsMessage("zzzz", board.sections[3], []), /No shot in §04/);

  const withInsert = clone(timeline);
  withInsert.inserts = [
    {
      id: "ins_one",
      prompt: "a lantern on a quiet road",
      still: null,
      video: null,
      sfx: null,
      temp: true,
      status: "placeholder",
      jobIds: [],
      error: null,
    },
  ];
  const lantern = findShots("lantern", withInsert, []);
  assert.equal(lantern.length, 1);
  assert.equal(lantern[0].ref, "ins_one");
  assert.equal(lantern[0].position, null);

  const cardsOnly = findShots("placeholder shot 2", null, cards);
  assert.equal(cardsOnly[0].ref, "S2");
  assert.equal(cardsOnly[0].entry, null);
});

// ── results ─────────────────────────────────────────────────────────────────

test("tool results round-trip through the chat's JSON string", () => {
  const good = JSON.stringify(ok("§02 is now THE BRIDGE", { a: 1 }));
  assert.deepEqual(parseToolResult(good), { status: "ok", message: "§02 is now THE BRIDGE", data: { a: 1 } });
  assert.deepEqual(parseToolResult(JSON.stringify(fail("nope"))), { status: "error", message: "nope" });
  assert.equal(parseToolResult("plain text"), null);
  assert.equal(parseToolResult(undefined), null);
});

test("job ids come out of every result shape, never out of an error", () => {
  assert.equal(parseJobId(JSON.stringify(ok("Queued", { jobId: "job_abc" }))), "job_abc");
  assert.equal(parseJobId(JSON.stringify({ status: "ok", message: "x", data: { job: { id: "job_nested" } } })), "job_nested");
  assert.equal(parseJobId(JSON.stringify({ jobId: "job_raw" })), "job_raw");
  assert.equal(parseJobId({ job: { id: "job_obj" } }), "job_obj");
  assert.equal(parseJobId("queued as job_12ab-3 in the background"), "job_12ab-3");
  assert.equal(parseJobId(JSON.stringify(fail("job_never failed"))), null);
  assert.equal(parseJobId("nothing here"), null);
  assert.equal(parseJobId(null), null);
});

function cutOf(overrides: Partial<CutResult>, preview: Timeline["preview"]): CutResult {
  const t = clone(timeline);
  t.preview = preview;
  t.lastChange = "trimmed +0.5 s";
  return { timeline: t, previewUrl: null, chip: null, ...overrides };
}

test("cut results report the chip and the preview number", () => {
  const rendered = okCut(
    "S3 5.0 s → 5.5 s",
    cutOf(
      { previewUrl: "/api/media?root=VETTU_WORK&p=x.mp4", chip: "trimmed +0.5 s" },
      { draft: 2, url: "/api/media?root=VETTU_WORK&p=x.mp4", secs: 43.21, renderedAt: "2026-01-01T00:00:00Z" },
    ),
  );
  assert.equal(rendered.status, "ok");
  assert.equal(rendered.message, "S3 5.0 s → 5.5 s · trimmed +0.5 s · VETTU PREVIEW v2");
  assert.ok(rendered.status === "ok");
  assert.deepEqual((rendered.data as { preview: unknown }).preview, { draft: 2, secs: 43.2 });

  const failed = okCut("S3 moved to #5 in §04", cutOf({ previewUrl: null, chip: "preview failed: busy" }, null));
  assert.equal(failed.message, "S3 moved to #5 in §04 · preview failed: busy");
  assert.ok(!failed.message.includes("VETTU PREVIEW"));
});

test("argument validation uses the one registry schema", () => {
  const good = validateToolArgs("trim_shot", { shot: "S3", delta: 0.5 });
  assert.ok(good.ok);
  assert.equal(good.data.delta, 0.5);
  const bad = validateToolArgs("rename_section", { section: "§02" });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.message.startsWith("rename_section needs valid arguments") && bad.message.includes("name"));
  assert.ok(validateToolArgs("refresh_change_orders", undefined).ok);
});

test("small text helpers", () => {
  assert.equal(secsText(3.14159), "3.1 s");
  assert.equal(secsText(2), "2.0 s");
  assert.equal(sectionLabel({ code: "§02", name: "THE SECOND" }), "§02 THE SECOND");
  assert.equal(clip("a   b\n c", 10), "a b c");
  assert.equal(clip("abcdefghij", 5), "abcd…");
  assert.equal(errorMessage(new Error("HTTP 409: stale")), "HTTP 409: stale");
  assert.equal(errorMessage("nope", "fallback"), "fallback");
});

// ── agent context ───────────────────────────────────────────────────────────

test("agent context carries film, sections, the open section, its cards and its edit under budget", () => {
  const value = agentContextValue({
    board,
    timeline,
    activeSection: "s04",
    world: worldCounts({
      cast: [{ filled: 3, total: 4 } as never],
      locations: [{ filled: 1, total: 2 } as never, { filled: 2, total: 2 } as never],
      props: [],
    }),
  }) as Record<string, any>;
  const size = JSON.stringify(value).length;
  assert.ok(size <= CONTEXT_BUDGET, `context is ${size} bytes`);
  assert.deepEqual(value.film, { id: board.filmId, name: board.film, rev: board.rev });
  assert.equal(value.sections.length, 7);
  assert.deepEqual(value.active, { id: "s04", code: "§04", name: "THE FOURTH" });
  assert.equal(value.cards.length, 15);
  assert.equal(value.timeline.edl.length, 13);
  assert.equal(value.timeline.edl[2].ref, "S3");
  assert.deepEqual(value.world.locations, { members: 2, filled: 3, total: 4 });
  assert.match(value.stats, /PLAN 3:27/);
});

test("agent context drops a timeline from another section and shrinks to fit a huge board", () => {
  const other = agentContextValue({ board, timeline, activeSection: "s02" }) as Record<string, any>;
  assert.equal(other.timeline, null);
  assert.equal(other.world, null);

  const huge = clone(board);
  const card = huge.sections[3].cards[0];
  huge.sections[3].cards = Array.from({ length: 300 }, (_, i) => ({
    ...card,
    id: `sec04/S${i + 1}`,
    slot: i + 1,
    caption: `placeholder caption ${i} `.repeat(12),
  }));
  const bigTimeline = clone(timeline);
  bigTimeline.edl = Array.from({ length: 120 }, (_, i) => ({ ...timeline.edl[0], id: `e${i + 1}`, ref: `S${i + 1}` }));
  const value = agentContextValue({ board: huge, timeline: bigTimeline, activeSection: "s04" }) as Record<string, any>;
  const size = JSON.stringify(value).length;
  assert.ok(size <= CONTEXT_BUDGET, `context is ${size} bytes`);
  assert.ok(value.moreCards > 0);
  assert.ok(value.timeline.moreEntries > 0);

  const empty = agentContextValue({ board: null, timeline: null, activeSection: null }) as Record<string, any>;
  assert.equal(empty.film, null);
});

// ── keyboard ────────────────────────────────────────────────────────────────

test("the c toggle never fires inside a text field", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "textarea" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "P", closest: () => ({}) }), true);
  assert.equal(isTypingTarget({ tagName: "BUTTON", closest: () => null }), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget(window_like()), false);
});

function window_like() {
  return { addEventListener() {} };
}

// ── LIVE strip ──────────────────────────────────────────────────────────────

test("a long LIVE caption row keeps its newest words, bounded, starting at a whole word", () => {
  assert.deepEqual(liveRowText("hold the third shot"), { text: "hold the third shot", clipped: false });
  const exact = "a".repeat(LIVE_ROW_MAX);
  assert.deepEqual(liveRowText(exact), { text: exact, clipped: false });

  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const shown = liveRowText(long);
  assert.equal(shown.clipped, true);
  assert.ok(shown.text.startsWith("…"));
  assert.ok(shown.text.endsWith("word79"), "the newest words stay visible");
  assert.ok(shown.text.length <= LIVE_ROW_MAX + 1);
  assert.match(shown.text, /^…word\d+ /, "starts at a whole word, never mid-word");
  assert.ok(long.endsWith(shown.text.slice(1)));

  // a cut that already lands on a word boundary keeps that word
  const aligned = `${"x".repeat(20)} ${"y".repeat(LIVE_ROW_MAX)}`;
  assert.equal(liveRowText(aligned).text, `…${"y".repeat(LIVE_ROW_MAX)}`);

  // no space nearby: the plain tail
  assert.equal(liveRowText("z".repeat(400)).text, `…${"z".repeat(LIVE_ROW_MAX)}`);
});

test("the LIVE strip only autoscrolls while the reader is at its bottom", () => {
  assert.equal(isNearBottom({ scrollHeight: 300, scrollTop: 176, clientHeight: 124 }), true);
  assert.equal(isNearBottom({ scrollHeight: 300, scrollTop: 170, clientHeight: 124 }), true);
  assert.equal(isNearBottom({ scrollHeight: 300, scrollTop: 100, clientHeight: 124 }), false);
  assert.equal(isNearBottom({ scrollHeight: 100, scrollTop: 0, clientHeight: 124 }), true);
});
