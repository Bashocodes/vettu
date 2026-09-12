/**
 * Channel → VETTU web app, server to server over loopback (KIT_CHANNEL §7b).
 *
 * The web app cannot post into Slack (proactive delivery does not exist), so it
 * only queues. These three calls are how the review thread pulls that queue and
 * reports decisions back. Errors are short controlled sentences, never raw fetch
 * or server internals.
 */
import { required } from "./env";
import {
  changeOrderBody,
  reviewPostedBody,
  reviewQueueItem,
  type ChangeOrderBody,
  type ReviewQueueItem,
} from "./review-types";

const TIMEOUT_MS = 10_000;

export class WebError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "WebError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface WebClient {
  /** Approved cuts not yet posted to Slack, oldest first. */
  getQueue(): Promise<ReviewQueueItem[]>;
  /** Only after the preview uploaded AND the review card posted. */
  markPosted(cutId: string): Promise<void>;
  /** Idempotent on `idempotencyKey` server-side. */
  postChangeOrder(body: ChangeOrderBody): Promise<{ duplicate: boolean }>;
}

export interface WebClientOptions {
  /** Web app origin, e.g. http://127.0.0.1:3100. Defaults to VETTU_WEB_URL, read per call. */
  baseUrl?: string;
  /** Injected in tests; defaults to Node's global fetch. */
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** The web app origin. Must be a loopback origin: VETTU's service guard refuses anything else. */
export function webBase(): string {
  return trimBase(required("VETTU_WEB_URL"));
}

function trimBase(value: string): string {
  return value.replace(/\/+$/, "");
}

function serverMessage(payload: unknown): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) return error.trim().slice(0, 200);
  }
  return "the request failed.";
}

export function createWebClient(options: WebClientOptions = {}): WebClient {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const send: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    // Outside the try: a missing VETTU_WEB_URL is a configuration error, not "unreachable".
    const base = options.baseUrl ? trimBase(options.baseUrl) : webBase();
    let response: Response;
    let text: string;
    try {
      response = await send(`${base}${path}`, {
        method,
        headers: { accept: "application/json", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new WebError(`VETTU did not answer within ${Math.round(timeoutMs / 1000)} s.`);
      }
      throw new WebError("VETTU is not reachable.");
    }
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      throw new WebError(`VETTU answered ${response.status}: ${serverMessage(payload)}`, response.status);
    }
    return payload;
  }

  return {
    async getQueue() {
      const payload = await call("GET", "/api/review/queue");
      if (!Array.isArray(payload)) throw new WebError("VETTU returned an unexpected review queue.");
      const items: ReviewQueueItem[] = [];
      for (const raw of payload) {
        const parsed = reviewQueueItem.safeParse(raw);
        if (parsed.success) items.push(parsed.data);
        else console.warn("[vettu-review] skipped a malformed review queue item");
      }
      return items;
    },

    async markPosted(cutId) {
      const body = reviewPostedBody.safeParse({ cutId });
      if (!body.success) throw new WebError("That cut id is not valid.");
      await call("POST", "/api/review/posted", body.data);
    },

    async postChangeOrder(input) {
      const body = changeOrderBody.safeParse(input);
      if (!body.success) throw new WebError("That change order is not valid.");
      const payload = await call("POST", "/api/change-orders", body.data);
      const duplicate =
        !!payload && typeof payload === "object" && (payload as { duplicate?: unknown }).duplicate === true;
      return { duplicate };
    },
  };
}

/** The listener's client: VETTU_WEB_URL is read when a call is made, not at import. */
export const web: WebClient = createWebClient();

export const getQueue = () => web.getQueue();
export const markPosted = (cutId: string) => web.markPosted(cutId);
export const postChangeOrder = (body: ChangeOrderBody) => web.postChangeOrder(body);
