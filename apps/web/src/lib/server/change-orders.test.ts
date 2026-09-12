import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileChangeOrder, listChangeOrders } from "./change-orders";
import type { WorkplaceTask } from "./workplace";

// dataDir() reads the env at call time, so setting it here (before any call) is enough.
process.env.VETTU_DATA_DIR = mkdtempSync(join(tmpdir(), "vettu-orders-"));
delete process.env.AMBIGUOUS_API_KEY;

const body = (key: string, kind: "approve" | "changes" = "changes") => ({
  idempotencyKey: key,
  cutId: "f_order0001:s_one:v2",
  kind,
  text: "hold the second shot longer",
  reviewer: { id: "U1", name: "Reviewer" },
  source: "reply" as const,
});

test("change orders are idempotent on idempotencyKey", async () => {
  const first = await fileChangeOrder(body("evt-1"), { workplace: async () => undefined });
  const again = await fileChangeOrder(body("evt-1"), { workplace: async () => undefined });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.changeOrder.id, first.changeOrder.id);
  assert.equal(first.changeOrder.version, 2);
  assert.equal(first.changeOrder.taskStatus, "skipped");
  const approve = await fileChangeOrder(body("evt-2", "approve"));
  assert.equal(approve.changeOrder.taskStatus, "skipped");
  const list = await listChangeOrders("f_order0001");
  assert.equal(list.length, 2);
  assert.equal(list[0].id, approve.changeOrder.id);
});

test("changes + a configured workplace creates one task and reads it back", async () => {
  const tasks: WorkplaceTask[] = [];
  let creates = 0;
  const workplace = async () => ({
    workplace: {
      identity: async () => ({ id: "u", workspaceId: "w", name: "n" }),
      list: async () => tasks,
      get: async (id: string) => tasks.find((t) => t.id === id)!,
      create: async (title: string, description: string, beforeWrite: () => Promise<void>) => {
        await beforeWrite();
        creates++;
        const t = { id: "11111111-1111-4111-8111-111111111111", title, description, url: null };
        tasks.push(t);
        return t;
      },
    },
    close: async () => undefined,
  });
  const r = await fileChangeOrder(body("evt-3"), { workplace });
  assert.equal(r.changeOrder.taskStatus, "created");
  assert.equal(r.changeOrder.task?.title, "Change order · f_order0001:s_one:v2");
  const dup = await fileChangeOrder(body("evt-3"), { workplace });
  assert.equal(dup.duplicate, true);
  assert.equal(creates, 1);
});

test("an unknown cut id is refused", async () => {
  await assert.rejects(fileChangeOrder({ ...body("evt-4"), cutId: "nope" }), (e: unknown) => (e as { status?: number }).status === 422);
});
