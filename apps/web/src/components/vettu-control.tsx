"use client";

/**
 * VETTU chat control — hook-only, renders null.
 * One agent context (the film board as the user sees it) + one useFrontendTool per VETTU_TOOLS
 * entry except propose_render (the Approve card in vettu-ui.tsx). Handlers call the ONE api-client,
 * refresh the board, and answer with a short ToolResult. Errors never throw to the model.
 *
 * CopilotKit re-registers a tool only when JSON.stringify(deps) changes, so callbacks in deps never
 * refresh a captured handler. Every handler therefore reads the latest props through refs.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAgentContext, useFrontendTool } from "@copilotkit/react-core/v2";
import { api } from "@/lib/api-client";
import type { BoardSection } from "@/lib/contracts/board-view";
import type { Job } from "@/lib/contracts/jobs";
import type { VettuOverlayProps } from "@/lib/contracts/overlay";
import type { EdlEntry, Timeline } from "@/lib/contracts/timeline";
import { VETTU_TOOLS, type ToolResult, type VettuToolArgs, type VettuToolName } from "@/lib/contracts/tools";
import {
  NO_FILM,
  agentContextValue,
  clip,
  entrySecs,
  errorMessage,
  fail,
  findShots,
  findShotsMessage,
  ok,
  okCut,
  resolveSectionRef,
  resolveShotRef,
  secsText,
  sectionLabel,
  validateToolArgs,
  worldCounts,
  type WorldCounts,
} from "@/lib/tool-run";
import { CO_CARD_MAX, forSection, toCardRow } from "@/components/change-orders/change-order-logic";

export const VETTU_CONTEXT_RULES = [
  "VETTU film board: the open film, its sections (§NN codes), the open section's cards and its edit timeline (EDL), as the user sees them now.",
  "HARD RULES: propose_render only prepares a final render. Only the user's Approve & render click renders 1080p, saves the record to Ambiguous and queues the Slack post.",
  "Never claim a render, a record or a Slack post happened unless the Approve card reported it back.",
  "Slow jobs (draw_insert, animate_insert, add_sound, first_assembly) return job ids at once: say they are queued, never that they finished.",
  "Section refs: §NN code, id or name; omit `section` for the open section. Shot refs: \"S3\", slot \"3\", or an EDL entry id.",
  "Film names are written in capitals. Ask before remove_section. Report each tool's message plainly; when a tool returns status error, say what failed.",
].join(" ");

type ChatToolName = Exclude<VettuToolName, "propose_render">;

function useVettuTool<N extends ChatToolName>(
  name: N,
  run: (args: VettuToolArgs<N>) => Promise<ToolResult>,
  deps: ReadonlyArray<unknown>,
): void {
  const runRef = useRef(run);
  useLayoutEffect(() => {
    runRef.current = run;
  });
  useFrontendTool<Record<string, unknown>>(
    {
      name,
      description: VETTU_TOOLS[name].description,
      parameters: VETTU_TOOLS[name].parameters,
      handler: async (args) => {
        const checked = validateToolArgs(name, args);
        if (!checked.ok) return fail(checked.message);
        try {
          return await runRef.current(checked.data);
        } catch (error) {
          return fail(errorMessage(error));
        }
      },
    },
    deps,
  );
}

type Target = { ok: true; filmId: string; section: BoardSection } | { ok: false; message: string };

function targetOf(p: VettuOverlayProps, ref: string | null | undefined): Target {
  if (!p.filmId || !p.board) return { ok: false, message: NO_FILM };
  const res = resolveSectionRef(p.board, ref, p.activeSection);
  return res.ok ? { ok: true, filmId: p.filmId, section: res.section } : res;
}

type ShotTarget = { ok: true; shot: string; entry: EdlEntry | null; label: string } | { ok: false; message: string };

/** Resolve against the loaded edit when there is one; otherwise the server resolves the raw ref. */
function shotFor(timeline: Timeline | null, ref: string): ShotTarget {
  if (!timeline) return { ok: true, shot: ref, entry: null, label: ref };
  const res = resolveShotRef(timeline, ref);
  if (!res.ok) return res;
  return { ok: true, shot: res.entry.id, entry: res.entry, label: `${res.entry.ref} (#${res.position})` };
}

function jobResult(job: Job, section: BoardSection): ToolResult {
  return ok(
    `Queued ${clip(job.title || job.kind, 80)} in ${section.code} · job ${job.id} · slow: the board updates when it lands`,
    { jobId: job.id, kind: job.kind, status: job.status },
  );
}

export function VettuControl(props: VettuOverlayProps) {
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  // WORLD counts are optional context: one read per film, failures leave them out.
  const [world, setWorld] = useState<{ filmId: string; counts: WorldCounts | null } | null>(null);
  useEffect(() => {
    const filmId = props.filmId;
    if (!filmId) return;
    let alive = true;
    api.films.world(filmId).then(
      (view) => {
        if (alive) setWorld({ filmId, counts: worldCounts(view) });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [props.filmId]);
  const worldForFilm = world && world.filmId === props.filmId ? world.counts : null;

  const value = useMemo(
    () =>
      agentContextValue({
        board: props.board,
        timeline: props.timeline,
        activeSection: props.activeSection,
        world: worldForFilm,
      }),
    [props.board, props.timeline, props.activeSection, worldForFilm],
  );
  useAgentContext({ description: VETTU_CONTEXT_RULES, value });

  const refreshQuietly = async () => {
    try {
      await latest.current.refresh();
    } catch {
      // the change already landed; the board catches up on its next refresh
    }
  };

  /** Section-scoped cut tools: open the section first when it is not the open one, then load its edit. */
  const cutTarget = async (
    ref: string | undefined,
  ): Promise<{ ok: true; filmId: string; section: BoardSection; timeline: Timeline | null } | { ok: false; message: string }> => {
    const p = latest.current;
    const t = targetOf(p, ref);
    if (!t.ok) return t;
    const loaded = p.timeline && p.timeline.section === t.section.id ? p.timeline : null;
    if (t.section.id !== p.activeSection) p.selectSection(t.section.id);
    const timeline = loaded ?? (await api.cut.timeline(t.filmId, t.section.id).catch(() => null));
    return { ...t, timeline };
  };

  const deps = [props.filmId, props.selectSection, props.refresh];

  // ── film + sections ────────────────────────────────────────────────────────

  useVettuTool(
    "rename_film",
    async ({ name }) => {
      const filmId = latest.current.filmId;
      if (!filmId) return fail(NO_FILM);
      const film = await api.films.rename(filmId, name);
      await refreshQuietly();
      return ok(`The film is now ${film.name}`, { film: { id: film.id, name: film.name, rev: film.rev } });
    },
    deps,
  );

  useVettuTool(
    "add_section",
    async ({ name, targetSecs, index }) => {
      const p = latest.current;
      if (!p.filmId) return fail(NO_FILM);
      const before = new Set((p.board?.sections ?? []).map((s) => s.id));
      const film = await api.films.addSection(p.filmId, { name, targetSecs, index });
      await refreshQuietly();
      const added = film.sections.find((s) => !before.has(s.id));
      if (!added) return ok(`Added ${name}`);
      return ok(`Added ${sectionLabel(added)}`, { section: { id: added.id, code: added.code, name: added.name } });
    },
    deps,
  );

  useVettuTool(
    "rename_section",
    async ({ section, name }) => {
      const t = targetOf(latest.current, section);
      if (!t.ok) return fail(t.message);
      const film = await api.films.patchSection(t.filmId, t.section.id, { name });
      await refreshQuietly();
      const now = film.sections.find((s) => s.id === t.section.id);
      return ok(
        `Renamed ${now?.code ?? t.section.code} from ${t.section.name} to ${now?.name ?? name} (the board context now shows the new name).`,
      );
    },
    deps,
  );

  useVettuTool(
    "move_section",
    async ({ section, index }) => {
      const t = targetOf(latest.current, section);
      if (!t.ok) return fail(t.message);
      const film = await api.films.moveSection(t.filmId, t.section.id, index);
      await refreshQuietly();
      const now = film.sections.find((s) => s.id === t.section.id);
      return ok(now ? `${now.name} moved from ${t.section.code} to ${now.code}` : `Moved ${sectionLabel(t.section)}`, {
        order: film.sections.map((s) => sectionLabel(s)),
      });
    },
    deps,
  );

  useVettuTool(
    "park_section",
    async ({ section, parked }) => {
      const t = targetOf(latest.current, section);
      if (!t.ok) return fail(t.message);
      await api.films.patchSection(t.filmId, t.section.id, { parked });
      await refreshQuietly();
      return ok(
        parked
          ? `${sectionLabel(t.section)} is parked · LATER · out of every sum`
          : `${sectionLabel(t.section)} is back in the sums`,
      );
    },
    deps,
  );

  useVettuTool(
    "remove_section",
    async ({ section, withCards }) => {
      const t = targetOf(latest.current, section);
      if (!t.ok) return fail(t.message);
      await api.films.removeSection(t.filmId, t.section.id, withCards ?? false);
      await refreshQuietly();
      return ok(`Removed ${sectionLabel(t.section)}`);
    },
    deps,
  );

  useVettuTool(
    "select_section",
    async ({ section }) => {
      const t = targetOf(latest.current, section);
      if (!t.ok) return fail(t.message);
      latest.current.selectSection(t.section.id);
      return ok(`Opened ${sectionLabel(t.section)}`, {
        section: { id: t.section.id, code: t.section.code, name: t.section.name },
      });
    },
    deps,
  );

  // ── the edit ───────────────────────────────────────────────────────────────

  useVettuTool(
    "find_shot",
    async ({ query, section }) => {
      const p = latest.current;
      const t = targetOf(p, section);
      if (!t.ok) return fail(t.message);
      // Read-only: search the loaded edit when it is this section's; otherwise the board's cards only
      // (fetching another section's timeline would seed one on disk).
      const timeline = p.timeline && p.timeline.section === t.section.id ? p.timeline : null;
      const matches = findShots(query, timeline, [...t.section.cards, ...t.section.reserve]);
      return ok(findShotsMessage(query, t.section, matches), {
        section: t.section.code,
        matches: matches.map((m) => ({ ...m })),
      });
    },
    deps,
  );

  useVettuTool(
    "move_shot",
    async ({ shot, index, section }) => {
      const t = await cutTarget(section);
      if (!t.ok) return fail(t.message);
      const s = shotFor(t.timeline, shot);
      if (!s.ok) return fail(s.message);
      const cut = await api.cut.move({ filmId: t.filmId, section: t.section.id, shot: s.shot, index });
      await refreshQuietly();
      return okCut(`${s.label} moved to #${index + 1} in ${t.section.code}`, cut);
    },
    deps,
  );

  useVettuTool(
    "trim_shot",
    async (args) => {
      const t = await cutTarget(args.section);
      if (!t.ok) return fail(t.message);
      const s = shotFor(t.timeline, args.shot);
      if (!s.ok) return fail(s.message);
      const cut = await api.cut.trim({
        filmId: t.filmId,
        section: t.section.id,
        shot: s.shot,
        delta: args.delta,
        edge: args.edge,
        in: args.in,
        out: args.out,
      });
      await refreshQuietly();
      const before = s.entry;
      const after = before ? cut.timeline.edl.find((e) => e.id === before.id) : undefined;
      const what =
        before && after
          ? `${before.ref} ${secsText(entrySecs(before))} → ${secsText(entrySecs(after))}`
          : `${s.label} trimmed`;
      return okCut(what, cut);
    },
    deps,
  );

  useVettuTool(
    "remove_shot",
    async ({ shot, section }) => {
      const t = await cutTarget(section);
      if (!t.ok) return fail(t.message);
      const s = shotFor(t.timeline, shot);
      if (!s.ok) return fail(s.message);
      const cut = await api.cut.remove({ filmId: t.filmId, section: t.section.id, shot: s.shot });
      await refreshQuietly();
      return okCut(`${s.label} left the ${t.section.code} edit (the film of record is untouched)`, cut);
    },
    deps,
  );

  useVettuTool(
    "set_transition",
    async ({ index, type, dur, section }) => {
      const t = await cutTarget(section);
      if (!t.ok) return fail(t.message);
      const cut = await api.cut.transition({ filmId: t.filmId, section: t.section.id, index, type, dur });
      await refreshQuietly();
      // Name the entry whose transition actually changed (no guessing about index bases).
      const beforeEdl = t.timeline?.edl ?? [];
      const at = cut.timeline.edl.findIndex((e) => {
        const old = beforeEdl.find((o) => o.id === e.id);
        return !!old && (old.transition.type !== e.transition.type || old.transition.dur !== e.transition.dur);
      });
      const into = at >= 0 ? `${cut.timeline.edl[at].ref} (#${at + 1})` : `edit entry ${index}`;
      return okCut(type === "cut" ? `Straight cut into ${into}` : `${type} ${secsText(dur)} into ${into}`, cut);
    },
    deps,
  );

  useVettuTool(
    "set_words",
    async ({ text, start, end, section }) => {
      const t = await cutTarget(section);
      if (!t.ok) return fail(t.message);
      const cut = await api.cut.words({ filmId: t.filmId, section: t.section.id, text, start, end });
      await refreshQuietly();
      return okCut(`"${clip(text, 40)}" on screen ${secsText(start)} → ${secsText(end)}`, cut);
    },
    deps,
  );

  useVettuTool(
    "render_preview",
    async ({ section }) => {
      const t = await cutTarget(section);
      if (!t.ok) return fail(t.message);
      const cut = await api.cut.preview({ filmId: t.filmId, section: t.section.id });
      await refreshQuietly();
      return okCut(`Preview of ${sectionLabel(t.section)}`, cut);
    },
    deps,
  );

  // ── slow jobs ──────────────────────────────────────────────────────────────

  useVettuTool(
    "draw_insert",
    async ({ prompt, refShots, afterShot, secs, section }) => {
      const t = targetOf(latest.current, section);
      if (!t.ok) return fail(t.message);
      const { job } = await api.jobs.create({
        kind: "draw",
        filmId: t.filmId,
        section: t.section.id,
        prompt,
        refShots,
        afterShot,
        secs,
      });
      await refreshQuietly();
      return jobResult(job, t.section);
    },
    deps,
  );

  useVettuTool(
    "animate_insert",
    async ({ fromShot, at, afterShot, secs, insertId, prompt, section }) => {
      const t = targetOf(latest.current, section);
      if (!t.ok) return fail(t.message);
      if (!fromShot && !insertId) return fail('Say which shot to animate (fromShot, e.g. "S13") or which insert to re-animate (insertId).');
      const { job } = await api.jobs.create({
        kind: "animate",
        filmId: t.filmId,
        section: t.section.id,
        ...(fromShot ? { fromShot } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(afterShot ? { afterShot } : {}),
        ...(secs !== undefined ? { secs } : {}),
        ...(insertId ? { insertId } : {}),
        ...(prompt ? { prompt } : {}),
      });
      await refreshQuietly();
      return jobResult(job, t.section);
    },
    deps,
  );

  useVettuTool(
    "add_sound",
    async ({ target, prompt, duration, section }) => {
      const t = targetOf(latest.current, section);
      if (!t.ok) return fail(t.message);
      const { job } = await api.jobs.create({
        kind: "sound",
        filmId: t.filmId,
        section: t.section.id,
        target,
        prompt,
        duration,
      });
      await refreshQuietly();
      return jobResult(job, t.section);
    },
    deps,
  );

  useVettuTool(
    "first_assembly",
    async ({ brief, section }) => {
      const t = targetOf(latest.current, section);
      if (!t.ok) return fail(t.message);
      const { jobId } = await api.director.start(t.filmId, t.section.id, brief);
      await refreshQuietly();
      return ok(
        `The Director took the brief for ${sectionLabel(t.section)} · job ${jobId} · it queues draw → animate → sound in the background`,
        { jobId },
      );
    },
    deps,
  );

  // ── review ─────────────────────────────────────────────────────────────────

  useVettuTool(
    "refresh_change_orders",
    async ({ section }) => {
      const filmId = latest.current.filmId;
      if (!filmId) return fail(NO_FILM);
      let scope: BoardSection | null = null;
      if (section) {
        const t = targetOf(latest.current, section);
        if (!t.ok) return fail(t.message);
        scope = t.section;
      }
      const { changeOrders } = await api.changeOrders.list(filmId);
      const picked = forSection(changeOrders, scope?.id ?? null);
      const rows = picked.slice(0, CO_CARD_MAX).map(toCardRow);
      const n = picked.length;
      const where = scope ? ` for ${sectionLabel(scope)}` : "";
      return ok(
        n
          ? `${n} change order${n === 1 ? "" : "s"}${where} from the review thread`
          : `No change orders${where} yet.`,
        { total: n, section: scope?.id ?? null, changeOrders: rows },
      );
    },
    deps,
  );

  return null;
}
