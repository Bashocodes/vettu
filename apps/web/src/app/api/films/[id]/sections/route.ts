import { z } from "zod";
import { addSection } from "@/lib/server/film-ops";
import { mutateFilm } from "@/lib/server/film-store";
import { guarded } from "@/lib/server/guard";
import { requireRev, type IdContext } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const addBody = z
  .object({
    name: z.string().max(400),
    targetSecs: z.number().nullable().optional(),
    index: z.number().int().min(0).optional(),
  })
  .strict();

/** POST /api/films/:id/sections { name, targetSecs?, index? } (If-Match) → Film 201 */
export const POST = guarded<IdContext>("write", async (g, { params }) => {
  const { id } = await params;
  const rev = requireRev(g);
  const body = await g.json(addBody);
  const film = await mutateFilm(id, rev, (current) =>
    addSection(current, { name: body.name, targetSecs: body.targetSecs, index: body.index }),
  );
  return g.reply(film, 201);
});
