/**
 * Film store → BoardView (BOARD_DATA §2 maths, computed over the film's OWN sections). Pure.
 * PLAN = Σ(full ? cutSecs : targetSecs) · M = Σ cutSecs · % = round(100·M/PLAN) · done/total ·
 * secsLeft = round(PLAN − M) · X = todo grid cards — all over non-parked sections only.
 */
import {
  f1,
  fmt,
  mediaUrl,
  sectionColour,
  type Card,
  type Film,
  type Section,
  type Sound,
  type Take,
} from "@/lib/contracts/film";
import {
  TAB_ORDER,
  type BoardCard,
  type BoardRunningCut,
  type BoardSection,
  type BoardSound,
  type BoardStats,
  type BoardTake,
  type BoardView,
  type TabName,
} from "@/lib/contracts/board-view";
import { deriveSections } from "../film-ops";

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

type Numbers = Pick<Section, "full" | "cutSecs" | "targetSecs">;

/** board:262 — a full section counts what is in the cut, otherwise its target. */
export function planTerm(s: Numbers): number {
  return s.full ? s.cutSecs : (s.targetSecs ?? 0);
}

/** `.sdur` (board:326): full → round(ms) · ms>0 → round(ms)/round(plan) · else 0/round(plan); + "s". */
export function durText(s: Numbers): string {
  const plan = Math.round(s.targetSecs ?? 0);
  if (s.full) return `${Math.round(s.cutSecs)}s`;
  if (s.cutSecs > 0) return `${Math.round(s.cutSecs)}/${plan}s`;
  return `0/${plan}s`;
}

/** Bar chip seconds (bar:36-37): full → round(ms) · ms>0 → round(ms)/round(plan) · else round(plan). */
export function chipSecs(s: Numbers): string {
  const plan = Math.round(s.targetSecs ?? 0);
  if (s.full) return String(Math.round(s.cutSecs));
  if (s.cutSecs > 0) return `${Math.round(s.cutSecs)}/${plan}`;
  return String(plan);
}

export function boardTake(t: Take): BoardTake {
  return {
    id: t.id,
    kind: t.kind,
    url: mediaUrl(t.media),
    poster: mediaUrl(t.poster),
    caption: t.caption,
    maker: t.maker ?? null,
    letters: t.letters ?? [],
    lead: t.lead === true,
    secs: t.secs ?? null,
  };
}

export function boardCard(c: Card): BoardCard {
  return {
    id: c.id,
    section: c.section,
    slot: c.slot ?? null,
    kind: c.kind,
    url: mediaUrl(c.media),
    poster: mediaUrl(c.poster),
    secs: c.secs ?? null,
    in: c.in ?? 0,
    out: c.out ?? null,
    letters: c.letters ?? [],
    caption: c.caption,
    maker: c.maker ?? null,
    status: c.status,
    takes: (c.takes ?? []).map(boardTake),
    reserve: c.reserve === true,
    inCut: c.inCut ?? null,
    cutIn: c.cutIn ?? null,
    cutOut: c.cutOut ?? null,
    deity: c.deity ?? null,
    upload: c.upload === true,
  };
}

function boardSound(s: Sound): BoardSound {
  return {
    id: s.id,
    kind: s.kind,
    code: s.code,
    name: s.name,
    url: mediaUrl(s.media),
    selected: s.selected === true,
  };
}

/** Non-empty tabs only, in TAB_ORDER. SUBS and ASSETS are never produced. */
export function sectionTabs(parts: {
  reserve: readonly Pick<Card, "kind">[];
  music: number;
  narration: number;
  sfx: number;
  plans: number;
}): TabName[] {
  const has: Record<TabName, boolean> = {
    "R·CLIPS": parts.reserve.some((c) => c.kind === "clip"),
    "R·IMAGES": parts.reserve.some((c) => c.kind !== "clip"),
    SUBS: false,
    MUSIC: parts.music > 0,
    NARRATION: parts.narration > 0,
    SFX: parts.sfx > 0,
    ASSETS: false,
    PLANS: parts.plans > 0,
  };
  return TAB_ORDER.filter((t) => has[t]);
}

export function buildStats(film: Film, sections: readonly Section[]): BoardStats {
  const live = sections.filter((s) => !s.parked);
  const liveIds = new Set(live.map((s) => s.id));
  const plan = round3(sum(live.map(planTerm)));
  const master = round3(sum(live.map((s) => s.cutSecs)));
  const pct = plan > 0 ? Math.round((100 * master) / plan) : 0;
  const done = sum(live.map((s) => s.done));
  const total = sum(live.map((s) => s.total));
  const secsLeft = Math.round(plan - master);
  const toCreate = (film.cards ?? []).filter(
    (c) => c.status === "todo" && !c.reserve && liveIds.has(c.section),
  ).length;
  const target = typeof film.targetSecs === "number" ? film.targetSecs : null;
  return {
    plan: { secs: plan, text: `PLAN ${fmt(plan)}` },
    target: target === null ? null : { secs: target, text: `→ ${fmt(target)}` },
    master: { secs: master, text: `M ${fmt(master)}` },
    pct: { value: pct, text: `${pct}%` },
    clips: { done, total, text: `${done}/${total}` },
    secsLeft: { value: secsLeft, text: `${secsLeft} s` },
    toCreate: { value: toCreate, text: `X ${toCreate}` },
  };
}

export function buildBoardView(film: Film, options: { importAvailable: boolean }): BoardView {
  const { sections } = deriveSections(film);
  const cards = film.cards ?? [];
  const sounds = film.sounds ?? [];
  const plans = film.plans ?? [];
  const notes = film.notes ?? [];

  let head = 0;
  let exact = true;
  const rows: BoardSection[] = sections.map((s) => {
    const out = s.parked === true;
    let headSecs: number | null = null;
    let endSecs: number | null = null;
    let range = { text: "—", exact: false };
    if (!out) {
      const end = round3(head + planTerm(s));
      exact = exact && s.full;
      range = { text: `${exact ? "" : "≈"}${f1(head)}–${f1(end)}`, exact };
      headSecs = head;
      endSecs = end;
      head = end;
    }
    const grid = cards
      .filter((c) => c.section === s.id && !c.reserve && c.slot != null)
      .sort((a, b) => (a.slot as number) - (b.slot as number));
    const reserve = cards.filter((c) => c.section === s.id && c.reserve);
    const mine = sounds.filter((x) => x.section === s.id);
    const music = mine.filter((x) => x.kind === "music").map(boardSound);
    const narration = mine.filter((x) => x.kind === "narration").map(boardSound);
    const sfx = mine.filter((x) => x.kind === "sfx").map(boardSound);
    const planRows = plans.filter((p) => p.section === s.id).map((p) => ({ id: p.id, title: p.title }));
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      order: s.order,
      targetSecs: s.targetSecs ?? null,
      cutSecs: s.cutSecs,
      full: s.full === true,
      locked: s.locked === true,
      done: s.done,
      total: s.total,
      out,
      headSecs,
      endSecs,
      range,
      durText: durText(s),
      chipSecs: chipSecs(s),
      glyphs: { cut: s.cutSecs > 0, master: s.full === true, lock: s.locked === true },
      colour: sectionColour({ parked: out, full: s.full === true, done: s.done, total: s.total }),
      tabs: sectionTabs({
        reserve,
        music: music.length,
        narration: narration.length,
        sfx: sfx.length,
        plans: planRows.length,
      }),
      cards: grid.map(boardCard),
      reserve: reserve.map(boardCard),
      music,
      narration,
      sfx,
      plans: planRows,
      notes: notes.filter((n) => n.section === s.id).map((n) => n.text),
    };
  });

  const rc = film.runningCut;
  const runningCut: BoardRunningCut | null = rc
    ? {
        url: mediaUrl(rc.media) ?? "",
        poster: mediaUrl(rc.poster ?? null),
        from: rc.from,
        to: rc.to,
        lengthText: fmt(Math.max(0, rc.to - rc.from)),
        musicBed: mediaUrl(rc.musicBed ?? null),
      }
    : null;

  return {
    rev: film.rev,
    filmId: film.id,
    brand: "VETTU",
    film: film.name,
    readOnly: false,
    active: film.activeSection ?? null,
    source: film.source,
    importAvailable: options.importAvailable,
    stats: buildStats(film, sections),
    sections: rows,
    runningCut,
    // EVERY film letter: the legend builds THINGS · THE CAST · MAKERS · RESERVED from these.
    letters: { ...(film.letters ?? {}) },
  };
}
