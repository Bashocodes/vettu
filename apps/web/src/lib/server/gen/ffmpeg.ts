/**
 * ffmpeg runner for generators: argument arrays only, a hard timeout, and a
 * controlled error (last stderr line with paths scrubbed). Server only.
 */
import { spawn } from "node:child_process";
import { FFMPEG } from "../roots";

export class GenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenError";
  }
}

/** Strip anything path- or key-shaped from a message before it reaches a job file. */
export function scrub(text: string, max = 200): string {
  return text
    .replace(/(?:[A-Za-z]:)?(?:\/[^\s/'"]+){2,}\/?/g, "<file>")
    .replace(/\b(?:sk|xi|key)[-_][A-Za-z0-9_-]{8,}\b/g, "<key>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function controlled(error: unknown, fallback: string): string {
  if (error instanceof GenError) return error.message;
  return fallback;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export function runFfmpeg(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const cap = 4_000_000;
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-8000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new GenError(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new GenError("ffmpeg could not start."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const last = stderr.trim().split("\n").filter(Boolean).pop() ?? `exit ${code}`;
      reject(new GenError(`ffmpeg: ${scrub(last)}`));
    });
  });
}
