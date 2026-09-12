import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChangeOrder } from "@/lib/contracts/review";
import {
  CO_STRIP_MAX,
  forSection,
  httpsUrl,
  kindLabel,
  readCardRows,
  reviewerName,
  stripOrders,
  taskLine,
  timeText,
  toCardRow,
} from "./change-order-logic";

const order = (over: Partial<ChangeOrder> = {}): ChangeOrder => ({
  id: "co_1",
  idempotencyKey: "k1",
  cutId: "f_x:s04:v1",
  filmId: "f_x",
  section: "s04",
  version: 1,
  kind: "changes",
  text: "Hold the placeholder shot a little less.",
  reviewer: { id: "U0AAAAAAAAA", name: "U0AAAAAAAAA" },
  source: "reply",
  createdAt: "2026-01-01T10:00:00.000Z",
  task: { id: "task-1", title: "Change order", url: null },
  taskStatus: "created",
  error: null,
  ...over,
});

test("reviewerName never shows a raw Slack id", () => {
  assert.equal(reviewerName({ id: "U0AAAAAAAAA", name: "U0AAAAAAAAA" }), null);
  assert.equal(reviewerName({ id: "", name: "W0BBBBBBBB" }), null);
  assert.equal(reviewerName({ id: "U0AAAAAAAAA", name: "<@U0AAAAAAAAA>" }), null);
  assert.equal(reviewerName({ id: "U0AAAAAAAAA", name: "  " }), null);
  assert.equal(reviewerName(null), null);
  assert.equal(reviewerName({ id: "U0AAAAAAAAA", name: "Placeholder Person" }), "Placeholder Person");
  assert.equal(reviewerName({ name: "Uma" }), "Uma");
});

test("kindLabel", () => {
  assert.equal(kindLabel("approve"), "Approved");
  assert.equal(kindLabel("changes"), "Changes requested");
});

test("taskLine links only https and is honest about status", () => {
  assert.deepEqual(taskLine(order()), { text: "Ambiguous task task-1", href: null, tone: "ok", error: null });
  assert.equal(taskLine(order({ task: { id: "t2", title: "x", url: "http://example.test/t2" } })).href, null);
  assert.equal(taskLine(order({ task: { id: "t2", title: "x", url: "javascript:alert(1)" } })).href, null);
  assert.equal(
    taskLine(order({ task: { id: "t2", title: "x", url: "https://example.test/t2" } })).href,
    "https://example.test/t2",
  );
  const failed = taskLine(order({ task: null, taskStatus: "failed", error: "Could not save the task." }));
  assert.equal(failed.text, "Ambiguous task failed");
  assert.equal(failed.tone, "bad");
  assert.equal(failed.error, "Could not save the task.");
  assert.equal(taskLine(order({ task: null, taskStatus: "skipped" })).text, "Ambiguous task skipped");
  assert.equal(taskLine(order({ task: null, taskStatus: "pending" })).tone, "busy");
  assert.equal(taskLine({ task: null, taskStatus: "weird" }).text, "Ambiguous task pending");
});

test("httpsUrl", () => {
  assert.equal(httpsUrl("https://a.test/x"), "https://a.test/x");
  assert.equal(httpsUrl("http://a.test/x"), null);
  assert.equal(httpsUrl("not a url"), null);
  assert.equal(httpsUrl(null), null);
});

test("stripOrders filters to the section, newest first, max 6, drops junk", () => {
  const list: unknown[] = [
    order({ id: "old", createdAt: "2026-01-01T09:00:00.000Z" }),
    order({ id: "other", section: "s02", createdAt: "2026-01-01T12:00:00.000Z" }),
    order({ id: "new", createdAt: "2026-01-01T11:00:00.000Z" }),
    null,
    { id: 3 },
  ];
  assert.deepEqual(
    stripOrders(list, "s04").map((o) => o.id),
    ["new", "old"],
  );
  assert.deepEqual(
    forSection(list, null).map((o) => o.id),
    ["other", "new", "old"],
  );
  const many = Array.from({ length: 9 }, (_, i) =>
    order({ id: `o${i}`, createdAt: `2026-01-01T1${i}:00:00.000Z` }),
  );
  const strip = stripOrders(many, "s04");
  assert.equal(strip.length, CO_STRIP_MAX);
  assert.equal(strip[0].id, "o8");
  assert.deepEqual(stripOrders("nope", "s04"), []);
});

test("toCardRow + readCardRows keep ids out and links https-only", () => {
  const row = toCardRow(order());
  assert.equal(row.reviewer, null);
  assert.equal(row.taskId, "task-1");
  assert.equal(row.taskUrl, null);
  assert.equal(row.version, 1);
  assert.equal(row.kind, "changes");

  const { rows, total } = readCardRows({
    total: 2,
    changeOrders: [
      { ...row, reviewer: "U0CCCCCCCCC", taskUrl: "http://x.test" },
      { id: "b", kind: "approve", reviewer: "Placeholder Person", taskStatus: "skipped", taskUrl: "https://x.test/b" },
      "junk",
    ],
  });
  assert.equal(total, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reviewer, null);
  assert.equal(rows[0].taskUrl, null);
  assert.equal(rows[1].kind, "approve");
  assert.equal(rows[1].reviewer, "Placeholder Person");
  assert.equal(rows[1].taskStatus, "skipped");
  assert.equal(rows[1].taskUrl, "https://x.test/b");
  assert.deepEqual(readCardRows(null), { rows: [], total: 0 });
});

test("timeText", () => {
  assert.equal(timeText("bad"), "");
  assert.equal(timeText(null), "");
  assert.match(timeText("2026-01-01T10:05:00.000Z"), /^\d{2}:\d{2}$/);
});
