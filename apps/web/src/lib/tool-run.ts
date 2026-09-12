/**
 * Pure helpers behind VETTU's chat tools (LIVE voice runs the same tools through CopilotKit).
 * Browser-safe and framework-free: contracts only — no fetch, no DOM, no React.
 */
import type { z } from "zod";
import { findSection } from "@/lib/contracts/film";
import type { BoardCard, BoardSection, BoardView } from "@/lib/contracts/board-view";
import type { CutResult, EdlEntry, Shot, Timeline } from "@/lib/contracts/timeline";
import { VETTU_TOOLS, type ToolResult, type VettuToolArgs, type VettuToolName } from "@/lib/contracts/tools";
import type { WorldView, WorldViewMember } from "@/lib/contracts/world-view";

/** Structurally identical to CopilotKit's JsonSerializable. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const NO_FILM = "No film is open. Open or import a film on the board first.";

// ── numbers + text ───────────────────────────────────────────────────────────

const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};
export const r1 = (n: number) => round(n, 1);
export const r3 = (n: number) => round(n, 3);

/** "3.1 s" */
export function secsText(secs: number): string {
  return `${r1(secs).toFixed(1)} s`;
}

export function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

export function sectionLabel(s: Pick<BoardSection, "code" | "name">): string {
  return `${s.code} ${s.name}`;
}

// ── results ──────────────────────────────────────────────────────────────────

export function ok(message: string, data?: Json): ToolResult {
  return data === undefined ? { status: "ok", message } : { status: "ok", message, data };
}

export function fail(message: string): ToolResult {
  return { status: "error", message };
}

/** ApiError / Error → its (controlled) message; anything else → the fallback. */
export function errorMessage(error: unknown, fallback = "VETTU could not finish that. Try again."): string {
  if (error instanceof Error && error.message.trim()) return clip(error.message, 300);
  return fallback;
}

/** Validate model arguments against THE registry schema before any request goes out. */
export function validateToolArgs<N extends VettuToolName>(
  name: N,
  args: unknown,
): { ok: true; data: VettuToolArgs<N> } | { ok: false; message: string } {
  const schema = VETTU_TOOLS[name].parameters as unknown as z.ZodType<VettuToolArgs<N>>;
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.map(String).join(".") || "arguments"}: ${issue.message}`);
  return { ok: false, message: `${name} needs valid arguments — ${issues.join("; ")}` };
}

/** "VETTU PREVIEW v2" when the route rendered a preview, else null. */
export function previewText(cut: Pick<CutResult, "previewUrl" | "timeline">): string | null {
  const preview = cut.timeline?.preview;
  return cut.previewUrl && preview ? `VETTU PREVIEW v${preview.draft}` : null;
}

/** A cut tool's answer: what changed · the route's chip · the preview number. */
export function okCut(what: string, cut: CutResult): ToolResult {
  const preview = previewText(cut);
  const parts = [what, cut.chip && cut.chip !== what ? cut.chip : null, preview ?? (cut.chip ? null : "no preview yet")];
  const info = cut.timeline.preview;
  return ok(parts.filter(Boolean).join(" · "), {
    chip: cut.chip,
    preview: preview && info ? { draft: info.draft, secs: r1(info.secs) } : null,
    entries: cut.timeline.edl.length,
    version: cut.timeline.version,
    lastChange: cut.timeline.lastChange,
  });
}

/** Entry length in seconds. */
export function entrySecs(entry: Pick<EdlEntry, "in" | "out">): number {
  return Math.max(0, entry.out - entry.in);
}

// ── section refs ─────────────────────────────────────────────────────────────

export type SectionResolution = { ok: true; section: BoardSection } | { ok: false; message: string };

export function sectionList(sections: ReadonlyArray<Pick<BoardSection, "code" | "name">>): string {
  return sections.length ? sections.map(sectionLabel).join(" · ") : "none yet — add a section first";
}

/**
 * Section id, code ("§04", "04", "4", "section 4") or name ("THE JOURNEY", "journey").
 * Empty ref → the open section.
 */
export function resolveSectionRef(
  board: Pick<BoardView, "sections"> | null | undefined,
  ref: string | null | undefined,
  activeSection: string | null | undefined,
): SectionResolution {
  if (!board) return { ok: false, message: NO_FILM };
  const wanted = (typeof ref === "string" ? ref : "").trim().replace(/^(section|sec)\s+/i, "");
  if (!wanted) {
    const open = activeSection ? board.sections.find((s) => s.id === activeSection) : undefined;
    if (open) return { ok: true, section: open };
    return { ok: false, message: `No section is open. Name one: ${sectionList(board.sections)}` };
  }
  const found = findSection(board.sections, wanted);
  if (found) return { ok: true, section: found };
  return { ok: false, message: `No section "${clip(wanted, 40)}" in this film. Valid: ${sectionList(board.sections)}` };
}

// ── shot refs ────────────────────────────────────────────────────────────────

export type ShotResolution =
  | { ok: true; entry: EdlEntry; position: number; shot: Shot | null }
  | { ok: false; message: string };

export function shotList(timeline: Pick<Timeline, "edl">): string {
  const refs = timeline.edl.slice(0, 24).map((e) => e.ref);
  if (!refs.length) return "the edit is empty";
  const more = timeline.edl.length > refs.length ? " · …" : "";
  return `${refs.join(" · ")}${more} (or positions 1–${timeline.edl.length})`;
}

/**
 * Shot reference → an EDL entry. Accepts an entry id ("e3"), a shot or insert id ("S3", "s3", "ins_…"),
 * a card id ("sec04/S3"), a slot number ("3", "shot 3", "card 3"), or a 1-based edit position
 * ("entry 3", "position 3"; a bare number falls back to the position only when no shot has that slot).
 */
export function resolveShotRef(timeline: Pick<Timeline, "edl" | "shots">, ref: string): ShotResolution {
  const edl = timeline.edl;
  const raw = String(ref ?? "").trim();
  const notFound: ShotResolution = {
    ok: false,
    message: `No shot "${clip(raw, 40)}" in this edit. Valid: ${shotList(timeline)}`,
  };
  if (!raw) return { ok: false, message: `Say which shot. Valid: ${shotList(timeline)}` };
  if (!edl.length) return { ok: false, message: "This section's edit is empty." };
  const hit = (index: number): ShotResolution => ({
    ok: true,
    entry: edl[index],
    position: index + 1,
    shot: timeline.shots.find((s) => s.id === edl[index].ref) ?? null,
  });

  let index = edl.findIndex((e) => e.id === raw);
  if (index >= 0) return hit(index);

  const upper = raw.toUpperCase();
  index = edl.findIndex((e) => e.ref === raw || e.ref.toUpperCase() === upper);
  if (index >= 0) return hit(index);

  const byCard = timeline.shots.find((s) => s.cardId === raw);
  if (byCard) {
    index = edl.findIndex((e) => e.ref === byCard.id);
    if (index >= 0) return hit(index);
    return { ok: false, message: `${byCard.id} is not in this edit any more. Valid: ${shotList(timeline)}` };
  }
  if (raw.includes("/")) {
    const tail = raw.slice(raw.lastIndexOf("/") + 1).toUpperCase();
    index = edl.findIndex((e) => e.ref.toUpperCase() === tail);
    if (index >= 0) return hit(index);
  }

  const numbered = /^(shot|card|slot|entry|position|s|#)?\s*#?\s*(\d{1,3})$/i.exec(raw);
  if (numbered) {
    const word = (numbered[1] ?? "").toLowerCase();
    const n = Number(numbered[2]);
    if (word !== "entry" && word !== "position") {
      const slotted = timeline.shots.find((s) => s.slot === n);
      if (slotted) {
        index = edl.findIndex((e) => e.ref === slotted.id);
        if (index >= 0) return hit(index);
        return { ok: false, message: `${slotted.id} is not in this edit any more. Valid: ${shotList(timeline)}` };
      }
      if (word === "s" || word === "slot") return notFound;
    }
    if (n >= 1 && n <= edl.length) return hit(n - 1);
  }
  return notFound;
}

// ── find_shot ────────────────────────────────────────────────────────────────

export type ShotMatch = {
  ref: string;
  entry: string | null;
  position: number | null;
  in: number | null;
  out: number | null;
  description: string;
  tags: string[];
  cardId: string | null;
  score: number;
};

type CardLike = Pick<BoardCard, "id" | "slot" | "caption" | "in" | "out">;

/** Local search over the section's shots, inserts and card captions. Best first, at most `limit`. */
export function findShots(
  query: string,
  timeline: Pick<Timeline, "edl" | "shots" | "inserts"> | null | undefined,
  cards: ReadonlyArray<CardLike>,
  limit = 10,
): ShotMatch[] {
  const q = query.toLowerCase().replace(/\s+/g, " ").trim();
  const tokens = q.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  const terms = tokens.length ? tokens : q ? [q] : [];
  if (!terms.length) return [];
  const score = (hay: string) => {
    const h = hay.toLowerCase();
    let s = 0;
    for (const t of terms) if (h.includes(t)) s += 1;
    if (terms.length > 1 && h.includes(q)) s += 1;
    return s;
  };

  const edl = timeline?.edl ?? [];
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const seenCards = new Set<string>();
  const matches: ShotMatch[] = [];
  const place = (ref: string) => {
    const i = edl.findIndex((e) => e.ref === ref);
    return i >= 0 ? { entry: edl[i], position: i + 1 } : null;
  };

  for (const shot of timeline?.shots ?? []) {
    if (shot.cardId) seenCards.add(shot.cardId);
    const card = shot.cardId ? cardById.get(shot.cardId) : undefined;
    const s = score([shot.id, shot.description, ...shot.tags, card?.caption ?? ""].join(" "));
    if (!s) continue;
    const at = place(shot.id);
    matches.push({
      ref: shot.id,
      entry: at?.entry.id ?? null,
      position: at?.position ?? null,
      in: r3(at?.entry.in ?? shot.in),
      out: r3(at?.entry.out ?? shot.out),
      description: clip(shot.description || card?.caption, 120),
      tags: shot.tags.slice(0, 8),
      cardId: shot.cardId,
      score: s,
    });
  }
  for (const insert of timeline?.inserts ?? []) {
    const s = score(`${insert.id} insert ${insert.prompt}`);
    if (!s) continue;
    const at = place(insert.id);
    matches.push({
      ref: insert.id,
      entry: at?.entry.id ?? null,
      position: at?.position ?? null,
      in: at ? r3(at.entry.in) : null,
      out: at ? r3(at.entry.out) : null,
      description: clip(`insert (${insert.status}) · ${insert.prompt}`, 120),
      tags: [],
      cardId: null,
      score: s,
    });
  }
  for (const card of cards) {
    if (seenCards.has(card.id)) continue;
    const slotRef = card.slot != null ? `S${card.slot}` : null;
    const s = score(`${slotRef ?? ""} ${card.caption}`);
    if (!s) continue;
    matches.push({
      ref: slotRef ?? card.id,
      entry: null,
      position: null,
      in: r3(card.in),
      out: card.out == null ? null : r3(card.out),
      description: clip(card.caption, 120),
      tags: [],
      cardId: card.id,
      score: s,
    });
  }
  return matches
    .sort((a, b) => b.score - a.score || (a.position ?? 1e9) - (b.position ?? 1e9))
    .slice(0, Math.max(0, limit));
}

export function findShotsMessage(query: string, section: Pick<BoardSection, "code" | "name">, matches: ShotMatch[]): string {
  if (!matches.length) return `No shot in ${sectionLabel(section)} matches "${clip(query, 60)}".`;
  const list = matches
    .slice(0, 5)
    .map((m) => `${m.ref}${m.position ? ` (#${m.position})` : " (not in the edit)"} ${clip(m.description, 50)}`)
    .join("; ");
  return `${matches.length} match${matches.length === 1 ? "" : "es"} in ${sectionLabel(section)}: ${list}`;
}

// ── results coming back from the chat (strings) ──────────────────────────────

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A tool result as it comes back in a render prop (a JSON string) → ToolResult, or null. */
export function parseToolResult(result: unknown): ToolResult | null {
  const value = typeof result === "string" ? safeJson(result) : result;
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.status === "error" && typeof v.message === "string") return { status: "error", message: v.message };
  if (v.status === "ok" && typeof v.message === "string") return { status: "ok", message: v.message, data: v.data };
  return null;
}

/** The job id inside a job tool's result: data.jobId · data.job.id · jobId · job.id · a "job_…" token. */
export function parseJobId(result: unknown): string | null {
  const value = typeof result === "string" ? safeJson(result) : result;
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (record?.status === "error") return null;
  const dig = (x: unknown): string | null => {
    if (!x || typeof x !== "object") return null;
    const o = x as Record<string, unknown>;
    if (typeof o.jobId === "string" && o.jobId.trim()) return o.jobId.trim();
    const job = o.job;
    if (job && typeof job === "object" && typeof (job as Record<string, unknown>).id === "string") {
      const id = String((job as Record<string, unknown>).id).trim();
      if (id) return id;
    }
    return null;
  };
  const found = dig(record?.data) ?? dig(record);
  if (found) return found;
  const text = typeof result === "string" ? result : typeof record?.message === "string" ? record.message : "";
  const token = /\bjob_[A-Za-z0-9_-]+/.exec(text);
  return token ? token[0] : null;
}

// ── agent context ────────────────────────────────────────────────────────────

export type WorldFamilyCount = {
  members: number;
  filled: number;
  total: number;
};
export type WorldCounts = {
  cast: WorldFamilyCount;
  locations: WorldFamilyCount;
  props: WorldFamilyCount;
};

function familyCount(members: ReadonlyArray<Pick<WorldViewMember, "filled" | "total">> | null | undefined): WorldFamilyCount {
  const list = members ?? [];
  return {
    members: list.length,
    filled: list.reduce((n, m) => n + (m.filled ?? 0), 0),
    total: list.reduce((n, m) => n + (m.total ?? 0), 0),
  };
}

export function worldCounts(world: Pick<WorldView, "cast" | "locations" | "props"> | null | undefined): WorldCounts | null {
  if (!world) return null;
  return { cast: familyCount(world.cast), locations: familyCount(world.locations), props: familyCount(world.props) };
}

export interface ContextInput {
  board: BoardView | null;
  timeline: Timeline | null;
  activeSection: string | null;
  world?: WorldCounts | null;
}

/** Roughly the budget for the useAgentContext value (bytes of JSON). */
export const CONTEXT_BUDGET = 8000;

function buildContext(input: ContextInput, caps: { cards: number; caption: number; edl: number; words: number }): Json {
  const { board, timeline } = input;
  if (!board) return { film: null, note: NO_FILM };
  const active = input.activeSection ? (board.sections.find((s) => s.id === input.activeSection) ?? null) : null;
  const w = input.world ?? null;
  const tl = timeline && active && timeline.section === active.id ? timeline : null;
  return {
    film: { id: board.filmId, name: board.film, rev: board.rev },
    stats: [board.stats?.plan?.text, board.stats?.master?.text, board.stats?.pct?.text, board.stats?.clips?.text]
      .filter(Boolean)
      .join(" · "),
    sections: board.sections.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      cutSecs: r1(s.cutSecs),
      targetSecs: s.targetSecs == null ? null : r1(s.targetSecs),
      out: s.out,
      done: s.done,
      total: s.total,
      full: s.full,
    })),
    active: active ? { id: active.id, code: active.code, name: active.name } : null,
    cards: active
      ? active.cards.slice(0, caps.cards).map((c) => ({
          slot: c.slot,
          kind: c.kind,
          caption: clip(c.caption, caps.caption),
          secs: c.secs == null ? null : r1(c.secs),
          inCut: c.inCut ?? null,
        }))
      : [],
    moreCards: active ? Math.max(0, active.cards.length - caps.cards) : 0,
    world: w
      ? {
          cast: { ...w.cast },
          locations: { ...w.locations },
          props: { ...w.props },
        }
      : null,
    timeline: tl
      ? {
          section: tl.section,
          version: tl.version,
          status: tl.status,
          edl: tl.edl.slice(0, caps.edl).map((e) => ({
            id: e.id,
            ref: e.ref,
            in: r3(e.in),
            out: r3(e.out),
            transition: { type: e.transition.type, dur: r3(e.transition.dur) },
            change: e.change,
            delta: e.delta == null ? null : r3(e.delta),
          })),
          moreEntries: Math.max(0, tl.edl.length - caps.edl),
          words: tl.words.slice(0, caps.words).map((wc) => ({
            id: wc.id,
            text: clip(wc.text, 80),
            start: r3(wc.start),
            end: r3(wc.end),
          })),
          inserts: tl.inserts.map((i) => ({ id: i.id, status: i.status })),
          preview: tl.preview ? { draft: tl.preview.draft, secs: r1(tl.preview.secs) } : null,
          lastChange: tl.lastChange,
        }
      : null,
  };
}

/** The JSON-safe value for useAgentContext, kept under CONTEXT_BUDGET by shrinking caps. */
export function agentContextValue(input: ContextInput): Json {
  const steps = [
    { cards: 40, caption: 80, edl: 60, words: 12 },
    { cards: 30, caption: 48, edl: 40, words: 8 },
    { cards: 20, caption: 32, edl: 30, words: 6 },
    { cards: 12, caption: 24, edl: 20, words: 4 },
  ];
  let value: Json = null;
  for (const caps of steps) {
    value = buildContext(input, caps);
    if (JSON.stringify(value).length <= CONTEXT_BUDGET) return value;
  }
  return value;
}

// ── keyboard ─────────────────────────────────────────────────────────────────

/** True when a key event target is a text field (the `c` toggle must never eat a typed letter). */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown; closest?: unknown };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (typeof el.closest === "function") {
    try {
      return Boolean((el.closest as (s: string) => unknown).call(target, '[contenteditable=""],[contenteditable="true"]'));
    } catch {
      return false;
    }
  }
  return false;
}

// ── LIVE strip ───────────────────────────────────────────────────────────────

/** Longest caption the LIVE strip shows in one row (about 3–4 lines in the 440 px panel). */
export const LIVE_ROW_MAX = 180;

/**
 * What one LIVE caption row shows. A growing transcript row keeps its NEWEST words — the tail,
 * never the head — starting at a whole word when one is close. Display only: the stored
 * transcript stays whole, and the caller puts the full text in the row's title when clipped.
 */
export function liveRowText(text: string, max: number = LIVE_ROW_MAX): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  const start = text.length - max;
  let tail = text.slice(start);
  if (!/\s/.test(text.charAt(start - 1))) {
    const cut = tail.search(/\s/);
    if (cut > 0 && cut < 24) tail = tail.slice(cut + 1);
  }
  return { text: `…${tail.trimStart()}`, clipped: true };
}

/** True when a scroll box sits at (or within `slack` px of) its bottom — the strip autoscrolls only then. */
export function isNearBottom(
  box: { scrollHeight: number; scrollTop: number; clientHeight: number },
  slack = 8,
): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}
