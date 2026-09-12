/**
 * GET|HEAD /api/media (BOARD_DATA §6e). `?src=` (relative to FILM_REPORTS_DIR, exactly as the
 * board index writes it) or `?root=FILM_REPORTS_DIR|FILM_ROOT|LABS_OUT|VETTU_WORK&p=`.
 * Only createReadStream / stat on the film roots. Controlled 400/403/404/416 — never an fs message.
 *
 * 403: an encoded dot, NUL, absolute path, backslash, dot-file segment, a refused extension, a
 *      path that lands outside every root (before or after realpath).
 * 404: root not configured, or nothing there.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { MEDIA_ROOTS, type MediaRoot, type MediaSrc } from "@/lib/contracts/film";
import { MEDIA_EXTENSIONS, mediaRoots, resolveMedia } from "./roots";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

export function contentTypeFor(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export type MediaQuery = { ok: true; ref: MediaSrc; rel: string } | { ok: false; status: 400 | 403 };

/** Validate the query. `rel` is the decoded relative path. Never touches the disk. */
export function parseMediaQuery(params: URLSearchParams): MediaQuery {
  const src = params.get("src");
  const root = params.get("root");
  const p = params.get("p");
  let ref: MediaSrc;
  let raw: string;
  if (src !== null && root === null && p === null) {
    ref = { src };
    raw = src;
  } else if (src === null && root !== null && p !== null) {
    if (!(MEDIA_ROOTS as readonly string[]).includes(root)) return { ok: false, status: 400 };
    ref = { root: root as MediaRoot, p };
    raw = p;
  } else {
    return { ok: false, status: 400 };
  }
  if (!raw || raw.length > 2048) return { ok: false, status: 400 };
  if (/%2e/i.test(raw) || raw.includes("\0")) return { ok: false, status: 403 };
  let rel: string;
  try {
    rel = decodeURIComponent(raw);
  } catch {
    return { ok: false, status: 403 };
  }
  if (rel.includes("\0") || /%2e/i.test(rel) || rel.includes("\\") || isAbsolute(rel)) {
    return { ok: false, status: 403 };
  }
  const segments = rel.split("/");
  if (segments.some((s) => s.startsWith(".") && s !== "." && s !== "..")) return { ok: false, status: 403 };
  const name = segments[segments.length - 1] ?? "";
  if (!name || !MEDIA_EXTENSIONS.has(extname(name).toLowerCase())) return { ok: false, status: 403 };
  return { ok: true, ref, rel };
}

export type Located = { status: 200; path: string; size: number } | { status: 403 | 404 };

export async function locateMedia(ref: MediaSrc, rel: string): Promise<Located> {
  const roots = mediaRoots();
  const base = "src" in ref ? roots.FILM_REPORTS_DIR : roots[ref.root];
  if (!base) return { status: 404 };
  const lexical = resolve(base, rel);
  const inside = Object.values(roots).some((r) => !!r && lexical.startsWith(resolve(r) + sep));
  if (!inside) return { status: 403 };
  const real = await resolveMedia(ref);
  if (!real) {
    // It exists but escapes (symlink out) → 403; nothing there → 404.
    try {
      await stat(lexical);
      return { status: 403 };
    } catch {
      return { status: 404 };
    }
  }
  try {
    const st = await stat(real);
    if (!st.isFile()) return { status: 404 };
    return { status: 200, path: real, size: st.size };
  } catch {
    return { status: 404 };
  }
}

export type ByteRange = { start: number; end: number };

/** null = no (or ignorable multi-) range → the whole file · "invalid" → 416. */
export function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (header == null || header.trim() === "") return null;
  const value = header.trim();
  if (value.includes(",")) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!m) return "invalid";
  const [, a, b] = m;
  if (a === "" && b === "") return "invalid";
  let start: number;
  let end: number;
  if (a === "") {
    const suffix = Number(b);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
    return "invalid";
  }
  return { start, end };
}

const refusal = (status: number) =>
  Response.json(
    { error: status === 400 ? "Bad media request." : status === 403 ? "Refused." : "Not found." },
    { status, headers: { "Cache-Control": "no-store" } },
  );

export async function serveMedia(request: Request, url: URL): Promise<Response> {
  const query = parseMediaQuery(url.searchParams);
  if (!query.ok) return refusal(query.status);
  const found = await locateMedia(query.ref, query.rel);
  if (found.status !== 200) return refusal(found.status);

  const range = parseRange(request.headers.get("range"), found.size);
  const common: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
  };
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...common, "Content-Range": `bytes */${found.size}` } });
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : found.size - 1;
  const length = found.size === 0 ? 0 : end - start + 1;
  const status = range ? 206 : 200;
  const headers: Record<string, string> = {
    ...common,
    "Content-Type": contentTypeFor(found.path),
    "Content-Length": String(length),
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${found.size}`;
  if (request.method.toUpperCase() === "HEAD" || length === 0) {
    return new Response(null, { status, headers });
  }
  const stream = Readable.toWeb(createReadStream(found.path, { start, end })) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, { status, headers });
}
