/** GET /api/films/:id/world → WorldView (BOARD_DATA §6d shape, normalised). Browser-safe. */
import type { Letter } from "./film";

export type WorldFamily = "CAST" | "LOCATIONS" | "PROPS";
export const WORLD_FAMILIES: readonly WorldFamily[] = ["CAST", "LOCATIONS", "PROPS"];

export interface WorldViewCard {
  id: string;
  label: string;
  code: string | null;
  todo: boolean; // words on a dark plate, dashed plinth
  ar: string | null; // "9:16" · "7:3" · "21:9" · "1:1"
  img: string | null; // /api/media?… or null
}

export interface WorldViewTab {
  id: string;
  label: string; // "THE FACE" · "" for a page without tabs
  filled: number; // cards that are not todo
  total: number;
  cards: WorldViewCard[];
}

export interface WorldViewMember {
  code: string; // "HER" · "LOCATIONS" · "POD"
  label: string;
  colour: string | null; // shown only when the member is selected
  filled: number;
  total: number;
  tabs: WorldViewTab[];
}

export interface WorldView {
  rev: number;
  filmId: string;
  film: string;
  family: WorldFamily[];
  cast: WorldViewMember[];
  locations: WorldViewMember[];
  props: WorldViewMember[];
  letters: Record<string, Letter>;
}
