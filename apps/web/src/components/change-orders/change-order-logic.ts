/**
 * Pure helpers for VETTU change orders (no I/O, no React). Browser-safe + tests.
 * Used by the board strip (ChangeOrderStrip) and the chat card for refresh_change_orders.
 */
import type { ChangeOrder } from "@/lib/contracts/review";

export const CO_STRIP_MAX = 6;
export const CO_POLL_MS = 10000;
/** Rows handed back to the model / chat card. */
export const CO_CARD_MAX = 12;

export type CoTone = "ok" | "bad" | "busy" | "off";

export function clipText(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

/** Slack user / workspace / bot ids and <@U…> mentions: never shown as a name. */
const SLACK_ID = /^(?:<@)?[UWB][A-Z0-9]{6,}>?$/;

/** The reviewer's real name, or null (never a raw Slack id). */
export function reviewerName(reviewer: { id?: string | null; name?: string | null } | null | undefined): string | null {
  const name = typeof reviewer?.name === "string" ? reviewer.name.trim() : "";
  if (!name) return null;
  const id = typeof reviewer?.id === "string" ? reviewer.id.trim() : "";
  if (id && name === id) return null;
  if (SLACK_ID.test(name)) return null;
  return clipText(name, 80);
}

export function kindLabel(kind: string | null | undefined): string {
  return kind === "approve" ? "Approved" : "Changes requested";
}

export function kindTone(kind: string | null | undefined): CoTone {
  return kind === "approve" ? "ok" : "busy";
}

/** Only an https URL becomes a link. */
export function httpsUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export interface TaskLine {
  text: string;
  href: string | null;
  tone: CoTone;
  error: string | null;
}

const STATUSES = new Set(["pending", "created", "skipped", "failed"]);

/** "Ambiguous task <id>" (linked only for https), or the honest task status with its error. */
export function taskLine(o: {
  task?: { id?: string | null; url?: string | null } | null;
  taskStatus?: string | null;
  error?: string | null;
}): TaskLine {
  const id = typeof o.task?.id === "string" ? o.task.id.trim() : "";
  const error = clipText(o.error, 200) || null;
  if (id) return { text: `Ambiguous task ${clipText(id, 80)}`, href: httpsUrl(o.task?.url), tone: "ok", error };
  const status = typeof o.taskStatus === "string" && STATUSES.has(o.taskStatus) ? o.taskStatus : "pending";
  const tone: CoTone = status === "failed" ? "bad" : status === "pending" ? "busy" : status === "skipped" ? "off" : "ok";
  return { text: `Ambiguous task ${status}`, href: null, tone, error };
}

function isOrder(x: unknown): x is ChangeOrder {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.section === "string" && typeof o.createdAt === "string";
}

const stamp = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : -Infinity;
};

/** Valid orders, filtered to a section id when given, newest first. */
export function forSection(orders: unknown, sectionId?: string | null): ChangeOrder[] {
  const list = Array.isArray(orders) ? orders.filter(isOrder) : [];
  const picked = sectionId ? list.filter((o) => o.section === sectionId) : list;
  return picked
    .map((o, i) => ({ o, i }))
    .sort((a, b) => stamp(b.o.createdAt) - stamp(a.o.createdAt) || a.i - b.i)
    .map(({ o }) => o);
}

export function stripOrders(orders: unknown, sectionId: string): ChangeOrder[] {
  return forSection(orders, sectionId).slice(0, CO_STRIP_MAX);
}

export type ChangeOrderCardRow = {
  id: string;
  section: string | null;
  version: number | null;
  kind: "approve" | "changes";
  text: string | null;
  reviewer: string | null;
  createdAt: string | null;
  taskId: string | null;
  taskUrl: string | null;
  taskStatus: "pending" | "created" | "skipped" | "failed";
  taskError: string | null;
};

export function toCardRow(o: ChangeOrder): ChangeOrderCardRow {
  const status = STATUSES.has(o.taskStatus) ? o.taskStatus : "pending";
  return {
    id: o.id,
    section: o.section ?? null,
    version: typeof o.version === "number" ? o.version : null,
    kind: o.kind === "approve" ? "approve" : "changes",
    text: o.text == null ? null : clipText(o.text, 300) || null,
    reviewer: reviewerName(o.reviewer),
    createdAt: o.createdAt ?? null,
    taskId: o.task?.id ? clipText(o.task.id, 80) : null,
    taskUrl: httpsUrl(o.task?.url),
    taskStatus: status,
    taskError: clipText(o.error, 200) || null,
  };
}

/** Defensive read of the tool result data for the chat card. */
export function readCardRows(data: unknown): { rows: ChangeOrderCardRow[]; total: number } {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const list = Array.isArray(d.changeOrders) ? d.changeOrders : [];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const rows = list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x, i): ChangeOrderCardRow => {
      const status = str(x.taskStatus);
      return {
        id: str(x.id) ?? `row-${i}`,
        section: str(x.section),
        version: typeof x.version === "number" ? x.version : null,
        kind: x.kind === "approve" ? "approve" : "changes",
        text: str(x.text),
        reviewer: reviewerName({ name: str(x.reviewer) }),
        createdAt: str(x.createdAt),
        taskId: str(x.taskId),
        taskUrl: httpsUrl(x.taskUrl),
        taskStatus: status && STATUSES.has(status) ? (status as ChangeOrderCardRow["taskStatus"]) : "pending",
        taskError: str(x.taskError),
      };
    });
  return { rows, total: typeof d.total === "number" ? d.total : rows.length };
}

/** Local HH:MM, or "" for a bad stamp. */
export function timeText(iso: string | null | undefined): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
