import { previewBody } from "@/lib/contracts/timeline";
import { guarded } from "@/lib/server/guard";
import { renderPreviewFor } from "@/lib/server/timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = guarded("write", async (g) => {
  const b = await g.json(previewBody);
  return g.reply(await renderPreviewFor(b.filmId, b.section));
});
