import { reviewPostedBody } from "@/lib/contracts/review";
import { guarded } from "@/lib/server/guard";
import { markPosted } from "@/lib/server/review-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Channel → web: POST /api/review/posted { cutId } → { ok: true } (idempotent). */
export const POST = guarded("service", async (g) => {
  const body = await g.json(reviewPostedBody);
  return g.reply(await markPosted(body.cutId));
});
