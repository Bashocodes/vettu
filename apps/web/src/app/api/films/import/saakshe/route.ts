import { z } from "zod";
import { guarded } from "@/lib/server/guard";
import { importSaakshe } from "@/lib/server/import-saakshe/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const importBody = z.object({}).strict();

/**
 * POST /api/films/import/saakshe → Film (201 new · 200 re-import, same id).
 * 404 { error: "film_env_unset" } without the film env · 503 { error: "film_state_unreadable" }.
 * Read-only on the film folders.
 */
export const POST = guarded("write", async (g) => {
  await g.json(importBody);
  const { film, created } = await importSaakshe();
  return g.reply(film, created ? 201 : 200);
});
