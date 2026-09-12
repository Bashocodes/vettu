import { z } from "zod";
import { renameFilm, setActive } from "@/lib/server/film-ops";
import { mutateFilm, requireFilm } from "@/lib/server/film-store";
import { HttpError, guarded } from "@/lib/server/guard";
import { requireRev, type IdContext } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/films/:id → Film */
export const GET = guarded<IdContext>("read", async (g, { params }) => {
  const { id } = await params;
  return g.reply(await requireFilm(id));
});

const patchBody = z
  .object({
    name: z.string().max(400).optional(),
    activeSection: z.string().max(100).nullable().optional(),
  })
  .strict();

/** PATCH /api/films/:id { name?, activeSection? } (If-Match required) → Film */
export const PATCH = guarded<IdContext>("write", async (g, { params }) => {
  const { id } = await params;
  const rev = requireRev(g);
  const body = await g.json(patchBody);
  if (body.name === undefined && body.activeSection === undefined) {
    throw new HttpError(400, "Nothing to change.");
  }
  const film = await mutateFilm(id, rev, (current) => {
    let next = current;
    if (body.name !== undefined) next = renameFilm(next, body.name);
    if (body.activeSection !== undefined) next = setActive(next, body.activeSection);
    return next;
  });
  return g.reply(film);
});
