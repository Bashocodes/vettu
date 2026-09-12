/**
 * Jobs — truth on disk at VETTU_DATA_DIR/jobs/<id>.json, never module memory.
 * GET /api/jobs?filmId=&section= → { jobs } · GET /api/jobs?id= → { job } · POST /api/jobs → { job }.
 * Browser-safe.
 */
import { z } from "zod";
import type { MediaSrc } from "./film";

export type JobKind = "preview" | "final" | "draw" | "animate" | "sound" | "assembly";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string; // "job_…"
  filmId: string;
  section: string;
  kind: JobKind;
  status: JobStatus;
  title: string; // "draw · the bridge at dusk"
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: string | null; // "Kling: processing (2/5 polls)"
  insertId: string | null;
  result: { media?: MediaSrc | null; url?: string | null; note?: string | null } | null;
  error: string | null; // controlled message: last ffmpeg stderr line or the API error
}

const target = {
  filmId: z.string().min(1).max(100),
  section: z.string().min(1).max(40),
};

export const jobCreateBody = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("draw"),
      ...target,
      prompt: z.string().trim().min(3).max(1000),
      refShots: z.array(z.string().max(100)).max(16).default([]),
      afterShot: z.string().max(100).optional(),
      secs: z.number().min(1).max(10).default(3),
    })
    .strict(),
  z
    .object({
      kind: z.literal("animate"),
      ...target,
      insertId: z.string().min(1).max(100),
      prompt: z.string().trim().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sound"),
      ...target,
      target: z.string().min(1).max(100), // shot ref the sound lands on
      prompt: z.string().trim().min(3).max(450),
      duration: z.number().min(0.5).max(30),
    })
    .strict(),
]);
export type JobCreateBody = z.infer<typeof jobCreateBody>;

export const jobCancelBody = z.object({ operation: z.literal("cancel"), jobId: z.string().min(1).max(100) }).strict();

export const directorBody = z
  .object({
    ...target,
    brief: z.string().trim().min(3).max(2000),
  })
  .strict();
export type DirectorBody = z.infer<typeof directorBody>;
