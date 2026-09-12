/**
 * The sample film (samples/sample-film.json): placeholder words, no media. Seeded when the
 * store is empty so the board is never blank. Server only.
 */
import type { Film, Letter } from "@/lib/contracts/film";
import sampleJson from "../../../samples/sample-film.json";
import { createFilm, newFilmId } from "./film-store";
import { isWorldLetter } from "./views/letters";

/** The sample exactly as stored in the repo (a deep copy). */
export function sampleFilmTemplate(): Film {
  return structuredClone(sampleJson) as unknown as Film;
}

/** A fresh draft of the sample with a new id, ready for createFilm. */
export function sampleFilmDraft(id: string = newFilmId()): Omit<Film, "rev" | "createdAt" | "updatedAt"> {
  const { rev: _rev, createdAt: _c, updatedAt: _u, ...rest } = sampleFilmTemplate();
  return { ...rest, id, source: { kind: "sample" } };
}

export async function seedSampleFilm(): Promise<Film> {
  return createFilm(sampleFilmDraft());
}

/**
 * Badge letters a brand-new film starts with: the sample's letters minus the cast and PROPS
 * (a new film's WORLD is empty, so it has no cast yet).
 */
export function baseLetters(): Record<string, Letter> {
  return Object.fromEntries(
    Object.entries(sampleFilmTemplate().letters).filter(([code, l]) => !isWorldLetter(code, l)),
  );
}
