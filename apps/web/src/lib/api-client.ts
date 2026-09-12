/**
 * The ONE browser client for VETTU's routes (copied from followup-client.ts, cookie Path widened
 * to /api). One shared session handshake, then JSON requests. Board, overlay tools and LIVE all
 * call through here, so hand and agent hit the same routes.
 */
import type { Film, FilmsList } from "@/lib/contracts/film";
import type { BoardView } from "@/lib/contracts/board-view";
import type { WorldView } from "@/lib/contracts/world-view";
import type { CutResult, Timeline } from "@/lib/contracts/timeline";
import type { Job } from "@/lib/contracts/jobs";
import type { ApprovalsView, ChangeOrdersView, RenderProposal, VersionRecord } from "@/lib/contracts/review";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  ifMatch?: number;
  signal?: AbortSignal;
}

export function createApiClient(fetcher: Fetcher) {
  let session: Promise<void> | undefined;
  const initialize = () =>
    (session ??= (async () => {
      const response = await fetcher("/api/films?session=1", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to start a VETTU session. Reload the page.");
      await response.json();
    })().catch((error) => {
      session = undefined;
      throw error;
    }));

  return async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    await initialize();
    const method = options.method ?? (options.body !== undefined ? "POST" : "GET");
    const headers: Record<string, string> = {};
    if (method !== "GET") headers["Content-Type"] = "application/json";
    if (options.ifMatch !== undefined) headers["If-Match"] = String(options.ifMatch);
    const response = await fetcher(`/api${path}`, {
      method,
      headers,
      cache: "no-store",
      signal: options.signal,
      body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
    });
    let result: Record<string, unknown> = {};
    try {
      result = await response.json();
    } catch {
      // non-JSON error bodies fall through to the status message
    }
    if (!response.ok)
      throw new ApiError(
        response.status,
        typeof result.error === "string" ? result.error : `Request failed: HTTP ${response.status}`,
        result,
      );
    return result as T;
  };
}

export const request = createApiClient((url, init) => fetch(url, init));

const q = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) s.set(k, String(v));
  return `?${s.toString()}`;
};
const enc = encodeURIComponent;

/**
 * Store writes need the current rev. `withRev` reads it, applies, and retries ONCE on 409
 * (the hand and the agent share one store).
 */
async function withRev(filmId: string, write: (rev: number) => Promise<Film>): Promise<Film> {
  const first = await request<Film>(`/films/${enc(filmId)}`);
  try {
    return await write(first.rev);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    const again = await request<Film>(`/films/${enc(filmId)}`);
    return write(again.rev);
  }
}

export const api = {
  films: {
    list: () => request<FilmsList>("/films"),
    create: (name: string) => request<Film>("/films", { body: { name } }),
    get: (id: string) => request<Film>(`/films/${enc(id)}`),
    board: (id: string) => request<BoardView>(`/films/${enc(id)}/board`),
    world: (id: string) => request<WorldView>(`/films/${enc(id)}/world`),
    importSaakshe: () => request<Film>("/films/import/saakshe", { body: {} }),
    rename: (id: string, name: string, rev?: number) =>
      rev === undefined
        ? withRev(id, (r) => request<Film>(`/films/${enc(id)}`, { method: "PATCH", body: { name }, ifMatch: r }))
        : request<Film>(`/films/${enc(id)}`, { method: "PATCH", body: { name }, ifMatch: rev }),
    setActive: (id: string, activeSection: string) =>
      withRev(id, (r) => request<Film>(`/films/${enc(id)}`, { method: "PATCH", body: { activeSection }, ifMatch: r })),
    addSection: (id: string, body: { name: string; targetSecs?: number; index?: number }) =>
      withRev(id, (r) => request<Film>(`/films/${enc(id)}/sections`, { body, ifMatch: r })),
    patchSection: (id: string, sid: string, body: { name?: string; targetSecs?: number | null; parked?: boolean }) =>
      withRev(id, (r) =>
        request<Film>(`/films/${enc(id)}/sections/${enc(sid)}`, { method: "PATCH", body, ifMatch: r }),
      ),
    moveSection: (id: string, sid: string, index: number) =>
      withRev(id, (r) => request<Film>(`/films/${enc(id)}/sections/${enc(sid)}/move`, { body: { index }, ifMatch: r })),
    removeSection: (id: string, sid: string, withCards = false) =>
      withRev(id, (r) =>
        request<Film>(`/films/${enc(id)}/sections/${enc(sid)}`, {
          method: "DELETE",
          body: withCards ? { withCards: true } : {},
          ifMatch: r,
        }),
      ),
  },
  cut: {
    timeline: (filmId: string, section: string) => request<Timeline>(`/cut/timeline${q({ film: filmId, section })}`),
    reseed: (filmId: string, section: string) =>
      request<Timeline>(`/cut/timeline${q({ film: filmId, section })}`, { body: { filmId, section, reseed: true } }),
    trim: (body: { filmId: string; section: string; shot: string; in?: number; out?: number; delta?: number; edge?: "in" | "out" }) =>
      request<CutResult>("/cut/trim", { body }),
    move: (body: { filmId: string; section: string; shot: string; index: number }) =>
      request<CutResult>("/cut/move", { body }),
    remove: (body: { filmId: string; section: string; shot: string }) => request<CutResult>("/cut/remove", { body }),
    transition: (body: { filmId: string; section: string; index: number; type: "cut" | "fade" | "slideleft"; dur: number }) =>
      request<CutResult>("/cut/transition", { body }),
    words: (body: { filmId: string; section: string; text: string; start: number; end: number }) =>
      request<CutResult>("/cut/words", { body }),
    preview: (body: { filmId: string; section: string }) => request<CutResult>("/cut/preview", { body }),
  },
  jobs: {
    list: (filmId: string, section?: string) => request<{ jobs: Job[] }>(`/jobs${q({ filmId, section })}`),
    get: (id: string) => request<{ job: Job }>(`/jobs${q({ id })}`),
    create: (body: Record<string, unknown>) => request<{ job: Job }>("/jobs", { body }),
    cancel: (jobId: string) => request<{ job: Job }>("/jobs", { body: { operation: "cancel", jobId } }),
  },
  approvals: {
    get: (filmId: string, section: string) => request<ApprovalsView>(`/approvals${q({ filmId, section })}`),
    propose: (filmId: string, section: string, summary: string) =>
      request<{ proposal: RenderProposal }>("/approvals", {
        body: { operation: "propose_render", filmId, section, summary },
      }),
    approve: (proposalId: string) =>
      request<{ version: VersionRecord }>("/approvals", { body: { operation: "approve", proposalId } }),
    deny: (proposalId: string) =>
      request<{ status: "declined" }>("/approvals", { body: { operation: "deny", proposalId } }),
  },
  changeOrders: {
    list: (filmId: string) => request<ChangeOrdersView>(`/change-orders${q({ filmId })}`),
  },
  director: {
    start: (filmId: string, section: string, brief: string) =>
      request<{ jobId: string }>("/director", { body: { filmId, section, brief } }),
  },
  live: {
    check: () => request<{ available: boolean; reason: string | null }>("/live-token?check=1"),
    token: () => request<{ token: string }>("/live-token"),
  },
};
