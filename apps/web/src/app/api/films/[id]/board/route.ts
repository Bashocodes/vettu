import { requireFilm } from "@/lib/server/film-store";
import { guarded } from "@/lib/server/guard";
import { filmEnvConfigured } from "@/lib/server/roots";
import { buildBoardView } from "@/lib/server/views/board-view";
import type { IdContext } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/films/:id/board → BoardView */
export const GET = guarded<IdContext>("read", async (g, { params }) => {
  const { id } = await params;
  const film = await requireFilm(id);
  return g.reply(buildBoardView(film, { importAvailable: filmEnvConfigured() }));
});
