/**
 * Spawns FFmpeg / FFprobe with argument arrays (never a shell). Inputs only via resolveMedia;
 * outputs only under workDir(). A render.lock in dataDir() holds the in-flight preview pid so a
 * new preview kills the old one. Server only.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { MediaSrc } from "@/lib/contracts/film";
import type { Timeline } from "@/lib/contracts/timeline";
import { dataDir, FFMPEG, FFPROBE, isWritablePath, resolveMedia, workDir } from "../roots";
import {
  buildRenderArgs,
  downscaleArgs,
  mediaForRef,
  planSecs,
  posterArgs,
  probeArgs,
  type PlanEntry,
  type RenderPlan,
} from "./graph";

export const PREVIEW_TIMEOUT_MS = 20_000;
export const FINAL_TIMEOUT_MS = 60_000;

export interface RunResult {
  ok: boolean;
  code: number | null;
  lastLine: string;
  ms: number;
}

/** A controlled render failure (message is safe to show). */
export class RenderError extends Error {}

/** Keep only a basename for anything that looks like an absolute path. */
export function scrubLine(line: string): string {
  return line.replace(/(?:\/[^\s:'"/]+){2,}/g, (m) => m.split("/").pop() ?? "").slice(0, 240);
}
function lastLineOf(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return scrubLine(lines.at(-1) ?? "");
}

interface LockInfo {
  pid: number;
  kind: "preview" | "final";
  startedAt: number;
}
const lockPath = () => join(dataDir(), "render.lock");

async function killInflightPreview() {
  try {
    const info = JSON.parse(await readFile(lockPath(), "utf8")) as LockInfo;
    // Only a recent preview lock: an old pid may belong to an unrelated process by now.
    if (info.kind === "preview" && info.pid > 0 && Date.now() - info.startedAt < PREVIEW_TIMEOUT_MS + 5_000) {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  } catch {
    // no lock
  }
}

export function runFfmpeg(
  args: string[],
  options: { timeoutMs: number; kind?: "preview" | "final"; bin?: string },
): Promise<RunResult> {
  const started = Date.now();
  return new Promise((done) => {
    let settled = false;
    const finish = (r: Omit<RunResult, "ms">) => {
      if (settled) return;
      settled = true;
      done({ ...r, ms: Date.now() - started });
    };
    let child;
    try {
      child = spawn(options.bin ?? FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      finish({ ok: false, code: null, lastLine: "ffmpeg could not start" });
      return;
    }
    let stderr = "";
    let timedOut = false;
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const pid = child.pid;
    const kind = options.kind;
    if (kind && pid) {
      mkdir(dataDir(), { recursive: true, mode: 0o700 })
        .then(() =>
          writeFile(lockPath(), JSON.stringify({ pid, kind, startedAt: started } satisfies LockInfo), {
            mode: 0o600,
          }),
        )
        .catch(() => undefined);
    }
    child.on("error", () => {
      clearTimeout(timer);
      finish({ ok: false, code: null, lastLine: "ffmpeg could not start" });
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      if (options.kind && pid) {
        try {
          const info = JSON.parse(await readFile(lockPath(), "utf8")) as LockInfo;
          if (info.pid === pid) await unlink(lockPath());
        } catch {
          // lock gone or replaced
        }
      }
      const lastLine = timedOut
        ? `timed out after ${Math.round(options.timeoutMs / 1000)} s`
        : signal
          ? "stopped by a newer preview"
          : lastLineOf(stderr) || `ffmpeg exited with code ${code}`;
      finish({ ok: code === 0 && !timedOut, code, lastLine });
    });
  });
}

export interface ProbeInfo {
  duration: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
}

export function probeMedia(abs: string): Promise<ProbeInfo | null> {
  return new Promise((done) => {
    let out = "";
    let child;
    try {
      child = spawn(FFPROBE, probeArgs(abs), { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return done(null);
      try {
        const j = JSON.parse(out) as {
          format?: { duration?: string };
          streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[];
        };
        const duration = Number(j.format?.duration);
        if (!Number.isFinite(duration) || duration <= 0) return done(null);
        const video = j.streams?.find((s) => s.codec_type === "video");
        let fps: number | null = null;
        if (video?.r_frame_rate) {
          const [a, b] = video.r_frame_rate.split("/").map(Number);
          if (a > 0 && b > 0) fps = Math.round((a / b) * 1000) / 1000;
        }
        done({
          duration: Math.round(duration * 1000) / 1000,
          width: video?.width ?? null,
          height: video?.height ?? null,
          fps,
          hasAudio: !!j.streams?.some((s) => s.codec_type === "audio"),
        });
      } catch {
        done(null);
      }
    });
  });
}

/** Resolve every media reference in the timeline through the allowlist. */
export async function planFor(t: Timeline): Promise<RenderPlan> {
  const entries: PlanEntry[] = [];
  for (const e of t.edl) {
    const src = mediaForRef(t, e.ref);
    if (!src) throw new RenderError(`${e.ref} has no media`);
    const path = await resolveMedia(src.media);
    if (!path) throw new RenderError(`${e.ref}: media not found`);
    entries.push({
      path,
      in: src.still ? 0 : e.in,
      dur: Math.round((e.out - e.in) * 1000) / 1000,
      still: src.still,
      transition: e.transition,
    });
  }
  const words: RenderPlan["words"] = [];
  for (const w of t.words) {
    if (!w.png) continue;
    const path = await resolveMedia(w.png);
    if (path) words.push({ path, start: w.start, end: w.end });
  }
  let music: RenderPlan["music"] = null;
  if (t.music) {
    const path = await resolveMedia(t.music.media);
    if (path) music = { path, offset: t.music.offset, fadeOutAt: t.music.fadeOutAt };
  }
  const sounds: RenderPlan["sounds"] = [];
  for (const s of t.sounds) {
    const path = await resolveMedia(s.media);
    if (path) sounds.push({ path, at: s.at, gainDb: s.gainDb });
  }
  return { entries, words, music, sounds };
}

/** Absolute output path under workDir() for a work-relative path; throws when it escapes. */
export async function workOutput(rel: string): Promise<string> {
  const root = resolve(workDir());
  const abs = resolve(root, rel);
  if (!abs.startsWith(root + sep) || !(await isWritablePath(abs))) throw new RenderError("output path refused");
  await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
  return abs;
}

export type PreviewOutcome =
  | { ok: true; media: MediaSrc; secs: number; ms: number }
  | { ok: false; error: string };

export async function renderPreview(t: Timeline): Promise<PreviewOutcome> {
  try {
    const plan = await planFor(t);
    const rel = `previews/${t.filmId}/${t.section}/draft${t.version + 1}_${Date.now().toString(36)}.mp4`;
    const abs = await workOutput(rel);
    await killInflightPreview();
    const r = await runFfmpeg(buildRenderArgs(plan, { width: 960, height: 540, quality: "preview", output: abs }), {
      timeoutMs: PREVIEW_TIMEOUT_MS,
      kind: "preview",
    });
    if (!r.ok) return { ok: false, error: r.lastLine };
    return { ok: true, media: { root: "VETTU_WORK", p: rel }, secs: planSecs(plan.entries), ms: r.ms };
  } catch (error) {
    return { ok: false, error: error instanceof RenderError ? error.message : "the render could not start" };
  }
}

export interface FinalOutcome {
  secs: number;
  final: MediaSrc;
  preview: MediaSrc;
  poster: MediaSrc | null;
  previewPath: string; // absolute (the channel reads the file)
  posterPath: string | null;
}

/** 1080p final + 540p copy + PNG poster. Throws RenderError with the last stderr line. */
export async function renderFinal(t: Timeline, version: number): Promise<FinalOutcome> {
  const plan = await planFor(t);
  const base = `renders/${t.filmId}/${t.section}/v${version}`;
  const finalAbs = await workOutput(`${base}_1080p.mp4`);
  const r = await runFfmpeg(buildRenderArgs(plan, { width: 1920, height: 1080, quality: "final", output: finalAbs }), {
    timeoutMs: FINAL_TIMEOUT_MS,
    kind: "final",
  });
  if (!r.ok) throw new RenderError(`final render failed: ${r.lastLine}`);
  const previewAbs = await workOutput(`${base}_540p.mp4`);
  const d = await runFfmpeg(downscaleArgs(finalAbs, previewAbs), { timeoutMs: FINAL_TIMEOUT_MS });
  if (!d.ok) throw new RenderError(`540p copy failed: ${d.lastLine}`);
  const secs = planSecs(plan.entries);
  const posterAbs = await workOutput(`${base}_poster.png`);
  const p = await runFfmpeg(posterArgs(finalAbs, posterAbs, Math.min(1, secs / 2)), { timeoutMs: 15_000 });
  return {
    secs,
    final: { root: "VETTU_WORK", p: `${base}_1080p.mp4` },
    preview: { root: "VETTU_WORK", p: `${base}_540p.mp4` },
    poster: p.ok ? { root: "VETTU_WORK", p: `${base}_poster.png` } : null,
    previewPath: previewAbs,
    posterPath: p.ok ? posterAbs : null,
  };
}
