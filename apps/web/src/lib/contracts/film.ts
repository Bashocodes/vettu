/**
 * VETTU film store contract — the ONE source for the board and WORLD.
 * Stored at VETTU_DATA_DIR/films/<id>.json. Browser-safe: types + pure helpers only.
 */

export type MediaRoot = "FILM_REPORTS_DIR" | "FILM_ROOT" | "LABS_OUT" | "VETTU_WORK";
export const MEDIA_ROOTS: readonly MediaRoot[] = [
  "FILM_REPORTS_DIR",
  "FILM_ROOT",
  "LABS_OUT",
  "VETTU_WORK",
];

/**
 * A media file. `src` is relative to FILM_REPORTS_DIR exactly as the board index
 * writes it (may contain `..` and percent-encoding). `root` + `p` is relative to that root.
 */
export type MediaSrc = { src: string } | { root: MediaRoot; p: string };

export type LetterKind = "thing" | "maker" | "who" | "spare-maker";
export interface Letter {
  label: string;
  colour: string;
  kind?: LetterKind;
  inUse?: boolean;
}
export interface CardLetter {
  code: string;
  text: string;
}

/** The S ladder word (BOARD_DATA §1g `state`). */
export type CardStatus = "locked" | "master" | "cut" | "placed" | "todo" | "candidate" | "plan";
export type CardKind = "clip" | "image" | "words";

export interface Take {
  id: string; // "sec04/C92"
  kind: CardKind;
  media: MediaSrc | null;
  poster: MediaSrc | null;
  caption: string;
  maker: string | null; // caption badge code (K NB MJ SD AE X L M Q) or null
  letters: CardLetter[]; // F / C / EF badges of this take
  lead: boolean;
  secs?: number | null;
}

export interface Card {
  id: string; // "sec04/S3" — never changes
  section: string; // Section.id
  slot: number | null; // S position; null for reserve / unslotted
  kind: CardKind;
  media: MediaSrc | null; // the lead take's media
  poster: MediaSrc | null;
  secs: number | null; // the board's slot seconds
  in: number; // seconds into the media
  out: number | null; // null = to the media's end
  letters: CardLetter[];
  caption: string;
  maker: string | null;
  status: CardStatus;
  takes: Take[]; // every take on this slot, lead first ([] = the card is its own only take)
  reserve: boolean;
  inCut?: boolean | null; // plays in the running cut (import record map); null = unknown
  cutIn?: number | null; // seconds on the running cut
  cutOut?: number | null;
  deity?: "caption" | "human" | null;
  upload?: boolean; // added by a user upload
}

export type SoundKind = "music" | "narration" | "sfx";
export interface Sound {
  id: string;
  section: string;
  kind: SoundKind;
  code: string; // "M5"
  name: string;
  media: MediaSrc | null;
  selected?: boolean;
}
export interface PlanNote {
  id: string;
  section: string;
  title: string;
}
export interface Note {
  section: string;
  text: string;
}

export interface Section {
  id: string; // never changes ("s04", "s_ab12")
  code: string; // "§" + two-digit order, recomputed on add/move/remove
  name: string; // "THE JOURNEY"
  order: number; // 1-based
  targetSecs: number | null;
  cutSecs: number;
  full: boolean;
  locked: boolean;
  done: number;
  total: number;
  parked: boolean;
  /** true = user section: cutSecs/done/total derive from its cards. false = imported numbers. */
  derived: boolean;
}

export interface WorldCard {
  id: string;
  label: string;
  code: string | null;
  todo: boolean;
  ar: string | null; // "9:16"
  media: MediaSrc | null;
}
export interface WorldTab {
  id: string;
  label: string; // "THE FACE"
  cards: WorldCard[];
}
export interface WorldMember {
  code: string; // "HER" · "LOCATIONS" · "POD"
  label: string;
  colour: string | null;
  tabs: WorldTab[]; // a page without tabs = one tab { id: "all", label: "" }
}
export interface World {
  cast: WorldMember[];
  locations: WorldMember[]; // SAAKSHE: one member "LOCATIONS" whose tabs are the places
  props: WorldMember[];
}

export interface RunningCut {
  media: MediaSrc;
  from: number;
  to: number; // stop here (imported SAAKSHE §01–§07 = 207.166)
  poster?: MediaSrc | null;
  musicBed?: MediaSrc | null;
}

export interface FilmSource {
  kind: "new" | "sample" | "import";
  importRev?: string;
}

export interface Film {
  id: string; // "f_…"
  rev: number; // +1 on every write; writes need If-Match: <rev>
  name: string;
  source: FilmSource;
  activeSection: string | null;
  targetSecs?: number | null; // `→ target` pill only when set
  letters: Record<string, Letter>;
  sections: Section[];
  cards: Card[];
  sounds: Sound[];
  plans: PlanNote[];
  notes: Note[];
  world: World;
  runningCut: RunningCut | null;
  createdAt: string;
  updatedAt: string;
}

export interface FilmSummary {
  id: string;
  name: string;
  sections: number;
  updatedAt: string;
  source: FilmSource;
}

export interface FilmsList {
  films: FilmSummary[];
  importAvailable: boolean; // film env set → show "Import SAAKSHE"
}

// ── pure helpers (browser-safe) ───────────────────────────────────────────────

export function sectionCode(order: number): string {
  return `§${String(order).padStart(2, "0")}`;
}

/** Board `fmt(t)`: m:ss, seconds rounded, 60 rolls into the next minute (board:264-265). */
export function fmt(t: number): string {
  let m = Math.floor(t / 60);
  let s = Math.round(t - 60 * m);
  if (s === 60) {
    m += 1;
    s = 0;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Board `f1(t)`: m:ss.t in tenths; t < 0.05 → "0:00" (board:310). */
export function f1(t: number): string {
  if (t < 0.05) return "0:00";
  let m = Math.floor(t / 60);
  let rest = (t - 60 * m).toFixed(1);
  if (rest === "60.0") {
    m += 1;
    rest = "0.0";
  }
  return `${m}:${rest.padStart(4, "0")}`;
}

/** `filmSectionColor(s)` → [bg, fg] (state:72-80). */
export function sectionColour(s: Pick<Section, "parked" | "full" | "done" | "total">): {
  bg: string;
  fg: string;
} {
  if (s.parked) return { bg: "#26202e", fg: "#625f6b" };
  if (s.full) return { bg: "#123a2a", fg: "#35d492" };
  const r = s.total > 0 ? s.done / s.total : 0;
  if (r >= 0.75) return { bg: "#2c3a12", fg: "#a8c944" };
  if (r >= 0.5) return { bg: "#3b3012", fg: "#f2b53d" };
  if (r > 0) return { bg: "#33240f", fg: "#c47a2a" };
  return { bg: "#46201f", fg: "#ff6161" };
}

/** `letterColour(code)` (state:65-68), fallback #85828e. */
export function letterColour(letters: Record<string, Letter>, code: string): string {
  return letters[code]?.colour ?? "#85828e";
}

/** Media URL for the browser. Never a filesystem path. */
export function mediaUrl(m: MediaSrc | null | undefined): string | null {
  if (!m) return null;
  if ("src" in m) return `/api/media?src=${encodeURIComponent(m.src)}`;
  return `/api/media?root=${m.root}&p=${encodeURIComponent(m.p)}`;
}

/** Find a section by id, code ("§04", "04", "4") or name (case-insensitive). */
export function findSection<S extends Pick<Section, "id" | "code" | "name" | "order">>(
  sections: S[],
  ref: string,
): S | undefined {
  const r = ref.trim();
  const byId = sections.find((s) => s.id === r);
  if (byId) return byId;
  const digits = r.replace(/^§/, "");
  if (/^\d{1,2}$/.test(digits)) {
    const n = Number(digits);
    const byOrder = sections.find((s) => s.order === n);
    if (byOrder) return byOrder;
  }
  const upper = r.toUpperCase();
  return (
    sections.find((s) => s.code === r) ??
    sections.find((s) => s.name.toUpperCase() === upper) ??
    sections.find((s) => s.name.toUpperCase() === `THE ${upper}`)
  );
}
