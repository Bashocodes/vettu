/**
 * A world page (cast · locations · prop) → WorldMember (BOARD_DATA §5, §6b loadWorld). Pure regex
 * reads: tabs `class="tab" data-tab="id">LABEL`, panes `<section class="pane" data-pane="id">`,
 * cards `<figure class="cc[ todo]">` → first `<img src>`, `<i class="w">label</i>` or `.xbox` words,
 * `data-ar`. A page without tabs = one tab { id: "all", label: "" }.
 */
import type { WorldCard, WorldMember, WorldTab } from "@/lib/contracts/film";
import { attr, decodeEntities } from "./html";

export type WorldFamilyKind = "cast" | "locations" | "props";

interface PaneCard {
  label: string;
  todo: boolean;
  ar: string | null;
  img: string | null;
}

function paneCards(body: string): PaneCard[] {
  const cards: PaneCard[] = [];
  for (const m of body.matchAll(/<figure\b([^>]*\bclass="cc(?:\s[^"]*)?"[^>]*)>([\s\S]*?)<\/figure>/gi)) {
    const tag = `<figure ${m[1]}>`;
    const inner = m[2];
    const classes = attr(tag, "class") ?? "";
    const img = /<img\b[^>]*\bsrc="([^"]*)"/i.exec(inner);
    const word = /<i class="w">([^<]*)<\/i>/i.exec(inner) ?? /<div class="xbox">([^<]*)<\/div>/i.exec(inner);
    cards.push({
      label: word ? decodeEntities(word[1]).trim() : "",
      todo: /\btodo\b/.test(classes),
      ar: attr(tag, "data-ar"),
      img: img ? decodeEntities(img[1]) : null,
    });
  }
  return cards;
}

export function parseWorldPage(
  html: string,
  member: { code: string; label: string; colour: string | null },
  family: WorldFamilyKind,
): WorldMember {
  const tabButtons: { id: string; label: string }[] = [];
  for (const m of html.matchAll(/<([a-z]+)\b([^>]*\bclass="tab(?:\s[^"]*)?"[^>]*)>([^<]*)/gi)) {
    const id = attr(` ${m[2]}`, "data-tab");
    if (id && !tabButtons.some((t) => t.id === id)) {
      tabButtons.push({ id, label: decodeEntities(m[3]).trim() });
    }
  }
  const panes = new Map<string, PaneCard[]>();
  const paneOrder: string[] = [];
  for (const m of html.matchAll(/<section\b([^>]*\bclass="pane(?:\s[^"]*)?"[^>]*)>([\s\S]*?)<\/section>/gi)) {
    const id = attr(` ${m[1]}`, "data-pane") ?? `pane${paneOrder.length + 1}`;
    if (!panes.has(id)) paneOrder.push(id);
    panes.set(id, [...(panes.get(id) ?? []), ...paneCards(m[2])]);
  }

  const lower = member.code.toLowerCase();
  const toCards = (tabId: string, list: PaneCard[]): WorldCard[] =>
    list.map((c, i) => ({
      id: `${lower}/${tabId === "all" ? "" : tabId}${i + 1}`,
      label: c.label,
      code: family === "locations" ? null : member.code,
      todo: c.todo,
      ar: c.ar,
      media: c.img ? { src: c.img } : null,
    }));

  let tabs: WorldTab[];
  if (tabButtons.length === 0) {
    tabs = [{ id: "all", label: "", cards: toCards("all", paneOrder.flatMap((id) => panes.get(id) ?? [])) }];
  } else {
    tabs = tabButtons.map((t) => ({ id: t.id, label: t.label, cards: toCards(t.id, panes.get(t.id) ?? []) }));
    for (const id of paneOrder) {
      if (!tabButtons.some((t) => t.id === id)) tabs.push({ id, label: "", cards: toCards(id, panes.get(id) ?? []) });
    }
  }
  return { code: member.code, label: member.label, colour: member.colour, tabs };
}
