import { z } from "zod";
import { removeSection, renameSection, setParked, setTargetSecs } from "@/lib/server/film-ops";
import { mutateFilm } from "@/lib/server/film-store";
import { HttpError, guarded } from "@/lib/server/guard";
import { requireRev, type SectionContext } from "../../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchBody = z
  .object({
    name: z.string().max(400).optional(),
    targetSecs: z.number().nullable().optional(),
    parked: z.boolean().optional(),
  })
  .strict();

/** PATCH /api/films/:id/sections/:sid { name?, targetSecs?, parked? } (If-Match) → Film */
export const PATCH = guarded<SectionContext>("write", async (g, { params }) => {
  const { id, sid } = await params;
  const rev = requireRev(g);
  const body = await g.json(patchBody);
  if (body.name === undefined && body.targetSecs === undefined && body.parked === undefined) {
    throw new HttpError(400, "Nothing to change.");
  }
  const film = await mutateFilm(id, rev, (current) => {
    let next = current;
    if (body.name !== undefined) next = renameSection(next, sid, body.name);
    if (body.targetSecs !== undefined) next = setTargetSecs(next, sid, body.targetSecs);
    if (body.parked !== undefined) next = setParked(next, sid, body.parked);
    return next;
  });
  return g.reply(film);
});

const deleteBody = z.object({ withCards: z.boolean().optional() }).strict();

/** DELETE /api/films/:id/sections/:sid { withCards? } (If-Match) → Film · 409 section_has_cards */
export const DELETE = guarded<SectionContext>("write", async (g, { params }) => {
  const { id, sid } = await params;
  const rev = requireRev(g);
  const body = await g.json(deleteBody);
  const film = await mutateFilm(id, rev, (current) => removeSection(current, sid, body.withCards === true));
  return g.reply(film);
});
