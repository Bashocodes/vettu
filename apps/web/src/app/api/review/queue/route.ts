import { guarded } from "@/lib/server/guard";
import { listReviewQueue } from "@/lib/server/review-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Channel → web: GET /api/review/queue → ReviewQueueItem[] (not yet posted, oldest first). */
export const GET = guarded("service", async (g) => g.reply(await listReviewQueue()));
