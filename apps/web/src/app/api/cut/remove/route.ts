import { removeBody } from "@/lib/contracts/timeline";
import { guarded } from "@/lib/server/guard";
import { applyCut, applyRemove } from "@/lib/server/timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = guarded("write", async (g) => {
  const b = await g.json(removeBody);
  return g.reply(await applyCut(b.filmId, b.section, (t) => applyRemove(t, b)));
});
