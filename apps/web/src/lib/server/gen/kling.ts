/**
 * Kling image→video (FFMPEG_TOOLS §2.8 step 4), the proven call:
 * POST {base}/image-to-video/kling-3.0 (Bearer KLING_API_KEY) with the still as the
 * first frame (base64) → task id at data.id → GET /tasks?task_ids=<id> every 10 s up to
 * 10 min → download outputs[type=video].url. Keys only from process.env. Server only.
 */
import { readFile, writeFile } from "node:fs/promises";
import { isWritablePath } from "../roots";
import { GenError } from "./ffmpeg";

export const KLING_BASE = "https://api-singapore.klingai.com";
export const KLING_SUBMIT_PATH = "/image-to-video/kling-3.0";

/** Beat order, and no travel move until the action finishes (his Kling lever). One line. */
export function klingPrompt(prompt: string): string {
  const p = prompt.replace(/\s+/g, " ").trim().replace(/[.;,\s]+$/, "");
  return (
    `${p}. Beat order: first the action plays out and finishes while the camera holds still; ` +
    "the camera makes no travel move until that action has finished; only then a slow gentle push. " +
    "No text on screen."
  );
}

export function klingDuration(secs: number): number {
  return secs > 5 ? 10 : 5;
}

export function klingSubmitBody(input: {
  imageB64: string;
  prompt: string;
  duration: number;
  externalId: string;
}): Record<string, unknown> {
  return {
    contents: [
      { type: "prompt", text: klingPrompt(input.prompt) },
      { type: "first_frame", url: input.imageB64 },
    ],
    settings: { resolution: "1080p", duration: input.duration, audio: "off", multi_shot: false },
    options: { watermark_info: { enabled: false }, external_task_id: input.externalId },
  };
}

/** Task id from a submit reply: data.id first, then task_id / taskId anywhere. */
export function parseKlingSubmit(json: unknown): string | null {
  const data = (json as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    for (const k of ["id", "task_id", "taskId"]) if (typeof d[k] === "string" && d[k]) return d[k] as string;
  }
  return findId(json);
}

function findId(o: unknown, depth = 0): string | null {
  if (depth > 5 || !o || typeof o !== "object") return null;
  if (Array.isArray(o)) {
    for (const v of o) {
      const r = findId(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const r = o as Record<string, unknown>;
  for (const k of ["task_id", "taskId", "id"]) if (typeof r[k] === "string" && r[k]) return r[k] as string;
  for (const v of Object.values(r)) {
    const found = findId(v, depth + 1);
    if (found) return found;
  }
  return null;
}

export type KlingStatus = "submitted" | "processing" | "succeeded" | "failed" | "unknown";
export interface KlingTask {
  status: KlingStatus;
  videoUrl: string | null;
}

/** Poll reply: data:[{ id, status, outputs:[{ type:"video", url }] }]; tolerant of data as an object. */
export function parseKlingTask(json: unknown): KlingTask {
  const data = (json as { data?: unknown } | null)?.data;
  const item = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!item || typeof item !== "object") return { status: "unknown", videoUrl: null };
  const raw = String(item.status ?? item.task_status ?? "").toLowerCase();
  const status: KlingStatus =
    raw === "succeeded" || raw === "succeed" || raw === "success"
      ? "succeeded"
      : raw === "failed" || raw === "fail"
        ? "failed"
        : raw === "processing" || raw === "running"
          ? "processing"
          : raw === "submitted" || raw === "queued" || raw === "pending"
            ? "submitted"
            : "unknown";
  const outputs = (item.outputs ?? (item.task_result as Record<string, unknown> | undefined)?.videos) as
    | Array<Record<string, unknown>>
    | undefined;
  const video = Array.isArray(outputs)
    ? outputs.find((o) => typeof o?.url === "string" && (o.type === undefined || o.type === "video"))
    : undefined;
  const url = typeof video?.url === "string" && /^https:\/\//.test(video.url) ? video.url : null;
  return { status, videoUrl: url };
}

export interface KlingDeps {
  fetch?: typeof fetch;
  key?: string | null;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
  onProgress?: (text: string) => void | Promise<void>;
  base?: string;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Submit, poll, download. Throws GenError with a controlled message. */
export async function klingAnimate(
  input: { stillAbs: string; outAbs: string; prompt: string; secs: number; externalId: string },
  deps: KlingDeps = {},
): Promise<{ taskId: string; path: string }> {
  const key = (deps.key === undefined ? process.env.KLING_API_KEY : deps.key)?.trim();
  if (!key) throw new GenError("Kling key not set");
  if (!(await isWritablePath(input.outAbs))) throw new GenError("VETTU may not write there.");
  const f = deps.fetch ?? fetch;
  const base = deps.base ?? KLING_BASE;
  const sleep = deps.sleep ?? wait;
  const pollMs = deps.pollMs ?? 10_000;
  const maxPolls = deps.maxPolls ?? 60;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  const image = await readFile(input.stillAbs);
  if (image.byteLength > 50_000_000) throw new GenError("The still is over Kling's 50 MB cap.");
  let submitJson: unknown;
  try {
    const res = await f(`${base}${KLING_SUBMIT_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(
        klingSubmitBody({
          imageB64: image.toString("base64"),
          prompt: input.prompt,
          duration: klingDuration(input.secs),
          externalId: input.externalId,
        }),
      ),
      signal: AbortSignal.timeout(120_000),
    });
    submitJson = await res.json().catch(() => null);
    if (!res.ok) throw new GenError(`Kling refused the job (HTTP ${res.status}).`);
  } catch (error) {
    if (error instanceof GenError) throw error;
    throw new GenError("Kling could not be reached.");
  }
  const taskId = parseKlingSubmit(submitJson);
  if (!taskId) throw new GenError("Kling returned no task id.");
  await deps.onProgress?.("Kling: submitted");

  for (let poll = 1; poll <= maxPolls; poll++) {
    await sleep(pollMs);
    let task: KlingTask = { status: "unknown", videoUrl: null };
    try {
      const res = await f(`${base}/tasks?task_ids=${encodeURIComponent(taskId)}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) task = parseKlingTask(await res.json().catch(() => null));
    } catch {
      // a network hiccup is one missed poll
    }
    if (task.status === "failed") throw new GenError("Kling failed the job.");
    if (task.status === "succeeded") {
      if (!task.videoUrl) throw new GenError("Kling finished with no video.");
      await deps.onProgress?.("Kling: downloading");
      try {
        const res = await f(task.videoUrl, { method: "GET", signal: AbortSignal.timeout(180_000) });
        if (!res.ok) throw new GenError(`Kling video download failed (HTTP ${res.status}).`);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.byteLength < 1000) throw new GenError("Kling video download was empty.");
        await writeFile(input.outAbs, bytes, { mode: 0o600 });
      } catch (error) {
        if (error instanceof GenError) throw error;
        throw new GenError("Kling video download failed.");
      }
      return { taskId, path: input.outAbs };
    }
    await deps.onProgress?.(`Kling: ${task.status === "unknown" ? "waiting" : task.status} (${poll}/${maxPolls} polls)`);
  }
  throw new GenError("Kling did not finish within 10 minutes.");
}
