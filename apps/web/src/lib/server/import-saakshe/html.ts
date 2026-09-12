/** Tiny HTML helpers for the read-only regex loaders (posters, world pages). */

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    if (k === "nbsp") return " ";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
  });
}

/** A double-quoted attribute value from a tag's text, entity-decoded, or null. */
export function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag);
  return m ? decodeEntities(m[1]) : null;
}

/** `<video … poster=… src=…>` → Map(src → poster), attributes in any order. */
export function parsePosters(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of html.matchAll(/<video\b[^>]*>/gi)) {
    const src = attr(m[0], "src");
    const poster = attr(m[0], "poster");
    if (src && poster && !map.has(src)) map.set(src, poster);
  }
  return map;
}

/** Every `<video src>` with its tag offset (to find the running-cut row). */
export function videoTags(html: string): { src: string; poster: string | null; index: number }[] {
  const out: { src: string; poster: string | null; index: number }[] = [];
  for (const m of html.matchAll(/<video\b[^>]*>/gi)) {
    const src = attr(m[0], "src");
    if (src) out.push({ src, poster: attr(m[0], "poster"), index: m.index ?? 0 });
  }
  return out;
}

/** The `<audio src>` whose tag starts closest to `at` (either side), within `span` characters. */
export function audioNear(html: string, at: number, span = 1500): string | null {
  let best: { src: string; distance: number } | null = null;
  for (const m of html.matchAll(/<audio\b[^>]*>/gi)) {
    const distance = Math.abs((m.index ?? 0) - at);
    const src = attr(m[0], "src");
    if (src && distance <= span && (!best || distance < best.distance)) best = { src, distance };
  }
  return best?.src ?? null;
}
