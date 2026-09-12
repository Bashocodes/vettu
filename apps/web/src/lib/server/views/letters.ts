/**
 * Letter scopes. The board view carries EVERY film letter (its legend builds THINGS · THE CAST ·
 * MAKERS · RESERVED from them, so the cast and PROPS belong there too). WORLD carries only the cast
 * ("who") + PROPS — the member colours it paints.
 */
import type { Letter } from "@/lib/contracts/film";

export function isWorldLetter(code: string, letter: Letter): boolean {
  return letter?.kind === "who" || code === "PROPS";
}

export function worldLetters(letters: Record<string, Letter> | undefined): Record<string, Letter> {
  return Object.fromEntries(Object.entries(letters ?? {}).filter(([code, l]) => isWorldLetter(code, l)));
}
