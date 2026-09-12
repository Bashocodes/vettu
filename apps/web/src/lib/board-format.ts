/**
 * Pure helpers for the BOARD + WORLD UI (DESIGN §4, BOARD_DATA §2 + §7). Browser-safe, no React.
 */
import { f1 } from "./contracts/film";
import type { CardStatus } from "./contracts/film";
import type { EdlChange, EdlEntry, Insert, Timeline } from "./contracts/timeline";

const MINUS = "−";

/** Running-cut readout `m:ss.cc` (board:499-503). */
export function centis(t: number): string {
  const v = Number.isFinite(t) && t > 0 ? t : 0;
  let m = Math.floor(v / 60);
  let s = (v - 60 * m).toFixed(2);
  if (s === "60.00") {
    m += 1;
    s = "0.00";
  }
  return `${m}:${s.padStart(5, "0")}`;
}

/** `m:ss.t` for the EDIT pill (always shows the tenth, unlike `f1`). */
export function tenths(t: number): string {
  const v = Number.isFinite(t) && t > 0 ? t : 0;
  let m = Math.floor(v / 60);
  let s = (v - 60 * m).toFixed(1);
  if (s === "60.0") {
    m += 1;
    s = "0.0";
  }
  return `${m}:${s.padStart(4, "0")}`;
}

/** `+0.5 s` · `−3.0 s` · `±0.0 s` (one decimal, true minus sign). */
export function signedSecs(d: number): string {
  const r = Math.round((Number.isFinite(d) ? d : 0) * 10) / 10;
  if (r === 0) return "±0.0 s";
  return `${r > 0 ? "+" : MINUS}${Math.abs(r).toFixed(1)} s`;
}

/** A caption clipped to 7 words, then ` …` (board:1354). */
export function clipWords(text: string, max = 7): string {
  const words = (text ?? "").trim().split(/\s+/).filter(Boolean);
  return words.length <= max ? words.join(" ") : `${words.slice(0, max).join(" ")} …`;
}

export type Ladder = "b-placed" | "b-cut" | "b-master" | "b-locked";

/** The S ladder class from a card status (DESIGN §4.6). */
export function ladderClass(status: CardStatus): Ladder {
  switch (status) {
    case "locked":
      return "b-locked";
    case "master":
      return "b-master";
    case "cut":
      return "b-cut";
    default:
      return "b-placed";
  }
}

/** Slot seconds as the board prints them: `3.1s` · `5s`; null when unknown. */
export function secsText(secs: number | null | undefined): string | null {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return null;
  return `${Number(secs.toFixed(1))}s`;
}

/** Faint `in–out` card timecode (en dash, `f1`). */
export function rangeText(a: number | null | undefined, b: number | null | undefined): string | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return `${f1(a)}–${f1(b)}`;
}

/** `"M5"` → `{ letter: "M", rest: "5" }` for a register badge. */
export function splitCode(code: string): { letter: string; rest: string } {
  const m = /^([A-Za-z]+)(.*)$/.exec(code ?? "");
  return m ? { letter: m[1].toUpperCase(), rest: m[2] } : { letter: code ?? "", rest: "" };
}

/** Section number without the `§`: `"§04"` → `"04"`. */
export function sectionNumber(code: string): string {
  return (code ?? "").replace(/^§/, "");
}

// ── YOUR EDIT (BOARD_DATA §7) ────────────────────────────────────────────────

export interface EditChip {
  ref: string; // "S3"
  text: string; // "trimmed +0.5 s"
  change: EdlChange;
}

export interface InsertedEntry {
  entry: EdlEntry;
  insert: Insert | null;
  text: string;
}

export interface EditDiff {
  show: boolean;
  approved: boolean;
  label: string; // "VETTU v1 · DRAFT" · "VETTU v2 · APPROVED"
  editSecs: number; // Σ(out − in) of entries that play
  recordSecs: number; // Σ(recordOut − recordIn) of the seeded slots
  delta: number;
  pill: string; // "EDIT 0:43.2 (±0.0 s)"
  lastChange: string | null;
  chips: Record<string, EditChip>; // keyed "S" + slot
  inserted: InsertedEntry[];
  words: number;
}

export interface DiffCard {
  id?: string;
  slot: number | null;
  inCut?: boolean | null;
  cutIn?: number | null;
  cutOut?: number | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `b − a` when both are numbers and b > a, else null. */
function span(a: number | null | undefined, b: number | null | undefined): number | null {
  return isNum(a) && isNum(b) && b > a ? b - a : null;
}

/** The neutral chip text for one EDL entry. */
export function changeText(entry: Pick<EdlEntry, "change" | "delta">): string | null {
  switch (entry.change) {
    case "moved":
      return "moved";
    case "removed":
      return "removed";
    case "new":
      return "new";
    case "trimmed":
      return entry.delta !== null && entry.delta !== undefined && Math.round(entry.delta * 10) !== 0
        ? `trimmed ${signedSecs(entry.delta)}`
        : "trimmed";
    default:
      return null;
  }
}

const SLOT_REF = /^S\d+$/;

/**
 * Compare the edit timeline with the film of record. The record pills never change because of
 * this — it only feeds the YOUR EDIT strip, the per-card chips and the inserted "not yet" cards.
 *
 * The record baseline is `timeline.shots` (the seeded slots — trims, moves and removals only
 * change `edl`). A shot's record length is its entry's `recordOut − recordIn` when set; for a
 * shot no longer in the EDL, its card's `cutOut − cutIn` (`cards` = the section's grid); else the
 * seeded `out − in`. A seeded slot missing from the EDL counts as removed.
 */
export function editDiff(timeline: Timeline | null, cards: readonly DiffCard[] = []): EditDiff | null {
  if (!timeline) return null;
  const edl = Array.isArray(timeline.edl) ? timeline.edl : [];
  const inserts = Array.isArray(timeline.inserts) ? timeline.inserts : [];
  const shots = Array.isArray(timeline.shots) ? timeline.shots : [];
  const approved = timeline.status === "approved";
  const chips: Record<string, EditChip> = {};
  const inserted: InsertedEntry[] = [];
  const entryByRef = new Map<string, EdlEntry>();
  let editSecs = 0;
  let recordSecs = 0;
  let changed = false;

  edl.forEach((entry, index) => {
    if (!entryByRef.has(entry.ref)) entryByRef.set(entry.ref, entry);
    if (entry.change) changed = true;
    if (index > 0 && entry.transition && entry.transition.type !== "cut") changed = true;
    if (entry.change !== "removed") editSecs += Math.max(0, entry.out - entry.in);
    const text = changeText(entry);
    const insert = inserts.find((i) => i.id === entry.ref) ?? null;
    if (!SLOT_REF.test(entry.ref) && (entry.temp === true || insert !== null || entry.ref.startsWith("ins_"))) {
      inserted.push({ entry, insert, text: text ?? "new" });
    } else if (text && entry.change) {
      chips[entry.ref] = { ref: entry.ref, text, change: entry.change };
    }
  });

  for (const shot of shots) {
    if (shot.slot === null || shot.slot === undefined) continue;
    const entry = entryByRef.get(shot.id);
    const gone = !entry || entry.change === "removed";
    let length = entry ? span(entry.recordIn, entry.recordOut) : null;
    if (length === null && gone) {
      const card =
        (shot.cardId ? cards.find((c) => c.id === shot.cardId) : undefined) ??
        cards.find((c) => c.slot === shot.slot);
      length = card ? span(card.cutIn, card.cutOut) : null;
    }
    recordSecs += length ?? Math.max(0, shot.out - shot.in);
    if (gone) {
      const key = `S${shot.slot}`;
      if (!chips[key]) chips[key] = { ref: key, text: "removed", change: "removed" };
      changed = true;
    }
  }

  const words = Array.isArray(timeline.words) ? timeline.words.length : 0;
  const lastChange = timeline.lastChange ?? null;
  const delta = editSecs - recordSecs;
  return {
    show: changed || lastChange !== null || words > 0 || inserts.length > 0 || timeline.version > 0,
    approved,
    label: approved ? `VETTU v${timeline.version} · APPROVED` : `VETTU v${timeline.version + 1} · DRAFT`,
    editSecs,
    recordSecs,
    delta,
    pill: `EDIT ${tenths(editSecs)} (${signedSecs(delta)})`,
    lastChange: timeline.lastChange ?? null,
    chips,
    inserted,
    words,
  };
}
