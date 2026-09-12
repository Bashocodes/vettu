import assert from "node:assert/strict";
import test from "node:test";
import type { Film } from "@/lib/contracts/film";
import storedSample from "../../../../samples/sample-film.json";
import worldFixture from "../../contracts/fixtures/world-view.json";
import { buildWorldView, worldMember } from "./world-view";

test("sample film (samples/sample-film.json) → WORLD view deep-equals the world fixture", () => {
  const film = { ...(storedSample as unknown as Film), rev: 3 };
  assert.deepEqual(buildWorldView(film), worldFixture);
});

test("members: filled = not todo, totals roll up, images through /api/media", () => {
  const member = worldMember({
    code: "THING",
    label: "thing",
    colour: "#b87333",
    tabs: [
      {
        id: "all",
        label: "",
        cards: [
          { id: "thing/1", label: "front", code: "THING", todo: false, ar: "1:1", media: { src: "img/a b.png" } },
          { id: "thing/2", label: "back", code: "THING", todo: true, ar: null, media: null },
        ],
      },
      { id: "empty", label: "THE EMPTY", cards: [] },
    ],
  });
  assert.equal(member.filled, 1);
  assert.equal(member.total, 2);
  assert.equal(member.tabs[0].cards[0].img, "/api/media?src=img%2Fa%20b.png");
  assert.deepEqual([member.tabs[1].filled, member.tabs[1].total], [0, 0]);
});
