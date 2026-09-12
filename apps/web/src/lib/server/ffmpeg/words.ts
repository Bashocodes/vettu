/**
 * On-screen words = a Pillow PNG drawn by tools/words.py (never drawtext, never a model).
 * Spawned with an argument array; the output must lie under workDir(). Server only.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { MediaSrc } from "@/lib/contracts/film";
import { HttpError } from "../guard";
import { workOutput } from "./run";

async function scriptPath(): Promise<string | null> {
  for (const candidate of [resolve(process.cwd(), "../../tools/words.py"), resolve(process.cwd(), "tools/words.py")]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next
    }
  }
  return null;
}

export async function drawWordsPng(filmId: string, sectionId: string, text: string): Promise<MediaSrc> {
  const script = await scriptPath();
  if (!script) throw new HttpError(500, "The words tool is missing.");
  const rel = `words/${filmId}/${sectionId}/w_${randomBytes(6).toString("hex")}.png`;
  let out: string;
  try {
    out = await workOutput(rel);
  } catch {
    throw new HttpError(500, "Could not draw the words.");
  }
  const ok = await new Promise<boolean>((done) => {
    let child;
    try {
      child = spawn("python3", [script, "--text", text, "--out", out, "--width", "1920", "--size", "72"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
  if (!ok) throw new HttpError(500, "Could not draw the words.");
  return { root: "VETTU_WORK", p: rel };
}
