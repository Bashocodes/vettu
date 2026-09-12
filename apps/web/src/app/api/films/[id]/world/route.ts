import { requireFilm } from "@/lib/server/film-store";
import { guarded } from "@/lib/server/guard";
import { buildWorldView } from "@/lib/server/views/world-view";
import type { IdContext } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/films/:id/world → WorldView */
export const GET = guarded<IdContext>("read", async (g, { params }) => {
  const { id } = await params;
  return g.reply(buildWorldView(await requireFilm(id)));
});
