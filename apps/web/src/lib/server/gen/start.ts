/**
 * STUB from the integrator — W6 replaces this, keeping the signature.
 * POST /api/jobs (W4's route) calls this for draw / animate / sound. It must create the job
 * file, start the work WITHOUT awaiting slow providers, and return the queued job at once.
 */
import type { Job, JobCreateBody } from "@/lib/contracts/jobs";
import { HttpError } from "../guard";

export async function startGeneratorJob(_body: JobCreateBody): Promise<Job> {
  throw new HttpError(501, "Generators are not built yet.");
}
