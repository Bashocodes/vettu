import { timelineBody } from "@/lib/contracts/timeline";
import { guarded, HttpError } from "@/lib/server/guard";
import { loadTimeline, reseedTimeline } from "@/lib/server/timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cut/timeline?film=&section= → Timeline (seeds when missing). */
export const GET = guarded("read", async (g) => {
  const film = g.url.searchParams.get("film") ?? g.url.searchParams.get("filmId");
  const section = g.url.searchParams.get("section");
  if (!film || !section) throw new HttpError(400, "Say which film and section.");
  return g.reply(await loadTimeline(film, section));
});

/** POST /api/cut/timeline { filmId, section, reseed? } → Timeline. */
export const POST = guarded("write", async (g) => {
  const body = await g.json(timelineBody);
  return g.reply(body.reseed ? await reseedTimeline(body.filmId, body.section) : await loadTimeline(body.filmId, body.section));
});
