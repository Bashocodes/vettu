/**
 * The Director on Claude: one generateText tool loop (ai + @ai-sdk/anthropic). Tools
 * animate_insert / add_sound (Zod schemas from VETTU_TOOLS) QUEUE background jobs and return
 * { jobId, status } at once; list_shots is read-only. No draw, no sub-agents, no sampling params.
 * The key never leaves the server. Server only.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { z } from "zod";
import { jobCreateBody, type Job, type JobCreateBody, type JobStatus } from "@/lib/contracts/jobs";
import type { Timeline } from "@/lib/contracts/timeline";
import { VETTU_TOOLS } from "@/lib/contracts/tools";
import { HttpError } from "../guard";
import { GenError } from "../gen/ffmpeg";
import { PlacementError } from "../gen/placement";
import { MAX_DIRECTOR_JOBS } from "./fallback";

export const DEFAULT_DIRECTOR_MODEL = "claude-opus-5";
export const DIRECTOR_MAX_STEPS = 8;
/** Spend guards per Director run: Kling clips are slow and paid; sound effects bill per second. */
export const MAX_DIRECTOR_ANIMATES = 1;
export const MAX_DIRECTOR_SOUND_SECS = 10;
export const DIRECTOR_TOOL_NAMES = ["list_shots", "animate_insert", "add_sound"] as const;

export const DIRECTOR_SYSTEM = [
  "You are the Director of VETTU, an agentic film board. The user gives a brief for the open section of a film.",
  `Plan at most ${MAX_DIRECTOR_JOBS} background jobs for the brief on the open section, and queue them with your tools.`,
  "Use only the shots listed (entry ids like e3 or shot ids like S3). Call list_shots if you need them again.",
  "animate_insert: fromShot = the shot whose frame becomes the new shot; afterShot = where it lands (default: right after fromShot); secs 3 to 6. Write the prompt in beat order: the action plays out first and the camera makes no travel move until that action has finished. Never words on screen.",
  'add_sound: target = a shot ref; describe the mic position and the detail ("close · clear · crisp"), never the size of the space; duration 1 to 5 seconds.',
  "Tools only queue slow jobs and return job ids. Never wait for results and never claim a clip is finished. Only the user's Approve click renders the final cut.",
  "Finish with one short sentence of what you queued.",
].join("\n");

/** MODEL env → an Anthropic model id: strip an `anthropic:` / `anthropic/` prefix; a non-Claude id → the default. */
export function directorModelId(raw = process.env.MODEL): string {
  const id = (raw ?? "").trim().replace(/^anthropic[:/]/i, "").trim();
  return /^claude-/i.test(id) ? id : DEFAULT_DIRECTOR_MODEL;
}

export interface ShotLine {
  entry: string;
  ref: string;
  in: number;
  out: number;
  description: string;
}

export function shotLines(t: Pick<Timeline, "edl" | "shots" | "inserts">): ShotLine[] {
  return t.edl.slice(0, 20).map((e) => {
    const shot = t.shots.find((s) => s.id === e.ref);
    const insert = t.inserts.find((x) => x.id === e.ref);
    const what = (shot?.description || (insert ? `insert: ${insert.prompt}` : "")).replace(/\s+/g, " ").trim();
    return { entry: e.id, ref: e.ref, in: e.in, out: e.out, description: what.slice(0, 120) };
  });
}

export function directorPrompt(brief: string, t: Pick<Timeline, "edl" | "shots" | "inserts">): string {
  const lines = shotLines(t).map((s) => `${s.entry} · ${s.ref} · ${s.in.toFixed(2)}–${s.out.toFixed(2)} s · ${s.description}`);
  return `Brief: ${brief.trim()}\n\nThe open section's edit (entry · ref · in–out · description):\n${lines.length ? lines.join("\n") : "(the edit is empty)"}`;
}

export type StartJob = (body: JobCreateBody) => Promise<Job>;

export interface QueuedJob {
  tool: "animate_insert" | "add_sound";
  jobId: string;
  status: JobStatus;
}

export type DirectorToolOutput = { jobId: string; status: JobStatus; insertId: string | null; error: string | null } | { error: string };

function controlledMessage(error: unknown): string {
  if (error instanceof HttpError || error instanceof GenError || error instanceof PlacementError) return error.message;
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    return `Invalid arguments${first ? `: ${first.path.join(".") || "body"} ${first.message}` : "."}`;
  }
  return "The job could not start.";
}

const animateInput = VETTU_TOOLS.animate_insert.parameters.omit({ section: true });
const soundInput = VETTU_TOOLS.add_sound.parameters.omit({ section: true });

/**
 * The Director's tools. `target` pins the film + section (the model never picks them).
 * execute never throws and never waits for Kling/ElevenLabs: startJob returns after the fast step.
 */
export function directorTools(opts: {
  target: { filmId: string; section: string };
  timeline: () => Pick<Timeline, "edl" | "shots" | "inserts">;
  startJob: StartJob;
  onQueued?: (q: QueuedJob) => void | Promise<void>;
  maxJobs?: number;
}): ToolSet {
  const max = opts.maxJobs ?? MAX_DIRECTOR_JOBS;
  let started = 0;
  let animates = 0;

  const queue = async (name: QueuedJob["tool"], request: unknown): Promise<DirectorToolOutput> => {
    if (started >= max) return { error: `Plan at most ${max} jobs; this one was not queued.` };
    if (name === "animate_insert" && animates >= MAX_DIRECTOR_ANIMATES)
      return { error: `One Kling clip per Director run; this animate_insert was not queued.` };
    try {
      const body = jobCreateBody.parse(request);
      started += 1;
      if (name === "animate_insert") animates += 1;
      const job = await opts.startJob(body);
      try {
        await opts.onQueued?.({ tool: name, jobId: job.id, status: job.status });
      } catch {
        // progress is best effort
      }
      return { jobId: job.id, status: job.status, insertId: job.insertId, error: job.error };
    } catch (error) {
      return { error: controlledMessage(error) };
    }
  };

  return {
    list_shots: tool({
      description: "List the open section's edit: entry id · shot ref · in–out seconds · description. Read-only.",
      inputSchema: z.object({}),
      execute: async () => ({ shots: shotLines(opts.timeline()) }),
    }),
    animate_insert: tool({
      description: VETTU_TOOLS.animate_insert.description,
      inputSchema: animateInput,
      execute: async (input) => queue("animate_insert", { kind: "animate", ...opts.target, ...input }),
    }),
    add_sound: tool({
      description: VETTU_TOOLS.add_sound.description,
      inputSchema: soundInput,
      execute: async (input) =>
        queue("add_sound", {
          kind: "sound",
          ...opts.target,
          ...input,
          duration: Math.min(input.duration, MAX_DIRECTOR_SOUND_SECS),
        }),
    }),
  };
}

export interface DirectorStep {
  toolNames: string[];
  text: string;
}

export class DirectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectorError";
  }
}

/** A controlled reason for a failed Claude run (never provider text, never the key). */
export function directorFailure(error: unknown): string {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number") return `Claude API error HTTP ${status}`;
  if (error instanceof DirectorError) return error.message;
  const name = error instanceof Error ? error.name : "";
  if (/Abort|Timeout/i.test(name)) return "Claude did not answer in time";
  return "Claude could not run";
}

export async function runClaudeDirector(run: {
  apiKey: string;
  model?: string;
  brief: string;
  timeline: Pick<Timeline, "edl" | "shots" | "inserts">;
  tools: ToolSet;
  onStep?: (step: DirectorStep) => void | Promise<void>;
  maxSteps?: number;
  toolChoice?: "auto" | "required" | { type: "tool"; toolName: string };
}): Promise<{ text: string; toolNames: string[]; steps: number }> {
  const anthropic = createAnthropic({ apiKey: run.apiKey });
  const toolNames: string[] = [];
  const texts: string[] = [];
  const result = await generateText({
    model: anthropic(run.model ?? directorModelId()),
    system: DIRECTOR_SYSTEM,
    prompt: directorPrompt(run.brief, run.timeline),
    tools: run.tools,
    ...(run.toolChoice ? { toolChoice: run.toolChoice } : {}),
    stopWhen: stepCountIs(run.maxSteps ?? DIRECTOR_MAX_STEPS),
    maxRetries: 1,
    timeout: 180_000,
    onStepFinish: async (step) => {
      for (const call of step.toolCalls) toolNames.push(call.toolName);
      if (step.text.trim()) texts.push(step.text.trim());
      try {
        await run.onStep?.({ toolNames: [...toolNames], text: texts.join(" ") });
      } catch {
        // progress is best effort
      }
    },
  });
  return { text: result.text.trim() || texts.join(" "), toolNames, steps: result.steps.length };
}
