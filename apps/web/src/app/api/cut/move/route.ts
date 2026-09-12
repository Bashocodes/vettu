import { moveBody } from "@/lib/contracts/timeline";
import { guarded } from "@/lib/server/guard";
import { applyCut, applyMove } from "@/lib/server/timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = guarded("write", async (g) => {
  const b = await g.json(moveBody);
  return g.reply(await applyCut(b.filmId, b.section, (t) => applyMove(t, b)));
});
