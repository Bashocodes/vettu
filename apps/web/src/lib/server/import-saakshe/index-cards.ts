/**
 * The board index (JSON) → VETTU cards, sounds and plans (BOARD_DATA §1f–§1g, §6b). Pure.
 * Laws: keep only the imported section ids; the grid is `reserve === false` (the index's
 * cut/master/locked flags are SECTION-level and never drive a card); grid records group by
 * (sec, s) in index order → one Card per slot; its lead is the first record (or the rule's lead take).
 * Takes = the slot's clip records plus any non-lead stills, lead flagged.
 */
import { extname } from "node:path";
import type {
  Card,
  CardKind,
  CardLetter,
  CardStatus,
  MediaSrc,
  PlanNote,
  Sound,
  SoundKind,
  Take,
} from "@/lib/contracts/film";
import { unreadable } from "./parse-state";

export interface IndexRecord {
  sec: string;
  s: number | null;
  f: string | null;
  c: string[];
  secs: number | null;
  ef: string | null;
  x: number | null;
  src: string | null;
  caption: string;
  reserve: boolean;
  state: string;
  caption_maker: string;
  plan: number | null;
  title: string | null;
}
export interface IndexSound {
  code: number;
  sec: string;
  name: string;
  src: string | null;
}
export interface BoardIndex {
  board: string | null;
  records: IndexRecord[];
  music: IndexSound[];
  narration: IndexSound[];
  sfx: IndexSound[];
  plans: { sec: string; plan: number; title: string }[];
}

const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function parseBoardIndex(text: string): BoardIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw unreadable();
  }
  const top = obj(raw);
  if (!Array.isArray(top.records)) throw unreadable();
  const records: IndexRecord[] = top.records.map((r) => {
    const o = obj(r);
    return {
      sec: str(o.sec) ?? "",
      s: num(o.s),
      f: str(o.f),
      c: arr(o.c)
        .map(str)
        .filter((x): x is string => !!x),
      secs: num(o.secs),
      ef: str(o.ef),
      x: num(o.x),
      src: str(o.src) || null,
      caption: str(o.caption) ?? "",
      reserve: o.reserve === true,
      state: str(o.state) ?? "",
      caption_maker: str(o.caption_maker) ?? "none",
      plan: num(o.plan),
      title: str(o.title),
    };
  });
  const sounds = (key: string, codeKey: string, nameKey: string): IndexSound[] =>
    arr(top[key]).map((x) => {
      const o = obj(x);
      return { code: num(o[codeKey]) ?? 0, sec: str(o.sec) ?? "", name: str(o[nameKey]) ?? "", src: str(o.src) || null };
    });
  return {
    board: str(top.board),
    records,
    music: sounds("music", "m", "name"),
    narration: sounds("narration", "l", "text"),
    sfx: sounds("sfx", "q", "name"),
    plans: arr(top.plans).map((x) => {
      const o = obj(x);
      return { sec: str(o.sec) ?? "", plan: num(o.plan) ?? 0, title: str(o.title) ?? "" };
    }),
  };
}

const VIDEO = new Set([".mp4", ".m4v", ".webm", ".mov"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const STATUSES = new Set<CardStatus>(["locked", "master", "cut", "placed", "todo", "candidate", "plan"]);

export function kindOf(src: string | null): CardKind {
  if (!src) return "words";
  const ext = extname(src.split(/[?#]/)[0]).toLowerCase();
  if (VIDEO.has(ext)) return "clip";
  if (IMAGE.has(ext)) return "image";
  return "words";
}

const statusOf = (state: string): CardStatus =>
  STATUSES.has(state as CardStatus) ? (state as CardStatus) : "placed";

export interface RecordMapEntry {
  inCut: boolean;
  cutIn: number | null;
  cutOut: number | null;
  out: number | null;
}

export interface ImportRules {
  sections: readonly string[];
  /** Per-slot "plays in the running cut" map; null = unknown (inCut null). */
  recordMap(sec: string, slot: number): RecordMapEntry | null;
  /** The clip code that must lead a slot (e.g. "92"), or null for index order. */
  leadTake(sec: string, slot: number): string | null;
  /** Deity label by "S<n>" (grid) or "F<n>"/"C<n>" (reserve). Label only, never a filter. */
  deity(sec: string, key: string): "caption" | "human" | null;
  selected(sec: string, code: string): boolean;
  posters: ReadonlyMap<string, string>;
}

export const sectionIdOf = (sec: string) => `s${sec}`;
const prefix = (sec: string) => `sec${sec}`;

export function recordLetters(r: IndexRecord): CardLetter[] {
  const out: CardLetter[] = [];
  if (r.x != null) out.push({ code: "X", text: String(r.x) });
  if (r.f) out.push({ code: "F", text: r.f });
  if (r.c[0]) out.push({ code: "C", text: r.c[0] });
  if (r.ef) out.push({ code: "F", text: `${r.ef} · EF` });
  return out;
}

/** The caption without its "<MAKER> · " prefix; maker "none" → null. */
export function recordCaption(r: IndexRecord): { caption: string; maker: string | null } {
  const maker = r.caption_maker && r.caption_maker !== "none" ? r.caption_maker : null;
  const text = r.caption.trim();
  return { caption: maker && text.startsWith(`${maker} · `) ? text.slice(maker.length + 3) : text, maker };
}

const recordMedia = (r: IndexRecord): MediaSrc | null =>
  r.src && kindOf(r.src) !== "words" ? { src: r.src } : null;

function recordPoster(r: IndexRecord, rules: ImportRules): MediaSrc | null {
  if (!r.src || kindOf(r.src) !== "clip") return null;
  const poster = rules.posters.get(r.src);
  return poster ? { src: poster } : null;
}

const recordCode = (r: IndexRecord): string | null =>
  r.c[0] ? `C${r.c[0]}` : r.f ? `F${r.f}` : r.x != null ? `X${r.x}` : null;

export function buildCards(index: BoardIndex, rules: ImportRules): Card[] {
  const wanted = new Set(rules.sections);
  const used = new Set<string>();
  const unique = (id: string) => {
    let out = id;
    for (let k = 2; used.has(out); k++) out = `${id}-${k}`;
    used.add(out);
    return out;
  };

  const groups = new Map<string, IndexRecord[]>();
  const reserve: IndexRecord[] = [];
  for (const r of index.records) {
    if (!wanted.has(r.sec) || r.plan != null) continue;
    if (r.reserve) {
      reserve.push(r);
      continue;
    }
    if (r.s == null) continue;
    const key = `${r.sec}/${r.s}`;
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }

  const cards: Card[] = [];
  for (const records of groups.values()) {
    const sec = records[0].sec;
    const slot = records[0].s as number;
    let ordered = records;
    const leadC = rules.leadTake(sec, slot);
    if (leadC) {
      const i = records.findIndex((r) => r.c[0] === leadC);
      if (i > 0) ordered = [records[i], ...records.filter((_, k) => k !== i)];
    }
    const lead = ordered[0];
    const takeIds = new Set<string>();
    const takes: Take[] = ordered
      .filter((r) => r !== lead || kindOf(r.src) === "clip")
      .map((r, n) => {
        const base = `${prefix(sec)}/${recordCode(r) ?? `T${n + 1}`}`;
        let id = base;
        for (let k = 2; takeIds.has(id); k++) id = `${base}-${k}`;
        takeIds.add(id);
        const { caption, maker } = recordCaption(r);
        return {
          id,
          kind: kindOf(r.src),
          media: recordMedia(r),
          poster: recordPoster(r, rules),
          caption,
          maker,
          letters: recordLetters(r),
          lead: r === lead,
          secs: r.secs,
        };
      });
    const map = rules.recordMap(sec, slot);
    const { caption, maker } = recordCaption(lead);
    cards.push({
      id: unique(`${prefix(sec)}/S${slot}`),
      section: sectionIdOf(sec),
      slot,
      kind: kindOf(lead.src),
      media: recordMedia(lead),
      poster: recordPoster(lead, rules),
      secs: lead.secs,
      in: 0,
      out: map?.out ?? null,
      letters: recordLetters(lead),
      caption,
      maker,
      status: statusOf(lead.state),
      takes,
      reserve: false,
      inCut: map ? map.inCut : null,
      cutIn: map?.cutIn ?? null,
      cutOut: map?.cutOut ?? null,
      deity: rules.deity(sec, `S${slot}`),
    });
  }

  const counters = new Map<string, number>();
  for (const r of reserve) {
    const code = recordCode(r);
    let base: string;
    if (code) base = `${prefix(r.sec)}/${code}`;
    else {
      const n = (counters.get(r.sec) ?? 0) + 1;
      counters.set(r.sec, n);
      base = `${prefix(r.sec)}/R${n}`;
    }
    const { caption, maker } = recordCaption(r);
    cards.push({
      id: unique(base),
      section: sectionIdOf(r.sec),
      slot: null,
      kind: kindOf(r.src),
      media: recordMedia(r),
      poster: recordPoster(r, rules),
      secs: r.secs,
      in: 0,
      out: null,
      letters: recordLetters(r),
      caption,
      maker,
      status: statusOf(r.state),
      takes: [],
      reserve: true,
      inCut: null,
      cutIn: null,
      cutOut: null,
      deity: code ? rules.deity(r.sec, code) : null,
    });
  }
  return cards;
}

export function buildSounds(index: BoardIndex, rules: ImportRules): Sound[] {
  const wanted = new Set(rules.sections);
  const out: Sound[] = [];
  const add = (list: IndexSound[], kind: SoundKind, letter: string) => {
    for (const s of list) {
      if (!wanted.has(s.sec)) continue;
      const code = `${letter}${s.code}`;
      out.push({
        id: `${prefix(s.sec)}/${code}`,
        section: sectionIdOf(s.sec),
        kind,
        code,
        name: s.name,
        media: s.src ? { src: s.src } : null,
        selected: rules.selected(s.sec, code),
      });
    }
  };
  add(index.music, "music", "M");
  add(index.narration, "narration", "L");
  add(index.sfx, "sfx", "Q");
  return out;
}

export function buildPlans(index: BoardIndex, rules: ImportRules): PlanNote[] {
  const wanted = new Set(rules.sections);
  return index.plans
    .filter((p) => wanted.has(p.sec))
    .map((p) => ({ id: `${prefix(p.sec)}/PLAN${p.plan}`, section: sectionIdOf(p.sec), title: p.title }));
}
