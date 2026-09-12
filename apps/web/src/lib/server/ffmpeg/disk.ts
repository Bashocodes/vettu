/**
 * Small disk helpers shared by VETTU's own stores (timelines, jobs, approvals, outbox,
 * change orders). Server only. Writes are atomic (tmp + rename) and serialised per key
 * inside this process — the same house pattern as film-store.ts.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** One-time claim file (flag wx). true = this caller owns it; false = it already existed. */
export async function claimFile(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return [];
  }
}

const queues = new Map<string, Promise<unknown>>();
/** Run `fn` after every earlier call with the same key has settled. */
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  queues.set(
    key,
    result.catch(() => undefined),
  );
  return result;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
