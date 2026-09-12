/** Film store → WorldView (BOARD_DATA §5 / §6d shape). Pure. filled = cards that are not todo. */
import { mediaUrl, type Film, type WorldMember } from "@/lib/contracts/film";
import {
  WORLD_FAMILIES,
  type WorldView,
  type WorldViewMember,
  type WorldViewTab,
} from "@/lib/contracts/world-view";
import { worldLetters } from "./letters";

export function worldMember(m: WorldMember): WorldViewMember {
  const tabs: WorldViewTab[] = (m.tabs ?? []).map((t) => {
    const cards = (t.cards ?? []).map((c) => ({
      id: c.id,
      label: c.label,
      code: c.code ?? null,
      todo: c.todo === true,
      ar: c.ar ?? null,
      img: mediaUrl(c.media),
    }));
    return {
      id: t.id,
      label: t.label,
      filled: cards.filter((c) => !c.todo).length,
      total: cards.length,
      cards,
    };
  });
  return {
    code: m.code,
    label: m.label,
    colour: m.colour ?? null,
    filled: tabs.reduce((n, t) => n + t.filled, 0),
    total: tabs.reduce((n, t) => n + t.total, 0),
    tabs,
  };
}

export function buildWorldView(film: Film): WorldView {
  const world = film.world ?? { cast: [], locations: [], props: [] };
  return {
    rev: film.rev,
    filmId: film.id,
    film: film.name,
    family: [...WORLD_FAMILIES],
    cast: (world.cast ?? []).map(worldMember),
    locations: (world.locations ?? []).map(worldMember),
    props: (world.props ?? []).map(worldMember),
    letters: worldLetters(film.letters),
  };
}
