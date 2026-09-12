/**
 * Change orders from the Slack review thread — text only, the film's own files are never
 * touched. dataDir()/change-orders/<id>.json; idempotent on idempotencyKey via a wx claim at
 * change-orders/keys/<sha256>. kind "changes" + Ambiguous configured → create_task. Server only.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { markerOf, parseCutId, type ChangeOrder, type ChangeOrderBody } from "@/lib/contracts/review";
import { HttpError } from "./guard";
import { dataDir } from "./roots";
import { atomicWriteJson, claimFile, listJsonFiles, readJson } from "./ffmpeg/disk";
import type { Workplace } from "./workplace";

export type WorkplaceFactory = () => Promise<{ workplace: Workplace; close(): Promise<void> } | undefined>;

export const defaultWorkplaceFactory: WorkplaceFactory = async () => {
  if (!process.env.AMBIGUOUS_API_KEY?.trim()) return undefined;
  const { configuredWorkplace } = await import("./workplace");
  return configuredWorkplace();
};

const dir = () => join(dataDir(), "change-orders");
const ID = /^co_[a-f0-9]{8,32}$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function readOrder(id: string): Promise<ChangeOrder | null> {
  if (!ID.test(id)) return null;
  return readJson<ChangeOrder>(join(dir(), `${id}.json`));
}

export async function fileChangeOrder(
  body: ChangeOrderBody,
  deps: { workplace?: WorkplaceFactory } = {},
): Promise<{ changeOrder: ChangeOrder; duplicate: boolean }> {
  const cut = parseCutId(body.cutId);
  if (!cut) throw new HttpError(422, "That cut id is not a VETTU cut.");
  const id = `co_${randomBytes(8).toString("hex")}`;
  const keyPath = join(dir(), "keys", sha(body.idempotencyKey));
  if (!(await claimFile(keyPath, id))) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const firstId = await readFile(keyPath, "utf8").catch(() => "");
      const first = await readOrder(firstId.trim()).catch(() => null);
      if (first) return { changeOrder: first, duplicate: true };
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new HttpError(409, "That change order is still being filed.");
  }
  let order: ChangeOrder = {
    id,
    idempotencyKey: body.idempotencyKey,
    cutId: body.cutId,
    filmId: cut.filmId,
    section: cut.section,
    version: cut.version,
    kind: body.kind,
    text: body.text?.trim() ? body.text.trim() : null,
    reviewer: body.reviewer,
    source: body.source,
    createdAt: new Date().toISOString(),
    task: null,
    taskStatus: body.kind === "changes" ? "pending" : "skipped",
    error: null,
  };
  const path = join(dir(), `${id}.json`);
  await atomicWriteJson(path, order);
  if (body.kind !== "changes") return { changeOrder: order, duplicate: false };

  const connection = await (deps.workplace ?? defaultWorkplaceFactory)().catch(() => undefined);
  if (!connection) {
    order = { ...order, taskStatus: "skipped" };
    await atomicWriteJson(path, order);
    return { changeOrder: order, duplicate: false };
  }
  try {
    const title = `Change order · ${body.cutId}`;
    const description = [
      `Reviewer: ${body.reviewer.name}`,
      "",
      order.text ?? "(no text)",
      "",
      markerOf(cut.filmId, cut.section, cut.version),
      `vettu-change:${id}`,
    ].join("\n");
    const created = await connection.workplace.create(title, description, async () => {
      if (!(await claimFile(join(dir(), `${id}.attempt`), id)))
        throw new HttpError(409, "This change order was already sent to Ambiguous.");
    });
    const record = await connection.workplace.get(created.id);
    if (record.title !== title || record.description !== description)
      throw new Error("read-back mismatch");
    order = { ...order, task: { id: record.id, title: record.title, url: record.url }, taskStatus: "created" };
  } catch {
    order = { ...order, taskStatus: "failed", error: "Ambiguous did not confirm the task; check the workspace before filing again." };
  } finally {
    await connection.close().catch(() => undefined);
  }
  await atomicWriteJson(path, order);
  return { changeOrder: order, duplicate: false };
}

export async function listChangeOrders(filmId?: string): Promise<ChangeOrder[]> {
  const names = await listJsonFiles(dir());
  const orders = await Promise.all(names.map((n) => readOrder(n.slice(0, -5)).catch(() => null)));
  return orders
    .filter((o): o is ChangeOrder => !!o && (!filmId || o.filmId === filmId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
