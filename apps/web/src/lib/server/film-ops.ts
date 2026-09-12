/**
 * Pure film operations: (film, args) → film. Server only (they throw HttpError).
 * Every op ends with recomputeCodes + deriveSections, so `code` is always "§" + two-digit
 * order and user sections (derived: true) always reflect their cards. Section ids never change;
 * every section ref goes through findSection (id · code · name).
 */
import { randomBytes } from "node:crypto";
import {
  findSection,
  sectionCode,
  type Card,
  type Film,
  type Letter,
  type Section,
} from "@/lib/contracts/film";
import { HttpError } from "./guard";

export const SECTION_NAME_MAX = 60;
export const FILM_NAME_MAX = 80;
export const MAX_TARGET_SECS = 6 * 60 * 60;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** trim · collapse spaces · UPPERCASE · 1–max characters. */
export function normaliseName(raw: unknown, max: number): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").toUpperCase() : "";
  if (name.length < 1 || name.length > max) {
    throw new HttpError(400, `A name needs 1–${max} characters.`);
  }
  return name;
}
export const sectionName = (raw: unknown) => normaliseName(raw, SECTION_NAME_MAX);
export const filmName = (raw: unknown) => normaliseName(raw, FILM_NAME_MAX);

export function newSectionId(): string {
  return `s_${randomBytes(4).toString("hex")}`;
}

function targetOrNull(raw: number | null | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > MAX_TARGET_SECS) {
    throw new HttpError(400, `Target seconds must be between 0 and ${MAX_TARGET_SECS}.`);
  }
  return round3(raw);
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined) return length;
  if (!Number.isInteger(index) || index < 0) throw new HttpError(400, "Index must be a whole number ≥ 0.");
  return Math.min(index, length);
}

function sectionOrThrow(film: Film, ref: string): Section {
  const found = typeof ref === "string" && ref.trim() ? findSection(film.sections, ref) : undefined;
  if (!found) throw new HttpError(404, "No such section.");
  return found;
}

/** order = position + 1, code = "§" + two-digit order. */
export function recomputeCodes(film: Film): Film {
  return {
    ...film,
    sections: film.sections.map((s, i) => ({ ...s, order: i + 1, code: sectionCode(i + 1) })),
  };
}

/**
 * A user section (derived: true) from its cards: total = slotted non-reserve cards; done = those
 * that are not words and not todo; cutSecs = Σ done (out ?? secs ?? 0) − in; full = total > 0 && done === total.
 * Imported sections (derived: false) keep their numbers.
 */
export function deriveSection(section: Section, cards: readonly Card[]): Section {
  if (!section.derived) return section;
  const slotted = cards.filter((c) => c.section === section.id && !c.reserve && c.slot != null);
  const done = slotted.filter((c) => c.kind !== "words" && c.status !== "todo");
  const cutSecs = round3(
    done.reduce((sum, c) => sum + Math.max(0, (c.out ?? c.secs ?? 0) - (c.in ?? 0)), 0),
  );
  return {
    ...section,
    cutSecs,
    done: done.length,
    total: slotted.length,
    full: slotted.length > 0 && done.length === slotted.length,
  };
}

export function deriveSections(film: Film): Film {
  return { ...film, sections: film.sections.map((s) => deriveSection(s, film.cards ?? [])) };
}

const finish = (film: Film) => deriveSections(recomputeCodes(film));

export function renameFilm(film: Film, name: string): Film {
  return { ...film, name: filmName(name) };
}

export function setActive(film: Film, ref: string | null): Film {
  if (ref === null) return { ...film, activeSection: null };
  return { ...film, activeSection: sectionOrThrow(film, ref).id };
}

export interface AddSectionArgs {
  name: string;
  targetSecs?: number | null;
  index?: number;
}

export function addSection(film: Film, args: AddSectionArgs, makeId: () => string = newSectionId): Film {
  const name = sectionName(args.name);
  const targetSecs = targetOrNull(args.targetSecs);
  let id = makeId();
  for (let tries = 0; film.sections.some((s) => s.id === id); tries++) {
    if (tries > 8) throw new HttpError(500, "VETTU could not name the section.");
    id = makeId();
  }
  const section: Section = {
    id,
    code: "",
    name,
    order: 0,
    targetSecs,
    cutSecs: 0,
    full: false,
    locked: false,
    done: 0,
    total: 0,
    parked: false,
    derived: true,
  };
  const sections = [...film.sections];
  sections.splice(clampIndex(args.index, sections.length), 0, section);
  return finish({ ...film, sections, activeSection: film.activeSection ?? id });
}

export function renameSection(film: Film, ref: string, name: string): Film {
  const target = sectionOrThrow(film, ref);
  const next = sectionName(name);
  return finish({
    ...film,
    sections: film.sections.map((s) => (s.id === target.id ? { ...s, name: next } : s)),
  });
}

export function moveSection(film: Film, ref: string, index: number): Film {
  const target = sectionOrThrow(film, ref);
  const rest = film.sections.filter((s) => s.id !== target.id);
  rest.splice(clampIndex(index, rest.length), 0, target);
  return finish({ ...film, sections: rest });
}

export function setParked(film: Film, ref: string, parked: boolean): Film {
  const target = sectionOrThrow(film, ref);
  return finish({
    ...film,
    sections: film.sections.map((s) => (s.id === target.id ? { ...s, parked: parked === true } : s)),
  });
}

export function setTargetSecs(film: Film, ref: string, secs: number | null): Film {
  const target = sectionOrThrow(film, ref);
  const value = targetOrNull(secs);
  return finish({
    ...film,
    sections: film.sections.map((s) => (s.id === target.id ? { ...s, targetSecs: value } : s)),
  });
}

/** Refused (409 section_has_cards) while the section holds cards, unless withCards. */
export function removeSection(film: Film, ref: string, withCards = false): Film {
  const target = sectionOrThrow(film, ref);
  const holds = (film.cards ?? []).some((c) => c.section === target.id);
  if (holds && !withCards) {
    throw new HttpError(409, "That section holds cards.", { error: "section_has_cards" });
  }
  const sections = film.sections.filter((s) => s.id !== target.id);
  return finish({
    ...film,
    sections,
    activeSection: film.activeSection === target.id ? (sections[0]?.id ?? null) : film.activeSection,
    cards: (film.cards ?? []).filter((c) => c.section !== target.id),
    sounds: (film.sounds ?? []).filter((s) => s.section !== target.id),
    plans: (film.plans ?? []).filter((p) => p.section !== target.id),
    notes: (film.notes ?? []).filter((n) => n.section !== target.id),
  });
}

/** A brand-new empty film (POST /api/films). */
export function emptyFilm(
  id: string,
  name: string,
  letters: Record<string, Letter>,
): Omit<Film, "rev" | "createdAt" | "updatedAt"> {
  return {
    id,
    name: filmName(name),
    source: { kind: "new" },
    activeSection: null,
    targetSecs: null,
    letters,
    sections: [],
    cards: [],
    sounds: [],
    plans: [],
    notes: [],
    world: { cast: [], locations: [], props: [] },
    runningCut: null,
  };
}
