import { guarded } from "@/lib/server/guard";
import { serveMedia } from "@/lib/server/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET|HEAD /api/media?src=… | ?root=…&p=… → the file, Range-aware (see lib/server/media.ts). */
const handler = guarded("read", async (g) => g.withSession(await serveMedia(g.request, g.url)));

export const GET = handler;
export const HEAD = handler;
