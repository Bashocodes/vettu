import { trimBody } from "@/lib/contracts/timeline";
import { guarded } from "@/lib/server/guard";
import { applyCut, applyTrim } from "@/lib/server/timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = guarded("write", async (g) => {
  const b = await g.json(trimBody);
  return g.reply(await applyCut(b.filmId, b.section, (t) => applyTrim(t, b)));
});
