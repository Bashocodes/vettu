/**
 * Env roots + the media path allowlist (BOARD_DATA §6e). Server only.
 *
 * His film folders (FILM_REPORTS_DIR · FILM_ROOT · LABS_OUT) are READ-ONLY:
 * never writeFile / rename / mkdir / spawn output under them. VETTU writes only to
 * dataDir() and workDir().
 */
import { realpath } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import type { MediaRoot, MediaSrc } from "@/lib/contracts/film";

export const FFMPEG = "/opt/homebrew/bin/ffmpeg";
export const FFPROBE = "/opt/homebrew/bin/ffprobe";

export const MEDIA_EXTENSIONS = new Set([
  ".mp4", ".m4v", ".webm", ".mov", ".png", ".jpg", ".jpeg", ".webp", ".mp3", ".wav", ".m4a",
]);

function envPath(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

/** VETTU's own store (films, timelines, versions, jobs, outbox, change orders). */
export function dataDir(): string {
  return resolve(envPath("VETTU_DATA_DIR") ?? ".data/vettu");
}

/** The ONLY folder ffmpeg, renders, thumbs and uploads write to. */
export function workDir(): string {
  const w = envPath("VETTU_WORK");
  return w && isAbsolute(w) ? w : resolve(dataDir(), "work");
}

/** Absolute root folders that are configured. VETTU_WORK is always present. */
export function mediaRoots(): Partial<Record<MediaRoot, string>> {
  const roots: Partial<Record<MediaRoot, string>> = { VETTU_WORK: workDir() };
  for (const name of ["FILM_REPORTS_DIR", "FILM_ROOT", "LABS_OUT"] as const) {
    const v = envPath(name);
    if (v && isAbsolute(v)) roots[name] = v;
  }
  return roots;
}

/** Import SAAKSHE is offered only when the film env is set. */
export function filmEnvConfigured(): boolean {
  const r = mediaRoots();
  return !!(r.FILM_REPORTS_DIR && r.FILM_ROOT);
}

/** FILM_RUNNING_CUT, relative to FILM_ROOT. */
export function runningCutRel(): string | null {
  return envPath("FILM_RUNNING_CUT");
}

/**
 * Resolve a media reference to an absolute real path inside an allowed root, or null.
 * Order: decodeURIComponent once → resolve → realpath → prefix test against realpath(root) + sep
 * → extension allowlist. `..` is accepted because index srcs are board-relative; safety comes
 * only from the post-realpath prefix test. Never string-prefix the unresolved path.
 */
export async function resolveMedia(
  ref: MediaSrc,
  options: { allowExtensions?: Set<string> } = {},
): Promise<string | null> {
  const roots = mediaRoots();
  let base: string | undefined;
  let rel: string;
  if ("src" in ref) {
    base = roots.FILM_REPORTS_DIR;
    rel = ref.src;
  } else {
    base = roots[ref.root];
    rel = ref.p;
  }
  if (!base || typeof rel !== "string" || !rel) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || /%2e/i.test(decoded) || isAbsolute(decoded)) return null;
  const allowed = options.allowExtensions ?? MEDIA_EXTENSIONS;
  if (!allowed.has(extname(decoded).toLowerCase())) return null;
  const name = decoded.split(/[\\/]/).pop() ?? "";
  if (name.startsWith(".")) return null;
  let real: string;
  try {
    real = await realpath(resolve(base, decoded));
  } catch {
    return null;
  }
  const realRoots = await Promise.all(
    Object.values(roots).map((r) => realpath(r!).catch(() => null)),
  );
  const inside = realRoots.some((r) => r && (real === r ? false : real.startsWith(r + sep)));
  if (!inside) return null;
  if (!allowed.has(extname(real).toLowerCase())) return null;
  return real;
}

/** True when an absolute path lies under VETTU's writable folders (dataDir or workDir). */
export async function isWritablePath(abs: string): Promise<boolean> {
  const target = resolve(abs);
  for (const r of [dataDir(), workDir()]) {
    const root = resolve(r);
    if (target === root || target.startsWith(root + sep)) return true;
  }
  return false;
}
