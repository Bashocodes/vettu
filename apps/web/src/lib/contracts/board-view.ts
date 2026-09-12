/**
 * GET /api/films/:id/board → BoardView (BOARD_DATA §6c computed from the store).
 * Dropped on purpose: inVettu · shown · shownSubtotal · stale · stats.hours/pace/lastCut/kling.
 * Browser-safe.
 */
import type { CardKind, CardLetter, CardStatus, FilmSource, Letter, SoundKind } from "./film";

export type TabName =
  | "R·CLIPS"
  | "R·IMAGES"
  | "SUBS"
  | "MUSIC"
  | "NARRATION"
  | "SFX"
  | "ASSETS"
  | "PLANS";
export const TAB_ORDER: readonly TabName[] = [
  "R·CLIPS",
  "R·IMAGES",
  "SUBS",
  "MUSIC",
  "NARRATION",
  "SFX",
  "ASSETS",
  "PLANS",
];

export interface TextStat {
  secs: number;
  text: string;
}

/**
 * Header maths over the film's own NON-PARKED sections (BOARD_DATA §2):
 * PLAN = Σ(full ? cutSecs : targetSecs ?? 0) · M = Σ cutSecs · % = round(100·M/PLAN) ·
 * clips = Σdone/Σtotal · secsLeft = round(PLAN − M) · toCreate = todo cards.
 * Imported SAAKSHE → "PLAN 3:27" · "M 3:27" · "100%" · "38/38" · "0 s" · "X 0".
 */
export interface BoardStats {
  plan: TextStat; // "PLAN 3:27"
  target: TextStat | null; // "→ 5:26" — only when the film sets targetSecs
  master: TextStat; // "M 3:27"
  pct: { value: number; text: string }; // "100%"
  clips: { done: number; total: number; text: string }; // "38/38"
  secsLeft: { value: number; text: string }; // "0 s"
  toCreate: { value: number; text: string }; // "X 0"
}

export interface BoardTake {
  id: string;
  kind: CardKind;
  url: string | null; // /api/media?… (never a filesystem path)
  poster: string | null;
  caption: string;
  maker: string | null;
  letters: CardLetter[];
  lead: boolean;
  secs: number | null;
}

export interface BoardCard {
  id: string; // "sec04/S3"
  section: string;
  slot: number | null;
  kind: CardKind; // "words" = words-only face (no media)
  url: string | null;
  poster: string | null;
  secs: number | null;
  in: number;
  out: number | null;
  letters: CardLetter[];
  caption: string;
  maker: string | null;
  status: CardStatus;
  takes: BoardTake[];
  reserve: boolean;
  inCut: boolean | null;
  cutIn: number | null;
  cutOut: number | null;
  deity: "caption" | "human" | null;
  upload: boolean;
}

export interface BoardSound {
  id: string;
  kind: SoundKind;
  code: string;
  name: string;
  url: string | null;
  selected: boolean;
}

export interface BoardSection {
  id: string;
  code: string; // "§04"
  name: string; // "THE JOURNEY"
  order: number;
  targetSecs: number | null;
  cutSecs: number;
  full: boolean;
  locked: boolean;
  done: number;
  total: number;
  /** store `parked` → always a boolean. Parked = dimmed, range "—", LATER, out of every sum. */
  out: boolean;
  headSecs: number | null; // null when out
  endSecs: number | null;
  range: { text: string; exact: boolean }; // "1:12.1–1:55.3" (en dash) · "≈…" when not exact · "—" when out
  durText: string; // "43s"
  chipSecs: string; // "43" · "31/60" · "60"
  glyphs: { cut: boolean; master: boolean; lock: boolean }; // ◇ ◆ 🔒
  colour: { bg: string; fg: string };
  tabs: TabName[]; // non-empty tabs only, in TAB_ORDER
  cards: BoardCard[]; // the grid: slotted, non-reserve, sorted by slot
  reserve: BoardCard[];
  music: BoardSound[];
  narration: BoardSound[];
  sfx: BoardSound[];
  plans: { id: string; title: string }[];
  notes: string[];
}

export interface BoardRunningCut {
  url: string;
  poster: string | null;
  from: number;
  to: number; // the player stops here
  lengthText: string; // fmt(to - from) → "3:27"
  musicBed: string | null;
}

export interface BoardView {
  rev: number; // store rev (use as If-Match)
  filmId: string;
  brand: "VETTU";
  film: string; // film name, e.g. "SAAKSHE"
  readOnly: false;
  active: string | null; // active section id
  source: FilmSource;
  importAvailable: boolean;
  stats: BoardStats;
  sections: BoardSection[]; // every section in order, parked included
  runningCut: BoardRunningCut | null;
  letters: Record<string, Letter>;
}
