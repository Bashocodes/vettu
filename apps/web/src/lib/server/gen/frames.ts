/**
 * Stills for animate inserts (FFMPEG_TOOLS §2.8 step 1): one frame grabbed from a shot, or a
 * still card copied as PNG. Inputs only via resolveMedia; outputs only under workDir(). Server only.
 */
import { mkdir } from "node:fs/promises";
import { relative } from "node:path";
import { join } from "node:path";
import type { MediaSrc } from "@/lib/contracts/film";
import { isWritablePath, resolveMedia, workDir } from "../roots";
import type { StillSource } from "./animate";
import { GenError, runFfmpeg } from "./ffmpeg";

export async function ensureDir(abs: string): Promise<string> {
  if (!(await isWritablePath(abs))) throw new GenError("VETTU may not write there.");
  await mkdir(workDir(), { recursive: true, mode: 0o700 });
  await mkdir(abs, { recursive: true, mode: 0o700 });
  return abs;
}

export function insertDir(insertId: string): string {
  if (!/^ins_[a-f0-9]{6,32}$/.test(insertId)) throw new GenError("Bad insert id.");
  return join(workDir(), "inserts", insertId);
}

/** A VETTU_WORK media ref for an absolute path under workDir(). */
export function workMedia(abs: string): MediaSrc {
  return { root: "VETTU_WORK", p: relative(workDir(), abs).split("\\").join("/") };
}

export async function grabFrame(srcAbs: string, at: number, outAbs: string): Promise<void> {
  if (!(await isWritablePath(outAbs))) throw new GenError("VETTU may not write there.");
  const isStill = /\.(png|jpe?g|webp)$/i.test(srcAbs);
  const args = isStill
    ? ["-v", "error", "-y", "-i", srcAbs, "-frames:v", "1", outAbs]
    : ["-v", "error", "-y", "-ss", at.toFixed(3), "-i", srcAbs, "-frames:v", "1", outAbs];
  await runFfmpeg(args, 20_000);
}

/** A plain dark 16:9 frame, used when no source media can be read (no film env). */
export async function blankFrame(outAbs: string): Promise<void> {
  if (!(await isWritablePath(outAbs))) throw new GenError("VETTU may not write there.");
  await runFfmpeg(
    ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x14121a:s=1920x1080:d=1", "-frames:v", "1", outAbs],
    20_000,
  );
}

/** Write the still for an insert. Unreadable media → a blank frame, so the push-in still lands. */
export async function writeStill(source: StillSource | null, outAbs: string): Promise<{ blank: boolean }> {
  const abs = source ? await resolveMedia(source.media) : null;
  if (abs && source) {
    try {
      await grabFrame(abs, source.at, outAbs);
      return { blank: false };
    } catch {
      // fall through to a blank frame
    }
  }
  await blankFrame(outAbs);
  return { blank: true };
}
