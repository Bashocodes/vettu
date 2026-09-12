/**
 * The review outbox: dataDir()/outbox/<filmId>__<sectionId>__v<n>.json. The channel process
 * reads GET /api/review/queue (not yet posted, oldest first) and confirms with
 * POST /api/review/posted { cutId } (idempotent). Server only.
 */
import { join } from "node:path";
import { parseCutId, type ReviewQueueItem, type VersionRecord } from "@/lib/contracts/review";
import { HttpError } from "./guard";
import { dataDir } from "./roots";
import { atomicWriteJson, listJsonFiles, readJson, serial } from "./ffmpeg/disk";

export interface OutboxItem extends ReviewQueueItem {
  createdAt: string;
  postedAt: string | null;
}

const outboxDir = () => join(dataDir(), "outbox");
const SAFE = /^[A-Za-z0-9_-]{1,100}$/;

export function outboxPath(cutId: string): string {
  const parsed = parseCutId(cutId);
  if (!parsed || !SAFE.test(parsed.filmId) || !SAFE.test(parsed.section))
    throw new HttpError(404, "No such cut in the review queue.");
  return join(outboxDir(), `${parsed.filmId}__${parsed.section}__v${parsed.version}.json`);
}

export function versionPath(filmId: string, sectionId: string, version: number): string {
  if (!SAFE.test(filmId) || !SAFE.test(sectionId) || !Number.isInteger(version) || version < 1)
    throw new HttpError(404, "No such version.");
  return join(dataDir(), "versions", filmId, sectionId, `${version}.json`);
}

export async function enqueueReview(item: ReviewQueueItem): Promise<OutboxItem> {
  const path = outboxPath(item.cutId);
  const record: OutboxItem = { ...item, posterPath: item.posterPath ?? null, createdAt: new Date().toISOString(), postedAt: null };
  await atomicWriteJson(path, record);
  return record;
}

export async function listReviewQueue(): Promise<ReviewQueueItem[]> {
  const names = await listJsonFiles(outboxDir());
  const items = await Promise.all(names.map((n) => readJson<OutboxItem>(join(outboxDir(), n)).catch(() => null)));
  return items
    .filter((i): i is OutboxItem => !!i && !i.postedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ cutId, version, title, previewPath, posterPath }) => ({ cutId, version, title, previewPath, posterPath: posterPath ?? null }));
}

export async function markPosted(cutId: string): Promise<{ ok: true }> {
  const path = outboxPath(cutId);
  return serial(path, async () => {
    const item = await readJson<OutboxItem>(path);
    if (!item) throw new HttpError(404, "No such cut in the review queue.");
    if (item.postedAt) return { ok: true as const };
    const postedAt = new Date().toISOString();
    await atomicWriteJson(path, { ...item, postedAt });
    const parsed = parseCutId(cutId)!;
    const vPath = versionPath(parsed.filmId, parsed.section, parsed.version);
    const record = await readJson<VersionRecord>(vPath);
    if (record) await atomicWriteJson(vPath, { ...record, slack: "posted", postedAt });
    return { ok: true as const };
  });
}
