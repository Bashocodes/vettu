/**
 * Posters for clip cards the board page never gave one (BOARD_DATA §6b): one frame at the card's
 * in-point, drawn by ffmpeg into VETTU_WORK/thumbs and cached by source + time. Server only.
 * Media that does not resolve (no film env, a missing file) simply keeps poster null.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Card, MediaSrc } from "@/lib/contracts/film";
import { FFMPEG, isWritablePath, resolveMedia, workDir } from "../roots";

function thumbKey(media: MediaSrc, at: number): string {
  const id = "src" in media ? media.src : `${media.root}:${media.p}`;
  return createHash("sha1").update(`${id}|${at}`).digest("hex").slice(0, 16);
}

async function frameAt(media: MediaSrc, at: number): Promise<MediaSrc | null> {
  const abs = await resolveMedia(media);
  if (!abs) return null;
  const rel = `thumbs/${thumbKey(media, at)}.jpg`;
  const out = join(workDir(), rel);
  if (!(await isWritablePath(out))) return null;
  try {
    await stat(out);
    return { root: "VETTU_WORK", p: rel };
  } catch {
    // not cached yet
  }
  await mkdir(join(workDir(), "thumbs"), { recursive: true });
  const args = ["-v", "error", "-y", "-ss", String(Math.max(0, at)), "-i", abs, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", out];
  const ok = await new Promise<boolean>((resolve) => {
    execFile(FFMPEG, args, { timeout: 15_000 }, (error) => resolve(!error));
  });
  return ok ? { root: "VETTU_WORK", p: rel } : null;
}

/** Fill missing clip posters on cards and their takes, a few ffmpeg calls at a time. */
export async function withClipPosters(cards: Card[], concurrency = 4): Promise<Card[]> {
  const work: (() => Promise<void>)[] = [];
  for (const card of cards) {
    const media = card.media;
    if (card.kind === "clip" && media && !card.poster) {
      work.push(async () => {
        card.poster = await frameAt(media, card.in ?? 0);
      });
    }
    for (const take of card.takes) {
      const takeMedia = take.media;
      if (take.kind === "clip" && takeMedia && !take.poster) {
        work.push(async () => {
          take.poster = await frameAt(takeMedia, 0);
        });
      }
    }
  }
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, work.length) }, async () => {
    while (next < work.length) {
      const run = work[next++];
      try {
        await run();
      } catch {
        // a poster is best effort; the card keeps its words face
      }
    }
  });
  await Promise.all(lanes);
  return cards;
}
