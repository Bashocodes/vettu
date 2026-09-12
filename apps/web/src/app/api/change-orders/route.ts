import { changeOrderBody } from "@/lib/contracts/review";
import { fileChangeOrder, listChangeOrders } from "@/lib/server/change-orders";
import { guarded } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Channel → web: POST /api/change-orders → { changeOrder, duplicate } (idempotent on idempotencyKey). */
export const POST = guarded("service", async (g) => {
  const body = await g.json(changeOrderBody);
  return g.reply(await fileChangeOrder(body));
});

/** GET /api/change-orders?filmId= → { changeOrders } newest first. */
export const GET = guarded("read", async (g) => {
  return g.reply({ changeOrders: await listChangeOrders(g.url.searchParams.get("filmId") ?? undefined) });
});
