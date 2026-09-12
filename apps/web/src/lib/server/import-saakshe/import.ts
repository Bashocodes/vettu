/**
 * Import SAAKSHE §01–§07 from the film's own files into the VETTU store. READ-ONLY on the film
 * folders: only readFile / stat. Paths come only from roots.ts. VETTU writes only VETTU_DATA_DIR.
 * Numbers per section come from the state script; cards/sounds/plans from the board index; posters
 * from the board page; the world from the cast · locations · prop pages.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  sectionCode,
  type Film,
  type Letter,
  type LetterKind,
  type MediaSrc,
  type RunningCut,
  type Section,
  type World,
  type WorldMember,
} from "@/lib/contracts/film";
import { createFilm, listFilms, newFilmId, replaceFilm } from "../film-store";
import { HttpError } from "../guard";
import { filmEnvConfigured, mediaRoots, resolveMedia, runningCutRel } from "../roots";
import { audioNear, parsePosters, videoTags } from "./html";
import {
  buildCards,
  buildPlans,
  buildSounds,
  parseBoardIndex,
  type ImportRules,
  type RecordMapEntry,
} from "./index-cards";
import { parseFilmState, unreadable } from "./parse-state";
import { parseWorldPage } from "./world-pages";
import { withClipPosters } from "./posters";

export const SAAKSHE_NAME = "SAAKSHE";
/** Imported SAAKSHE = §01–§07 only. Later sections and the parked ones stay out. */
export const SAAKSHE_SECTIONS = ["01", "02", "03", "04", "05", "06", "07"] as const;
const ACTIVE_SECTION = "04";
const STATE_FILE = "_film_state.js";
const INDEX_FILE = "_board_index.json";
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

// §04 record map (BOARD_DATA §4b): S1–S13 play on the running cut at these frame counts @24 fps
// from frame 1730 (72.0833 s); S14/S15 do not. Every other section is unknown (null).
const RECORD_SECTION = "04";
const RECORD_FPS = 24;
const RECORD_START_FRAME = 1730;
const RECORD_FRAMES = [74, 122, 121, 98, 98, 50, 38, 39, 97, 50, 50, 98, 103];
const LEAD_TAKES: Record<string, string> = { "04/3": "92" };
const SELECTED_SOUNDS = new Set(["04/M5"]);
/** BOARD_DATA §8 — labels only, never a filter. */
const DEITY: Record<string, "caption" | "human"> = {
  "03/S3": "human",
  "03/F21": "human",
  "03/F22": "human",
  "03/F23": "human",
  "03/F24": "human",
  "03/F25": "human",
  "04/S3": "caption",
  "04/S10": "human",
  "04/S11": "human",
  "04/S14": "caption",
  "04/F246": "caption",
  "04/F248": "caption",
  "04/C93": "caption",
  "04/C95": "caption",
  "04/C96": "caption",
  "04/F89": "caption",
  "04/F38": "caption",
  "04/F50": "caption",
  "04/F95": "caption",
  "04/F106": "caption",
  "04/C1": "caption",
  "04/F66": "human",
  "04/F67": "human",
  "04/F68": "human",
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const trunc4 = (n: number) => Math.floor(n * 1e4 + 1e-6) / 1e4;

export function recordMapFor(sec: string, slot: number): RecordMapEntry | null {
  if (sec !== RECORD_SECTION) return null;
  if (!Number.isInteger(slot) || slot < 1 || slot > RECORD_FRAMES.length) {
    return { inCut: false, cutIn: null, cutOut: null, out: null };
  }
  const start = RECORD_START_FRAME + RECORD_FRAMES.slice(0, slot - 1).reduce((a, b) => a + b, 0);
  const frames = RECORD_FRAMES[slot - 1];
  return {
    inCut: true,
    cutIn: trunc4(start / RECORD_FPS),
    cutOut: trunc4((start + frames) / RECORD_FPS),
    out: round3(frames / RECORD_FPS),
  };
}

export function saaksheRules(posters: ReadonlyMap<string, string>): ImportRules {
  return {
    sections: SAAKSHE_SECTIONS,
    recordMap: recordMapFor,
    leadTake: (sec, slot) => LEAD_TAKES[`${sec}/${slot}`] ?? null,
    deity: (sec, key) => DEITY[`${sec}/${key}`] ?? null,
    selected: (sec, code) => SELECTED_SOUNDS.has(`${sec}/${code}`),
    posters,
  };
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** State sections §01–§07 → store sections (imported numbers, derived: false). */
export function stateSections(state: Record<string, unknown>): Section[] {
  const raw = state.FILM_SECTIONS;
  if (!Array.isArray(raw)) throw unreadable();
  return SAAKSHE_SECTIONS.map((id, i) => {
    const s = raw.find((x) => !!x && typeof x === "object" && (x as { id?: unknown }).id === id) as
      | Record<string, unknown>
      | undefined;
    if (!s || typeof s.name !== "string" || !s.name.trim()) throw unreadable();
    return {
      id: `s${id}`,
      code: sectionCode(i + 1),
      name: `THE ${s.name.trim().toUpperCase()}`,
      order: i + 1,
      targetSecs: finite(s.plan),
      cutSecs: finite(s.ms) ?? 0,
      full: s.m === "full",
      locked: s.lk === true,
      done: Math.round(finite(s.done) ?? 0),
      total: Math.round(finite(s.total) ?? 0),
      parked: s.out === true,
      derived: false,
    };
  });
}

const LETTER_KINDS = new Set<LetterKind>(["thing", "maker", "who", "spare-maker"]);

export function stateLetters(state: Record<string, unknown>): Record<string, Letter> {
  const raw = state.FILM_LETTERS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw unreadable();
  const out: Record<string, Letter> = {};
  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    const o = value as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o.colour !== "string") continue;
    const letter: Letter = { label: typeof o.label === "string" ? o.label : code, colour: o.colour };
    if (typeof o.kind === "string" && LETTER_KINDS.has(o.kind as LetterKind)) letter.kind = o.kind as LetterKind;
    if (typeof o.inUse === "boolean") letter.inUse = o.inUse;
    out[code] = letter;
  }
  return out;
}

async function readRequired(dir: string, name: string): Promise<string> {
  try {
    return await readFile(join(dir, name), "utf8");
  } catch {
    throw unreadable();
  }
}

async function readOptional(dir: string, name: string | null | undefined): Promise<string | null> {
  if (!name || !SAFE_NAME.test(name) || !name.endsWith(".html")) return null;
  try {
    return await readFile(join(dir, name), "utf8");
  } catch {
    return null;
  }
}

async function signature(path: string | null): Promise<string> {
  if (!path) return "-";
  try {
    const st = await stat(path);
    return `${st.mtimeMs}|${st.size}`;
  } catch {
    return "-";
  }
}

/** sha1-12 of mtime|size of state · index · board html · running cut. */
async function importRevOf(paths: (string | null)[]): Promise<string> {
  const sigs = await Promise.all(paths.map(signature));
  return createHash("sha1").update(sigs.join("\n")).digest("hex").slice(0, 12);
}

type PageRef = { code: string; page: string; colour: string | null };
function pageList(v: unknown): PageRef[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => {
    const o = x as Record<string, unknown> | null;
    return o && typeof o.code === "string" && typeof o.page === "string"
      ? [{ code: o.code, page: o.page, colour: typeof o.colour === "string" ? o.colour : null }]
      : [];
  });
}

async function loadWorld(reports: string, state: Record<string, unknown>, letters: Record<string, Letter>): Promise<World> {
  const load = async (
    refs: PageRef[],
    family: "cast" | "locations" | "props",
    member: (ref: PageRef) => { code: string; label: string; colour: string | null },
  ): Promise<WorldMember[]> => {
    const pages = await Promise.all(refs.map((r) => readOptional(reports, r.page)));
    return refs.flatMap((ref, i) => {
      const html = pages[i];
      return html === null ? [] : [parseWorldPage(html, member(ref), family)];
    });
  };
  const [cast, locations, props] = await Promise.all([
    load(pageList(state.FILM_CAST), "cast", (r) => ({
      code: r.code,
      label: letters[r.code]?.label ?? r.code.toLowerCase(),
      colour: letters[r.code]?.colour ?? null,
    })),
    load(
      pageList(state.FILM_WORLD).filter((r) => r.code === "LOCATIONS"),
      "locations",
      () => ({ code: "LOCATIONS", label: "the locations", colour: null }),
    ),
    load(pageList(state.FILM_PROPS), "props", (r) => ({
      code: r.code,
      label: r.code.toLowerCase(),
      colour: letters[r.colour ?? "PROPS"]?.colour ?? null,
    })),
  ]);
  return { cast, locations, props };
}

async function runningCutFor(
  reports: string,
  filmRoot: string,
  boardHtml: string | null,
  sections: Section[],
): Promise<RunningCut | null> {
  const rel = runningCutRel();
  if (!rel) return null;
  const to = round3(sections.filter((s) => !s.parked).reduce((a, s) => a + s.cutSecs, 0));
  let poster: MediaSrc | null = null;
  let musicBed: MediaSrc | null = null;
  if (boardHtml) {
    const target = resolve(filmRoot, rel);
    const tag = videoTags(boardHtml).find((v) => {
      try {
        return resolve(reports, decodeURIComponent(v.src)) === target;
      } catch {
        return false;
      }
    });
    if (tag?.poster && (await resolveMedia({ src: tag.poster }))) poster = { src: tag.poster };
    const bed = tag ? audioNear(boardHtml, tag.index) : null;
    if (bed && (await resolveMedia({ src: bed }))) musicBed = { src: bed };
  }
  return { media: { root: "FILM_ROOT", p: rel }, from: 0, to, poster, musicBed };
}

/** Build the imported film (not yet stored). */
export async function buildSaakshe(id: string): Promise<Omit<Film, "rev" | "createdAt" | "updatedAt">> {
  const roots = mediaRoots();
  const reports = roots.FILM_REPORTS_DIR;
  const filmRoot = roots.FILM_ROOT;
  if (!reports || !filmRoot) throw new HttpError(404, "film_env_unset", { error: "film_env_unset" });

  const [stateText, indexText] = await Promise.all([
    readRequired(reports, STATE_FILE),
    readRequired(reports, INDEX_FILE),
  ]);
  const state = parseFilmState(stateText);
  const index = parseBoardIndex(indexText);
  const boardName = index.board && SAFE_NAME.test(index.board) && index.board.endsWith(".html") ? index.board : null;
  const boardHtml = await readOptional(reports, boardName);
  const rules = saaksheRules(boardHtml ? parsePosters(boardHtml) : new Map());
  const sections = stateSections(state);
  const letters = stateLetters(state);
  const cutRel = runningCutRel();

  const [world, runningCut, importRev] = await Promise.all([
    loadWorld(reports, state, letters),
    runningCutFor(reports, filmRoot, boardHtml, sections),
    importRevOf([
      join(reports, STATE_FILE),
      join(reports, INDEX_FILE),
      boardName ? join(reports, boardName) : null,
      cutRel ? resolve(filmRoot, cutRel) : null,
    ]),
  ]);

  return {
    id,
    name: SAAKSHE_NAME,
    source: { kind: "import", importRev },
    activeSection: `s${ACTIVE_SECTION}`,
    targetSecs: null,
    letters,
    sections,
    cards: await withClipPosters(buildCards(index, rules)),
    sounds: buildSounds(index, rules),
    plans: buildPlans(index, rules),
    notes: [],
    world,
    runningCut,
  };
}

/** Re-import keeps the existing imported film's id (replaceFilm); first import creates it. */
export async function importSaakshe(): Promise<{ film: Film; created: boolean }> {
  if (!filmEnvConfigured()) throw new HttpError(404, "film_env_unset", { error: "film_env_unset" });
  const existing = (await listFilms()).find((f) => f.source?.kind === "import");
  const draft = await buildSaakshe(existing?.id ?? newFilmId());
  if (existing) {
    const film = await replaceFilm({ ...draft, rev: 0, createdAt: "", updatedAt: "" }, null);
    return { film, created: false };
  }
  return { film: await createFilm(draft), created: true };
}
