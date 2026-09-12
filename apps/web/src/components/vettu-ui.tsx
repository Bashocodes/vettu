"use client";

/**
 * VETTU agent-rendered UI — hook-only, renders null.
 * - useComponent  shot_card            → a streamed shot card (every prop may be missing or null)
 * - useRenderTool draw/animate/sound/assembly → a job card that polls /api/jobs until terminal
 * - useRenderTool refresh_change_orders → the reviewers' change orders
 * - useHumanInTheLoop propose_render   → the Approve & render gate
 *
 * respond() only returns text to the model and executes nothing: the Approve button POSTs the
 * approve route first, then responds with what the server really did.
 * Cards unmount when the popup is minimised, so their truth lives in module maps keyed by
 * toolCallId / job id (and on disk behind /api/jobs), never in component state alone.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useComponent, useHumanInTheLoop, useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { api } from "@/lib/api-client";
import type { Job, JobStatus } from "@/lib/contracts/jobs";
import type { VettuOverlayProps } from "@/lib/contracts/overlay";
import type { RenderProposal, VersionRecord } from "@/lib/contracts/review";
import { VETTU_TOOLS, type VettuToolArgs } from "@/lib/contracts/tools";
import { useVettuOverlay } from "@/components/overlay/overlay-context";
import { canCancel, cancelledLine } from "@/components/jobs/job-strip-logic";
import {
  NO_FILM,
  clip,
  errorMessage,
  parseJobId,
  parseToolResult,
  r1,
  resolveSectionRef,
  secsText,
  sectionLabel,
} from "@/lib/tool-run";
import { kindLabel, kindTone, readCardRows, taskLine, timeText } from "@/components/change-orders/change-order-logic";

type ToolStatus = "inProgress" | "executing" | "complete";

const isMediaUrl = (url: unknown): url is string => typeof url === "string" && url.startsWith("/api/media?");
const isWebUrl = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//i.test(url);

// ── shot_card ────────────────────────────────────────────────────────────────

const shotCardParameters = z.object({
  shotId: z.string().max(100).describe('Shot reference, e.g. "S3".'),
  in: z.number().min(0).optional().describe("Seconds into the clip where the shot starts."),
  out: z.number().min(0).optional().describe("Seconds into the clip where the shot ends."),
  description: z.string().max(400).describe("What the shot shows, in one short line."),
  thumb: z.string().max(600).optional().describe("A /api/media?… poster URL from the board, when known."),
  tags: z.array(z.string().max(40)).max(8).optional(),
});

/** Arguments stream in partially, before defaults apply: every prop may be missing or null. */
export interface ShotCardProps {
  shotId?: string | null;
  in?: number | null;
  out?: number | null;
  description?: string | null;
  thumb?: string | null;
  tags?: Array<string | null> | null;
}

export function ShotCard({ shotId, in: inSecs, out, description, thumb, tags }: ShotCardProps) {
  const hasRange = typeof inSecs === "number" && typeof out === "number" && out >= inSecs;
  const chips = (tags ?? []).filter((t): t is string => typeof t === "string" && t.length > 0);
  return (
    <article className="vx-card vx-shot" data-vx="shot">
      <div className="vx-shot-plate">
        {isMediaUrl(thumb) ? <img src={thumb} alt="" loading="lazy" /> : <span className="vx-dim">{shotId || "…"}</span>}
      </div>
      <div className="vx-shot-body">
        <div className="vx-row">
          <span className="vx-badge">{shotId || "…"}</span>
          {hasRange ? (
            <span className="vx-mono vx-dim">
              {r1(inSecs)}–{r1(out)} s · {secsText(out - inSecs)}
            </span>
          ) : null}
        </div>
        <p className="vx-text">{description || "Finding the shot…"}</p>
        {chips.length ? (
          <div className="vx-row vx-wrap">
            {chips.map((tag, i) => (
              <span key={`${tag}-${i}`} className="vx-chip">
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

// ── job cards ────────────────────────────────────────────────────────────────

const JOB_TITLES = {
  draw_insert: "DRAW INSERT",
  animate_insert: "ANIMATE INSERT",
  add_sound: "SOUND",
  first_assembly: "FIRST ASSEMBLY",
} as const;
type JobTool = keyof typeof JOB_TITLES;

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(["done", "failed", "cancelled"]);
const jobCache = new Map<string, Job>();
const refreshedJobs = new Set<string>();

function jobTone(status: JobStatus): "ok" | "bad" | "busy" {
  if (status === "done") return "ok";
  if (status === "failed" || status === "cancelled") return "bad";
  return "busy";
}

function JobToolCard({
  tool,
  status,
  result,
  label,
}: {
  tool: JobTool;
  status: ToolStatus;
  result: string | undefined;
  label: string;
}) {
  const title = JOB_TITLES[tool];
  if (status !== "complete") {
    return (
      <article className="vx-card" data-vx="job">
        <h4>{title}</h4>
        <p className="vx-text vx-dim">
          {status === "inProgress" ? "Preparing…" : "Queuing…"} {label}
        </p>
      </article>
    );
  }
  const parsed = parseToolResult(result);
  if (parsed?.status === "error") {
    return (
      <article className="vx-card" data-vx="job">
        <h4>{title}</h4>
        <p className="vx-err" role="alert">
          {parsed.message}
        </p>
      </article>
    );
  }
  const jobId = parseJobId(result);
  if (!jobId) {
    return (
      <article className="vx-card" data-vx="job">
        <h4>{title}</h4>
        <p className="vx-text">{parsed?.message ?? "No job id came back."}</p>
      </article>
    );
  }
  return <JobPoll jobId={jobId} tool={tool} title={title} label={label} />;
}

/** Polls GET /api/jobs?id= every 2 s until the job is terminal. Unmount-safe; job truth is on disk. */
function JobPoll({ jobId, tool, title, label }: { jobId: string; tool: JobTool; title: string; label: string }) {
  const overlay = useVettuOverlay();
  const refreshRef = useRef(overlay?.refresh);
  useEffect(() => {
    refreshRef.current = overlay?.refresh;
  });
  const [job, setJob] = useState<Job | null>(() => jobCache.get(jobId) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = jobCache.get(jobId);
    if (cached && TERMINAL.has(cached.status)) {
      setJob(cached);
      return;
    }
    let alive = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const { job: next } = await api.jobs.get(jobId);
        if (!alive) return;
        failures = 0;
        jobCache.set(jobId, next);
        setJob(next);
        setError(null);
        if (TERMINAL.has(next.status)) {
          if (next.status === "done" && !refreshedJobs.has(jobId)) {
            refreshedJobs.add(jobId);
            refreshRef.current?.().catch(() => undefined);
          }
          return;
        }
      } catch (e) {
        if (!alive) return;
        failures += 1;
        setError(errorMessage(e, "Could not read the job."));
        if (failures >= 5) return;
      }
      if (alive) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** POST cancel; the server answers with the job file's truth (409 when it already finished). */
  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const { job: next } = await api.jobs.cancel(jobId);
      jobCache.set(jobId, next);
      if (mounted.current) setJob(next);
    } catch (e) {
      if (!mounted.current) return;
      setCancelError(errorMessage(e, "Could not cancel that job."));
      const fresh = await api.jobs.get(jobId).catch(() => null);
      if (fresh && mounted.current) {
        jobCache.set(jobId, fresh.job);
        setJob(fresh.job);
      }
    } finally {
      if (mounted.current) setCancelling(false);
    }
  };

  const status = job?.status ?? "queued";
  const mediaUrl = job?.result?.url;
  const live = !TERMINAL.has(status);
  // The Director (first_assembly) run does not honour cancel yet — no Cancel button for it.
  const kind = tool === "first_assembly" ? "assembly" : (job?.kind ?? null);
  const offerCancel = live && kind !== "assembly" && (job ? canCancel(job) : true);
  return (
    <article className="vx-card" data-vx="job" data-job={jobId} data-status={status}>
      <div className="vx-row">
        <h4>{title}</h4>
        <span className="vx-chip" data-tone={jobTone(status)}>
          {status}
        </span>
      </div>
      <p className="vx-text">{clip(job?.title, 120) || label}</p>
      <p className="vx-mono vx-dim">{jobId}</p>
      {job?.progress && live ? <p className="vx-text vx-dim">{clip(job.progress, 200)}</p> : null}
      {status === "cancelled" ? <p className="vx-text vx-dim">{cancelledLine(kind)}</p> : null}
      {job?.result?.note ? <p className="vx-text">{job.result.note}</p> : null}
      {isMediaUrl(mediaUrl) ? (
        <a className="vx-link" href={mediaUrl} target="_blank" rel="noreferrer">
          Open the result
        </a>
      ) : null}
      {job?.error && status !== "cancelled" ? (
        <p className="vx-err" role="alert">
          {clip(job.error, 200)}
        </p>
      ) : null}
      {error ? (
        <p className="vx-err" role="alert">
          {error}
        </p>
      ) : null}
      {cancelError ? (
        <p className="vx-err" role="alert">
          {cancelError}
        </p>
      ) : null}
      {offerCancel ? (
        <div className="vx-actions">
          <button type="button" className="vx-btn" disabled={cancelling} onClick={() => void cancel()}>
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

// ── change orders ────────────────────────────────────────────────────────────

function ChangeOrdersCard({ status, result }: { status: ToolStatus; result: string | undefined }) {
  if (status !== "complete") {
    return (
      <article className="vx-card" data-vx="change-orders">
        <h4>CHANGE ORDERS</h4>
        <p className="vx-text vx-dim">Reading the review thread…</p>
      </article>
    );
  }
  const parsed = parseToolResult(result);
  if (!parsed || parsed.status === "error") {
    return (
      <article className="vx-card" data-vx="change-orders">
        <h4>CHANGE ORDERS</h4>
        <p className="vx-err" role="alert">
          {parsed?.message ?? "Could not read the change orders."}
        </p>
      </article>
    );
  }
  const { rows } = readCardRows(parsed.data);
  if (!rows.length) {
    return (
      <article className="vx-card" data-vx="change-orders">
        <h4>CHANGE ORDERS</h4>
        <p className="vx-text vx-dim">{parsed.message}</p>
      </article>
    );
  }
  return (
    <div data-vx="change-orders" style={{ display: "grid", gap: 8 }}>
      {rows.map((row) => {
        const task = taskLine({
          task: row.taskId ? { id: row.taskId, url: row.taskUrl } : null,
          taskStatus: row.taskStatus,
          error: row.taskError,
        });
        const time = timeText(row.createdAt);
        return (
          <article key={row.id} className="vx-card" data-vx="change-order" data-kind={row.kind}>
            <div className="vx-row">
              <span className="vx-chip" data-tone={kindTone(row.kind)}>
                {kindLabel(row.kind)}
              </span>
              {row.version != null ? <span className="vx-mono vx-dim">v{row.version}</span> : null}
              {time && row.createdAt ? (
                <time className="vx-mono vx-dim" dateTime={row.createdAt}>
                  {time}
                </time>
              ) : null}
              {row.reviewer ? <strong>{row.reviewer}</strong> : null}
            </div>
            {row.text ? <p className="vx-text">{row.text}</p> : null}
            <p className="vx-mono vx-dim">
              {task.href ? (
                <a className="vx-link" href={task.href} target="_blank" rel="noreferrer">
                  {task.text}
                </a>
              ) : (
                task.text
              )}
            </p>
            {task.error ? (
              <p className="vx-err" role="alert">
                {task.error}
              </p>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

// ── propose_render: the Approve & render gate ────────────────────────────────

type GatePhase = "proposing" | "ready" | "approving" | "approved" | "declining" | "declined" | "error";
interface GateState {
  phase: GatePhase | null;
  proposal: RenderProposal | null;
  version: VersionRecord | null;
  error: string | null;
  where: string | null;
}
const GATE_EMPTY: GateState = { phase: null, proposal: null, version: null, error: null, where: null };
const gates = new Map<string, GateState>();
const gateListeners = new Set<() => void>();

function setGate(id: string, patch: Partial<GateState>) {
  gates.set(id, { ...(gates.get(id) ?? GATE_EMPTY), ...patch });
  gateListeners.forEach((listener) => listener());
}
function subscribeGates(listener: () => void) {
  gateListeners.add(listener);
  return () => {
    gateListeners.delete(listener);
  };
}
function useGate(id: string): GateState {
  const read = () => gates.get(id) ?? GATE_EMPTY;
  return useSyncExternalStore(subscribeGates, read, read);
}

function recordText(version: VersionRecord): string {
  if (version.ambiguous === "saved" && version.task) return `record ${version.task.id}`;
  if (version.ambiguous === "unconfigured") return "record none (Ambiguous not configured)";
  if (version.ambiguous === "failed") return "record none (Ambiguous save failed)";
  return "record none";
}
function slackText(version: VersionRecord): string {
  return version.slack === "posted" ? "posted to Slack" : "queued for Slack";
}

type ProposeArgs = VettuToolArgs<"propose_render">;

interface GateCardProps {
  toolCallId: string;
  args: Partial<ProposeArgs>;
  status: string;
  result?: string;
  respond?: (result: unknown) => Promise<void>;
}

export function ProposeRenderCard({ toolCallId, args, status, result, respond }: GateCardProps) {
  const overlay = useVettuOverlay();
  const gate = useGate(toolCallId);
  const summary = typeof args?.summary === "string" ? args.summary : "";
  const sectionRef = typeof args?.section === "string" ? args.section : undefined;
  const executing = typeof respond === "function";

  // Propose exactly once per tool call — the guard survives minimise/reopen and StrictMode.
  useEffect(() => {
    if (!executing || !summary || gates.has(toolCallId)) return;
    const filmId = overlay?.filmId ?? null;
    const target = resolveSectionRef(overlay?.board, sectionRef, overlay?.activeSection);
    if (!filmId || !target.ok) {
      setGate(toolCallId, { phase: "error", error: !filmId ? NO_FILM : target.ok ? NO_FILM : target.message });
      return;
    }
    setGate(toolCallId, { phase: "proposing", where: sectionLabel(target.section) });
    api.approvals.propose(filmId, target.section.id, summary).then(
      ({ proposal }) => setGate(toolCallId, { phase: "ready", proposal, error: null }),
      (error) => setGate(toolCallId, { phase: "error", error: errorMessage(error, "Could not prepare the render.") }),
    );
  }, [executing, summary, sectionRef, toolCallId, overlay]);

  const approve = async () => {
    const proposal = gate.proposal;
    if (!proposal || !respond || gate.phase === "approving") return;
    setGate(toolCallId, { phase: "approving", error: null });
    let version: VersionRecord;
    try {
      ({ version } = await api.approvals.approve(proposal.id));
    } catch (error) {
      setGate(toolCallId, { phase: "error", error: errorMessage(error, "The render did not finish. Nothing was saved.") });
      return;
    }
    setGate(toolCallId, { phase: "approved", version });
    await respond(`Approved: v${version.version} rendered · ${recordText(version)} · ${slackText(version)}`);
    await overlay?.refresh().catch(() => undefined);
  };

  const decline = async () => {
    if (!respond || gate.phase === "declining" || gate.phase === "approving") return;
    const proposal = gate.proposal;
    const failedToPrepare = !proposal && gate.error;
    setGate(toolCallId, { phase: "declining", error: null });
    if (proposal) {
      try {
        await api.approvals.deny(proposal.id);
      } catch {
        // the proposal expires on its own; nothing was rendered either way
      }
    }
    setGate(toolCallId, { phase: "declined" });
    await respond(
      failedToPrepare
        ? `The render proposal failed: ${failedToPrepare}. Nothing was rendered or saved.`
        : "The user declined. Nothing was rendered or saved.",
    );
  };

  const proposal = gate.proposal;
  const version = gate.version;
  const where = gate.where ?? (sectionRef ? clip(sectionRef, 40) : null);

  let body: React.ReactNode;
  if (gate.phase === "approved" && version) {
    body = (
      <>
        <p className="vx-text">
          <span className="vx-chip" data-tone="ok">
            v{version.version} rendered
          </span>{" "}
          <span className="vx-mono vx-dim">{secsText(version.secs)} · 1080p</span>
        </p>
        <p className="vx-text">
          {version.ambiguous === "saved" && version.task ? (
            <>
              Ambiguous record <code className="vx-mono">{version.task.id}</code>
              {isWebUrl(version.task.url) ? (
                <>
                  {" · "}
                  <a className="vx-link" href={version.task.url} target="_blank" rel="noreferrer">
                    open
                  </a>
                </>
              ) : null}
            </>
          ) : version.ambiguous === "unconfigured" ? (
            "Ambiguous is not configured — no record was saved."
          ) : version.ambiguous === "failed" ? (
            `Ambiguous save failed${version.ambiguousError ? `: ${version.ambiguousError}` : ""}.`
          ) : (
            "No Ambiguous record."
          )}
        </p>
        <p className="vx-text">{version.slack === "posted" ? "Posted to Slack." : "Queued for Slack."}</p>
        {isMediaUrl(version.finalUrl) ? (
          <a className="vx-link" href={version.finalUrl} target="_blank" rel="noreferrer">
            Play the 1080p render
          </a>
        ) : null}
      </>
    );
  } else if (gate.phase === "declined" || gate.phase === "declining") {
    body = <p className="vx-text vx-dim">Declined. Nothing was rendered or saved.</p>;
  } else if (!executing) {
    body = (
      <p className="vx-text vx-dim">
        {status === "complete" ? clip(result, 240) || "Closed." : "Preparing the render proposal…"}
      </p>
    );
  } else {
    body = (
      <>
        {gate.phase === "proposing" || gate.phase === null ? (
          <p className="vx-text vx-dim">Preparing the proposal…</p>
        ) : null}
        {proposal ? (
          <p className="vx-mono vx-dim">
            v{proposal.version} · {proposal.entries} entries · {secsText(proposal.secs)} · expires{" "}
            {new Date(proposal.expiresAt).toLocaleTimeString()}
          </p>
        ) : null}
        {gate.error ? (
          <p className="vx-err" role="alert">
            {gate.error}
          </p>
        ) : null}
        <p className="vx-text vx-dim">Nothing renders until you click Approve.</p>
        <div className="vx-actions">
          {proposal ? (
            <button
              type="button"
              className="vx-btn vx-btn--primary"
              disabled={gate.phase === "approving"}
              onClick={() => void approve()}
            >
              {gate.phase === "approving" ? "Rendering 1080p…" : "Approve & render"}
            </button>
          ) : null}
          {proposal || gate.phase === "error" ? (
            <button
              type="button"
              className="vx-btn"
              disabled={gate.phase === "approving"}
              onClick={() => void decline()}
            >
              {proposal ? "Decline" : "Dismiss"}
            </button>
          ) : null}
        </div>
      </>
    );
  }

  return (
    <article className="vx-card vx-gate" data-vx="approve" data-phase={gate.phase ?? status}>
      <div className="vx-row">
        <h4>FINAL RENDER · 1080p</h4>
        {where ? <span className="vx-chip">{where}</span> : null}
      </div>
      {summary ? <p className="vx-text">{summary}</p> : null}
      {body}
    </article>
  );
}

// ── registration ─────────────────────────────────────────────────────────────

export function VettuUI(_props: VettuOverlayProps) {
  useComponent({
    name: "shot_card",
    description:
      "Show one shot of the open section as a card: its reference, in/out seconds, a one-line description and tags. Use after find_shot or when talking about a specific shot.",
    parameters: shotCardParameters,
    render: ShotCard,
  });

  useRenderTool(
    {
      name: "draw_insert",
      parameters: VETTU_TOOLS.draw_insert.parameters,
      render: ({ status, result, parameters }) => (
        <JobToolCard tool="draw_insert" status={status} result={result} label={clip(parameters?.prompt, 80)} />
      ),
    },
    [],
  );
  useRenderTool(
    {
      name: "animate_insert",
      parameters: VETTU_TOOLS.animate_insert.parameters,
      render: ({ status, result, parameters }) => (
        <JobToolCard
          tool="animate_insert"
          status={status}
          result={result}
          label={clip(parameters?.prompt || parameters?.insertId, 80)}
        />
      ),
    },
    [],
  );
  useRenderTool(
    {
      name: "add_sound",
      parameters: VETTU_TOOLS.add_sound.parameters,
      render: ({ status, result, parameters }) => (
        <JobToolCard
          tool="add_sound"
          status={status}
          result={result}
          label={clip([parameters?.target, parameters?.prompt].filter(Boolean).join(" · "), 80)}
        />
      ),
    },
    [],
  );
  useRenderTool(
    {
      name: "first_assembly",
      parameters: VETTU_TOOLS.first_assembly.parameters,
      render: ({ status, result, parameters }) => (
        <JobToolCard tool="first_assembly" status={status} result={result} label={clip(parameters?.brief, 80)} />
      ),
    },
    [],
  );
  useRenderTool(
    {
      name: "refresh_change_orders",
      parameters: VETTU_TOOLS.refresh_change_orders.parameters,
      render: ({ status, result }) => <ChangeOrdersCard status={status} result={result} />,
    },
    [],
  );

  useHumanInTheLoop(
    {
      name: "propose_render",
      description: VETTU_TOOLS.propose_render.description,
      parameters: VETTU_TOOLS.propose_render.parameters,
      render: ProposeRenderCard,
    },
    [],
  );

  return null;
}
