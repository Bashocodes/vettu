/**
 * LIVE voice — provider-neutral pure helpers. No React, no DOM, no network. Browser-safe.
 * Used by live-voice.tsx (ElevenLabs Agents) and /api/live-token; covered by voice.test.ts.
 *
 * - transcript/status rows with stable ids, never re-sorted, at most MAX_LINES kept
 * - voice tool arguments → validated with THE ONE registry (contracts/tools.ts)
 * - a runTool result → one short sentence for the agent to speak
 * - the LIVE button state from availability + session phase
 * - the open film's board → a few lines of silent context for the agent
 */
import type { BoardCard, BoardSection } from "@/lib/contracts/board-view";
import type { LiveLine, LiveState } from "@/lib/contracts/overlay";
import { VETTU_TOOLS, VETTU_TOOL_NAMES, type VettuToolName } from "@/lib/contracts/tools";

/* ---------------- controlled texts (never provider text) ---------------- */

export const LIVE_NEEDS_KEY = "LIVE · needs ELEVENLABS_API_KEY";
export const LIVE_NEEDS_AGENT = "LIVE · needs ElevenLabs agent";
export const LIVE_CHECKING = "LIVE · checking…";
export const LIVE_CHECK_FAILED = "LIVE · could not reach the token route";
export const LIVE_TOKEN_FAILED = "LIVE · could not get a voice token. Try again.";
export const LIVE_MIC_BLOCKED = "LIVE · microphone blocked. Allow it and try again.";
export const LIVE_START_FAILED = "LIVE · the voice call could not start.";
export const LIVE_DROPPED = "LIVE · the voice connection dropped.";
export const LIVE_IDLE_ENDED = "LIVE · ended after 5 minutes without speech";
export const TOOL_NOT_READY = "That tool is not ready on the board right now.";

export const MAX_LINES = 50;
export const MAX_LINE_CHARS = 400;
export const MAX_SPOKEN_CHARS = 280;
export const MAX_CONTEXT_CHARS = 1500;
export const IDLE_END_MS = 5 * 60_000;
export const CONTEXT_DEBOUNCE_MS = 1_000;

/* ---------------- tool names ---------------- */

/** The client tools the ElevenLabs agent may call. Names must match the agent's dashboard exactly. */
export const VOICE_TOOL_NAMES = [
  "select_section",
  "find_shot",
  "trim_shot",
  "move_shot",
  "remove_shot",
  "rename_section",
  "move_section",
  "set_transition",
  "set_words",
  "render_preview",
  "add_sound",
  "animate_insert",
] as const satisfies readonly VettuToolName[];
export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

/**
 * Registry tools that stay typed-chat only. If the agent declares one anyway, it gets a spoken
 * refusal instead of a call that never answers.
 */
export const TYPED_ONLY_TOOL_NAMES: readonly VettuToolName[] = VETTU_TOOL_NAMES.filter(
  (name) => !(VOICE_TOOL_NAMES as readonly string[]).includes(name),
);

/* ---------------- small text helpers ---------------- */

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/* ---------------- rows ---------------- */

export interface LineModel {
  prefix: string;
  seq: number;
  lines: LiveLine[];
}

export function createLines(prefix: string): LineModel {
  return { prefix, seq: 0, lines: [] };
}

/** Append one row. Ids keep counting across clears, so a React key is never reused. */
export function pushLine(model: LineModel, who: LiveLine["who"], text: string): LineModel {
  const clean = oneLine(typeof text === "string" ? text : "");
  if (!clean) return model;
  const seq = model.seq + 1;
  const lines = [...model.lines, { id: `${model.prefix}-${seq}`, who, text: clip(clean, MAX_LINE_CHARS) }];
  return { ...model, seq, lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines };
}

export function clearLines(model: LineModel): LineModel {
  return { ...model, lines: [] };
}

/* ---------------- tool arguments ---------------- */

export type ArgsCheck = { ok: true; data: Record<string, unknown> } | { ok: false; message: string };

/** Voice agents send null or "" for an omitted optional; the zod schemas want the key absent. */
export function stripEmpty(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}

/** One retry for scalars spoken as the wrong JSON type: "0.5" for a number, 3 for a shot string. */
function coerceScalars(
  record: Record<string, unknown>,
  issues: ReadonlyArray<{ code: string; path: PropertyKey[]; expected?: unknown }>,
): Record<string, unknown> | null {
  let next: Record<string, unknown> | null = null;
  for (const issue of issues) {
    if (issue.code !== "invalid_type" || issue.path.length !== 1 || typeof issue.path[0] !== "string") continue;
    const key = issue.path[0];
    const value = record[key];
    let fixed: unknown = undefined;
    if (issue.expected === "number" && typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
      fixed = Number(value);
    } else if (issue.expected === "string" && typeof value === "number" && Number.isFinite(value)) {
      fixed = String(value);
    } else if (issue.expected === "boolean" && (value === "true" || value === "false")) {
      fixed = value === "true";
    }
    if (fixed !== undefined) {
      next ??= { ...record };
      next[key] = fixed;
    }
  }
  return next;
}

export function checkToolArgs(name: string, raw: unknown): ArgsCheck {
  if (!Object.prototype.hasOwnProperty.call(VETTU_TOOLS, name)) {
    return { ok: false, message: "That tool does not exist in VETTU." };
  }
  const schema = VETTU_TOOLS[name as VettuToolName].parameters;
  const candidate = stripEmpty(raw);
  let parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const coerced = coerceScalars(candidate, parsed.error.issues);
    if (coerced) parsed = schema.safeParse(coerced);
  }
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.map(String).join(".") || "body" : "";
    return { ok: false, message: `Invalid arguments${issue ? `: ${where} — ${issue.message}` : "."}` };
  }
  return { ok: true, data: parsed.data as Record<string, unknown> };
}

/* ---------------- tool results ---------------- */

export interface ToolOutcome {
  ok: boolean;
  message: string;
}

/** Links and API paths are never read out. */
const unspeakable = (text: string) =>
  oneLine(text.replace(/https?:\/\/\S+/g, "").replace(/\/api\/\S+/g, "").replace(/\s+·\s+(?=·|$)/g, ""));

/** Read a copilotkit.runTool result: `result` is the handler's stringified ToolResult (or plain text). */
export function toolOutcome(run: { result?: unknown; error?: unknown } | null | undefined): ToolOutcome {
  if (!run) return { ok: false, message: TOOL_NOT_READY };
  if (typeof run.error === "string" && run.error) return { ok: false, message: clip(oneLine(run.error), 300) };
  const text = typeof run.result === "string" ? run.result : "";
  try {
    const parsed = asRecord(JSON.parse(text));
    if (parsed && (parsed.status === "ok" || parsed.status === "error")) {
      const message = typeof parsed.message === "string" ? parsed.message : "";
      return { ok: parsed.status === "ok", message: clip(oneLine(message), 300) };
    }
  } catch {
    // plain text result
  }
  return { ok: true, message: clip(oneLine(text), 300) };
}

/** The ONE short sentence the agent speaks back: "done · …" or "failed · …". */
export function spokenResult(outcome: ToolOutcome): string {
  const message = unspeakable(outcome.message);
  if (outcome.ok) return clip(message ? `done · ${message}` : "done", MAX_SPOKEN_CHARS);
  return clip(`failed · ${message || "VETTU could not finish that."}`, MAX_SPOKEN_CHARS);
}

/** Status row for a tool run (outside the captions). */
export function toolLine(name: string, outcome: ToolOutcome): string {
  const message = unspeakable(outcome.message);
  return `${name} · ${outcome.ok ? "done" : "failed"}${message ? ` · ${clip(message, 120)}` : ""}`;
}

export function typedOnlyOutcome(name: string): ToolOutcome {
  return { ok: false, message: `${name.replace(/_/g, " ")} works in the typed VETTU chat only.` };
}

export function unknownToolLine(name: unknown): string {
  const safe = typeof name === "string" ? name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : "";
  return `LIVE · the agent asked for a tool VETTU does not have${safe ? ` (${safe})` : ""}`;
}

/* ---------------- availability + state ---------------- */

export interface Availability {
  available: boolean;
  reason: string | null;
}

/** GET /api/live-token?check=1 body → availability. Anything unexpected = unavailable. */
export function parseAvailability(body: unknown): Availability {
  const record = asRecord(body);
  if (record?.available === true) return { available: true, reason: null };
  const reason = typeof record?.reason === "string" && record.reason ? record.reason : LIVE_NEEDS_AGENT;
  return { available: false, reason };
}

/** idle → token (fetching the token) → connecting (SDK) → connected. */
export type SessionPhase = "idle" | "token" | "connecting" | "connected";

export function liveStateOf(input: {
  available: boolean | null;
  phase: SessionPhase;
  speaking: boolean;
  failed: boolean;
}): LiveState {
  if (input.phase === "connected") return input.speaking ? "speaking" : "listening";
  if (input.phase === "token" || input.phase === "connecting") return "connecting";
  if (input.available !== true) return "unavailable";
  return input.failed ? "error" : "off";
}

function errorName(context: unknown): string {
  const record = asRecord(context) ?? (context instanceof Error ? (context as unknown as Json) : null);
  return typeof record?.name === "string" ? record.name : "";
}

/** A start that never connected (mic, token, network) → the button's controlled reason. */
export function startFailureReason(message: unknown, context?: unknown): string {
  const name = errorName(context);
  const text = typeof message === "string" ? message : "";
  if (name === "NotAllowedError" || name === "SecurityError" || /permission|not allowed|denied/i.test(text)) {
    return LIVE_MIC_BLOCKED;
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || /requested device not found/i.test(text)) {
    return "LIVE · no microphone found.";
  }
  if (name === "NotReadableError") return "LIVE · the microphone is busy in another app.";
  return LIVE_START_FAILED;
}

/** An error while the call stays up → one status row. */
export function midCallErrorLine(message: unknown): string {
  const text = typeof message === "string" ? message : "";
  if (/microphone permission denied/i.test(text)) return LIVE_MIC_BLOCKED;
  return "LIVE · a request was refused";
}

export interface DisconnectOutcome {
  failed: boolean;
  reason: string | null;
  line: string;
}

export function disconnectOutcome(details: unknown): DisconnectOutcome {
  const record = asRecord(details);
  const reason = typeof record?.reason === "string" ? record.reason : "";
  const context = asRecord(record?.context);
  if (reason === "error") {
    if (context?.type === "max_duration_exceeded") {
      return { failed: false, reason: null, line: "LIVE · the call reached its time limit" };
    }
    return { failed: true, reason: LIVE_DROPPED, line: "LIVE · connection lost" };
  }
  if (reason === "agent") return { failed: false, reason: null, line: "LIVE · VETTU ended the call" };
  return { failed: false, reason: null, line: "LIVE · ended" };
}

/* ---------------- silent context for the agent ---------------- */

export function filmIdFrom(search: string): string | null {
  const id = new URLSearchParams(search).get("film")?.trim() ?? "";
  return id && id.length <= 100 ? id : null;
}

export const NO_FILM_CONTEXT = "VETTU board: no film is open. Ask the user to open or import a film on the board.";

const MAX_CONTEXT_SECTIONS = 20;
const MAX_CONTEXT_SHOTS = 16;

const secs = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 10) / 10} s` : "";

/** The part of a BoardView the agent's context reads (a BoardView fits). */
export interface ContextBoard {
  film: string;
  active: string | null;
  sections: ReadonlyArray<
    Pick<BoardSection, "id" | "code" | "name" | "durText" | "out"> & {
      cards: ReadonlyArray<Pick<BoardCard, "id" | "slot" | "caption" | "secs">>;
    }
  >;
}

/** A few lines: film · sections · open section · its shots. Capped at MAX_CONTEXT_CHARS. */
export function boardContextText(board: ContextBoard): string {
  const lines = [`VETTU board · film ${oneLine(board.film)}`];
  const sections = board.sections.slice(0, MAX_CONTEXT_SECTIONS).map((section) => {
    const parked = section.out ? " (parked)" : "";
    return `${section.code} ${oneLine(section.name)} ${section.durText}${parked}`.trim();
  });
  if (sections.length) lines.push(`Sections: ${sections.join(" · ")}`);
  if (board.sections.length > MAX_CONTEXT_SECTIONS) lines.push(`(+${board.sections.length - MAX_CONTEXT_SECTIONS} more sections)`);

  const open = board.active ? board.sections.find((section) => section.id === board.active) : undefined;
  if (!open) {
    lines.push("No section is open. Ask which section to edit, then use select_section.");
  } else {
    lines.push(`Open section: ${open.code} ${oneLine(open.name)}`);
    const shots = open.cards.slice(0, MAX_CONTEXT_SHOTS).map((card, index) => {
      const label = card.slot != null ? `S${card.slot}` : (card.id.split("/").pop() ?? `S${index + 1}`);
      const caption = clip(oneLine(card.caption ?? ""), 40);
      return [label, caption, secs(card.secs)].filter(Boolean).join(" ");
    });
    lines.push(shots.length ? `Shots in ${open.code}: ${shots.join(" · ")}` : `${open.code} has no shots yet.`);
    if (open.cards.length > MAX_CONTEXT_SHOTS) lines.push(`(+${open.cards.length - MAX_CONTEXT_SHOTS} more shots)`);
  }
  lines.push('Shot refs: "S3" or "3". Section refs: "§04" or the section name.');
  return clip(lines.join("\n"), MAX_CONTEXT_CHARS);
}
