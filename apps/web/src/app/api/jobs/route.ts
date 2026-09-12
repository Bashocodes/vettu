import { z } from "zod";
import { jobCancelBody, jobCreateBody } from "@/lib/contracts/jobs";
import { startGeneratorJob } from "@/lib/server/gen/start";
import { guarded, HttpError } from "@/lib/server/guard";
import { cancelJob, getJob, listJobs } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/jobs?filmId=&section= → { jobs } · GET /api/jobs?id= → { job } */
export const GET = guarded("read", async (g) => {
  const id = g.url.searchParams.get("id");
  if (id) {
    const job = await getJob(id);
    if (!job) throw new HttpError(404, "No such job.");
    return g.reply({ job });
  }
  return g.reply({
    jobs: await listJobs({
      filmId: g.url.searchParams.get("filmId") ?? undefined,
      section: g.url.searchParams.get("section") ?? undefined,
    }),
  });
});

/** POST /api/jobs { operation: "cancel", jobId } → { job } · else a generator job → { job } */
export const POST = guarded("write", async (g) => {
  const raw = await g.json(z.record(z.string(), z.unknown()));
  if (raw.operation === "cancel") {
    const body = jobCancelBody.parse(raw);
    return g.reply({ job: await cancelJob(body.jobId) });
  }
  const body = jobCreateBody.parse(raw);
  return g.reply({ job: await startGeneratorJob(body) });
});
