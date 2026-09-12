/**
 * The edit timeline store: VETTU_DATA_DIR/timelines/<filmId>/<sectionId>.json (atomic,
 * serialised per key). Seeds from the film store when missing; never writes the film of record.
 * Pure mutations (trim · move · remove · transition · words) apply the FFMPEG_TOOLS §3 guards
 * and throw HttpError(422, "<plain reason>"). Server only.
 */
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { findSection, type Film, type MediaSrc, type Section } from "@/lib/contracts/film";
import type { Clip, CutResult, EdlEntry, Shot, Timeline, TransitionType } from "@/lib/contracts/timeline";
import { requireFilm } from "./film-store";
import { HttpError } from "./guard";
import { dataDir, resolveMedia } from "./roots";
import { atomicWriteJson, readJson, round3, serial } from "./ffmpeg/disk";
import { isStillMedia } from "./ffmpeg/graph";
import { probeMedia, renderPreview, type ProbeInfo } from "./ffmpeg/run";

export const MAX_ENTRIES = 20;
const STILL_MAX = 600; // a still can be held this long
const FILM_ID = /^f_[a-z0-9]{6,32}$/;
const SECTION_ID = /^[A-Za-z0-9_-]{1,40}$/;

export type Prober = (media: MediaSrc) => Promise<ProbeInfo | null>;
export const defaultProber: Prober = async (media) => {
  const abs = await resolveMedia(media);
  return abs ? probeMedia(abs) : null;
};

export function timelinePath(filmId: string, sectionId: string): string {
  if (!FILM_ID.test(filmId)) throw new HttpError(404, "No such film.");
  if (!SECTION_ID.test(sectionId)) throw new HttpError(404, "No such section.");
  return join(dataDir(), "timelines", filmId, `${sectionId}.json`);
}

export function resolveSection(film: Film, ref: string): Section {
  const section = findSection(film.sections, ref);
  if (!section) throw new HttpError(404, "No such section.");
  return section;
}

const secs = (n: number) => String(Number(Math.abs(n).toFixed(2)));
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${secs(n)}`;

// ── seeding ──────────────────────────────────────────────────────────────────

export async function seedTimeline(film: Film, section: Section, probe: Prober = defaultProber): Promise<Timeline> {
  const cards = film.cards
    .filter(
      (c) =>
        c.section === section.id &&
        c.slot !== null &&
        !c.reserve &&
        !!c.media &&
        c.kind !== "words" &&
        c.inCut !== false,
    )
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const clips: Clip[] = [];
  const shots: Shot[] = [];
  const edl: EdlEntry[] = [];
  const slots = new Set<number>();
  for (const card of cards) {
    const slot = card.slot as number;
    if (slots.has(slot)) continue; // one entry per slot (a superseded take shares the slot)
    if (edl.length >= MAX_ENTRIES) break;
    slots.add(slot);
    const media = card.media as MediaSrc;
    const still = card.kind === "image" || isStillMedia(media);
    const info = still ? null : await probe(media).catch(() => null);
    const lead = card.takes.find((t) => t.lead) ?? card.takes[0];
    let clipId = (lead?.id ?? card.id).split("/").pop() || `c${slot}`;
    if (clips.some((c) => c.id === clipId)) clipId = `${clipId}_${slot}`;
    const inn = round3(Math.max(0, card.in ?? 0));
    const cutLen =
      typeof card.cutIn === "number" && typeof card.cutOut === "number" && card.cutOut > card.cutIn
        ? card.cutOut - card.cutIn
        : null;
    let out = round3(card.out ?? (cutLen !== null ? inn + cutLen : null) ?? card.secs ?? info?.duration ?? 3);
    // Without a probe (no film env) the clip is assumed to hold the seeded out plus trim room.
    const duration = still ? STILL_MAX : (info?.duration ?? round3(Math.max(out, inn) + 30));
    if (out > duration) out = round3(duration);
    if (out <= inn) continue;
    clips.push({
      id: clipId,
      media,
      duration,
      width: info?.width ?? null,
      height: info?.height ?? null,
      fps: info?.fps ?? null,
      hasAudio: info?.hasAudio ?? false,
    });
    const shotId = `S${slot}`;
    shots.push({
      id: shotId,
      clipId,
      cardId: card.id,
      slot,
      in: inn,
      out,
      description: card.caption ?? "",
      tags: [],
    });
    edl.push({
      id: `e${edl.length + 1}`,
      ref: shotId,
      in: inn,
      out,
      transition: { type: "cut", dur: 0 },
      change: null,
      delta: null,
      recordIn: card.cutIn ?? null,
      recordOut: card.cutOut ?? null,
    });
  }
  const cue = film.sounds.find((s) => s.section === section.id && s.kind === "music" && s.selected && s.media);
  const importedFourth = film.source.kind === "import" && section.order === 4;
  return {
    filmId: film.id,
    section: section.id,
    baseRev: film.rev,
    version: 0,
    status: "draft",
    clips,
    shots,
    edl,
    words: [],
    inserts: [],
    sounds: [],
    music: cue?.media
      ? { media: cue.media, offset: importedFourth ? 13.041667 : 0, fadeOutAt: importedFourth ? 36.55 : null }
      : null,
    jobs: [],
    preview: null,
    lastChange: null,
    updatedAt: new Date().toISOString(),
  };
}

// ── pure helpers + guards ────────────────────────────────────────────────────

function joinDur(e: EdlEntry, index: number): number {
  return index === 0 || e.transition.type === "cut" ? 0 : e.transition.dur;
}

export function edlSecs(t: Pick<Timeline, "edl">): number {
  return round3(t.edl.reduce((sum, e, i) => sum + (e.out - e.in) - joinDur(e, i), 0));
}

/** Entry index for "e3" · "S3" · "3" · "sec04/S3" · an insert id. */
export function findEntryIndex(t: Timeline, ref: string): number {
  const r = ref.trim();
  let i = t.edl.findIndex((e) => e.id === r || e.ref === r);
  if (i >= 0) return i;
  i = t.edl.findIndex((e) => e.ref.toUpperCase() === r.toUpperCase());
  if (i >= 0) return i;
  if (/^\d{1,3}$/.test(r)) {
    i = t.edl.findIndex((e) => e.ref === `S${Number(r)}`);
    if (i >= 0) return i;
  }
  const shot = t.shots.find((s) => s.cardId === r);
  if (shot) {
    i = t.edl.findIndex((e) => e.ref === shot.id);
    if (i >= 0) return i;
  }
  const m = /\/S(\d+)(?:\/|$)/i.exec(r);
  if (m) {
    i = t.edl.findIndex((e) => e.ref === `S${Number(m[1])}`);
    if (i >= 0) return i;
  }
  throw new HttpError(422, `There is no shot ${r} in this edit.`);
}

function refExists(t: Timeline, ref: string): boolean {
  return t.shots.some((s) => s.id === ref) || t.inserts.some((x) => x.id === ref) || t.clips.some((c) => c.id === ref);
}

/** Source duration for a ref, or null when unknown (an insert video not probed yet). */
export function refDuration(t: Timeline, ref: string): number | null {
  const shot = t.shots.find((s) => s.id === ref);
  const clip = t.clips.find((c) => c.id === (shot ? shot.clipId : ref));
  if (clip) return clip.duration;
  const insert = t.inserts.find((x) => x.id === ref);
  if (insert && !insert.video && insert.still) return STILL_MAX;
  return null;
}

export function validateEdl(t: Timeline): void {
  if (t.edl.length === 0) throw new HttpError(422, "The edit needs at least one shot.");
  if (t.edl.length > MAX_ENTRIES) throw new HttpError(422, `The edit holds at most ${MAX_ENTRIES} shots.`);
  t.edl.forEach((e, i) => {
    if (!refExists(t, e.ref)) throw new HttpError(422, `There is no shot ${e.ref}.`);
    if (!(e.in >= 0)) throw new HttpError(422, `${e.ref}: the in point cannot be before 0 s.`);
    if (!(e.out > e.in)) throw new HttpError(422, `${e.ref}: the out point must come after the in point.`);
    const d = refDuration(t, e.ref);
    if (d !== null && e.out > d + 0.0005)
      throw new HttpError(422, `${e.ref}: the clip is only ${secs(d)} s long.`);
    const len = e.out - e.in;
    const into = joinDur(e, i);
    const next = i + 1 < t.edl.length ? joinDur(t.edl[i + 1], i + 1) : 0;
    if (into > 0 && len <= into) throw new HttpError(422, `${e.ref} is shorter than its ${e.transition.type} (${secs(into)} s).`);
    if (next > 0 && len <= next)
      throw new HttpError(422, `${e.ref} is shorter than the ${t.edl[i + 1].transition.type} after it (${secs(next)} s).`);
  });
}

function touched(t: Timeline, chip: string): Timeline {
  validateEdl(t);
  t.lastChange = chip;
  t.status = "draft";
  return t;
}

export function applyTrim(
  timeline: Timeline,
  body: { shot: string; in?: number; out?: number; delta?: number; edge?: "in" | "out" },
): Timeline {
  const t = structuredClone(timeline);
  const e = t.edl[findEntryIndex(t, body.shot)];
  if (body.delta === undefined && body.in === undefined && body.out === undefined)
    throw new HttpError(422, "Say how much to trim (delta) or give the new in/out.");
  const before = e.out - e.in;
  if (body.in !== undefined) e.in = round3(body.in);
  if (body.out !== undefined) e.out = round3(body.out);
  if (body.delta !== undefined) {
    if (body.edge === "in") e.in = round3(e.in - body.delta);
    else e.out = round3(e.out + body.delta);
  }
  const change = round3(e.out - e.in - before);
  e.delta = round3((e.delta ?? 0) + change);
  if (e.change !== "new") e.change = "trimmed";
  return touched(t, `trimmed ${signed(change)} s`);
}

export function applyMove(timeline: Timeline, body: { shot: string; index: number }): Timeline {
  const t = structuredClone(timeline);
  const from = findEntryIndex(t, body.shot);
  if (body.index < 0 || body.index >= t.edl.length)
    throw new HttpError(422, `There is no position #${body.index + 1}; the edit has ${t.edl.length} entries.`);
  const [e] = t.edl.splice(from, 1);
  t.edl.splice(body.index, 0, e);
  if (e.change !== "new") e.change = "moved";
  return touched(t, `moved to #${body.index + 1}`);
}

export function applyRemove(timeline: Timeline, body: { shot: string }): Timeline {
  const t = structuredClone(timeline);
  const i = findEntryIndex(t, body.shot);
  if (t.edl.length === 1) throw new HttpError(422, "The edit needs at least one shot.");
  const [e] = t.edl.splice(i, 1);
  return touched(t, `removed ${e.ref}`);
}

export function applyTransition(
  timeline: Timeline,
  body: { index: number; type: TransitionType; dur: number },
): Timeline {
  const t = structuredClone(timeline);
  if (body.index < 1 || body.index >= t.edl.length)
    throw new HttpError(
      422,
      `There is no entry ${body.index} to lead into. The index is 0-based: 1–${t.edl.length - 1}, where 1 = the second entry.`,
    );
  const dur = body.type === "cut" ? 0 : round3(body.dur);
  if (body.type !== "cut" && dur <= 0) throw new HttpError(422, `A ${body.type} needs a duration above 0 s.`);
  t.edl[body.index].transition = { type: body.type, dur };
  return touched(t, body.type === "cut" ? `cut into ${body.index}` : `${body.type} ${secs(dur)} s into ${body.index}`);
}

export function applyWords(
  timeline: Timeline,
  body: { text: string; start: number; end: number; png: MediaSrc | null },
): Timeline {
  const t = structuredClone(timeline);
  const total = edlSecs(t);
  if (!(body.start >= 0) || !(body.end > body.start))
    throw new HttpError(422, "The words need a start before their end.");
  if (body.start >= total) throw new HttpError(422, `The edit is only ${secs(total)} s long.`);
  if (t.words.length >= MAX_ENTRIES) throw new HttpError(422, `At most ${MAX_ENTRIES} word cards.`);
  t.words.push({
    id: `w_${randomBytes(4).toString("hex")}`,
    text: body.text,
    png: body.png,
    start: round3(body.start),
    end: round3(Math.min(body.end, total)),
  });
  return touched(t, `words ‘${body.text}’`);
}

/** sha256 over everything that changes the picture or the sound. */
export function edlHash(t: Timeline): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        t.edl.map((e) => [e.ref, e.in, e.out, e.transition.type, e.transition.dur]),
        t.words.map((w) => [w.text, w.start, w.end, w.png]),
        t.inserts.map((x) => [x.id, x.video, x.still]),
        t.sounds.map((s) => [s.media, s.at, s.gainDb]),
        t.music,
      ]),
    )
    .digest("hex");
}

// ── store ────────────────────────────────────────────────────────────────────

export async function loadTimeline(filmId: string, sectionRef: string): Promise<Timeline> {
  const film = await requireFilm(filmId);
  const section = resolveSection(film, sectionRef);
  const path = timelinePath(film.id, section.id);
  const existing = await readJson<Timeline>(path);
  if (existing) return existing;
  return serial(path, async () => {
    const again = await readJson<Timeline>(path);
    if (again) return again;
    const seeded = await seedTimeline(film, section);
    await atomicWriteJson(path, seeded);
    return seeded;
  });
}

export async function updateTimeline(
  filmId: string,
  sectionId: string,
  change: (t: Timeline) => Timeline,
): Promise<Timeline> {
  const film = await requireFilm(filmId);
  const section = resolveSection(film, sectionId);
  const path = timelinePath(film.id, section.id);
  return serial(path, async () => {
    const current = (await readJson<Timeline>(path)) ?? (await seedTimeline(film, section));
    const next = change(structuredClone(current));
    const saved: Timeline = {
      ...next,
      filmId: current.filmId,
      section: current.section,
      updatedAt: new Date().toISOString(),
    };
    await atomicWriteJson(path, saved);
    return saved;
  });
}

/** Re-seed from the film store (explicit only). Keeps the approved version count and jobs. */
export async function reseedTimeline(filmId: string, sectionRef: string): Promise<Timeline> {
  const film = await requireFilm(filmId);
  const section = resolveSection(film, sectionRef);
  const seeded = await seedTimeline(film, section);
  return updateTimeline(filmId, section.id, (cur) => ({
    ...seeded,
    version: cur.version,
    jobs: cur.jobs,
    lastChange: "reseeded from the film",
  }));
}

export async function renderPreviewFor(filmId: string, sectionId: string): Promise<CutResult> {
  const t = await loadTimeline(filmId, sectionId);
  const hash = edlHash(t);
  const r = await renderPreview(t);
  if (!r.ok) return { timeline: t, previewUrl: null, chip: `preview failed: ${r.error}` };
  const url = `/api/media?root=VETTU_WORK&p=${encodeURIComponent("p" in r.media ? r.media.p : "")}`;
  const saved = await updateTimeline(filmId, t.section, (cur) => {
    if (edlHash(cur) !== hash) return cur; // a newer edit renders its own preview
    cur.preview = { draft: cur.version + 1, url, secs: r.secs, renderedAt: new Date().toISOString() };
    return cur;
  });
  return { timeline: saved, previewUrl: url, chip: saved.lastChange };
}

/** Edit → save → await the preview. A render failure keeps the edit (200, previewUrl null). */
export async function applyCut(
  filmId: string,
  sectionRef: string,
  change: (t: Timeline) => Timeline,
): Promise<CutResult> {
  const saved = await updateTimeline(filmId, sectionRef, change);
  const result = await renderPreviewFor(filmId, saved.section);
  if (result.previewUrl === null) return result;
  return { ...result, chip: saved.lastChange };
}
