import { z } from "zod";
import { moveSection } from "@/lib/server/film-ops";
import { mutateFilm } from "@/lib/server/film-store";
import { guarded } from "@/lib/server/guard";
import { requireRev, type SectionContext } from "../../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const moveBody = z.object({ index: z.number().int().min(0) }).strict();

/** POST /api/films/:id/sections/:sid/move { index } (If-Match) → Film */
export const POST = guarded<SectionContext>("write", async (g, { params }) => {
  const { id, sid } = await params;
  const rev = requireRev(g);
  const body = await g.json(moveBody);
  const film = await mutateFilm(id, rev, (current) => moveSection(current, sid, body.index));
  return g.reply(film);
});
