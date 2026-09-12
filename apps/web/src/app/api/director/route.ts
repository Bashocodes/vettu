/**
 * POST /api/director { filmId, section, brief } → { jobId } at once.
 * The Director (Claude tool loop) queues ≤3 animate/sound jobs in the background; with no
 * Anthropic key or on an API error the server queue lays one sound instead.
 */
import { directorBody } from "@/lib/contracts/jobs";
import { guarded } from "@/lib/server/guard";
import { startDirector } from "@/lib/server/director/start";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = guarded("write", async (g) => {
  const body = await g.json(directorBody);
  const { jobId } = await startDirector(body);
  return g.reply({ jobId }, 202);
});
