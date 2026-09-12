/**
 * Approve → 1080p → Ambiguous → review queue (KIT_WEB §3d/§4, copied from the kit's
 * FollowupService rules). propose_render writes ONE proposal file and renders nothing;
 * only approve (session + expiry + unchanged edlHash + one-time decision) renders and records.
 * Nothing goes back into the film of record. Server only.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { mediaUrl, sectionCode } from "@/lib/contracts/film";
import {
  cutIdOf,
  markerOf,
  type ApprovalsView,
  type RenderProposal,
  type VersionRecord,
  type WorkplaceTaskRef,
} from "@/lib/contracts/review";
import type { Timeline } from "@/lib/contracts/timeline";
import { defaultWorkplaceFactory, type WorkplaceFactory } from "./change-orders";
import { requireFilm } from "./film-store";
import { FollowupError } from "./followup-error";
import { HttpError } from "./guard";
import { enqueueReview, versionPath } from "./review-queue";
import { dataDir } from "./roots";
import { atomicWriteJson, claimFile, listJsonFiles, readJson } from "./ffmpeg/disk";
import { RenderError, renderFinal, type FinalOutcome } from "./ffmpeg/run";
import { edlHash, edlSecs, loadTimeline, resolveSection, updateTimeline } from "./timeline";

interface StoredProposal extends RenderProposal {
  sessionHash: string;
}

export interface ApprovalDeps {
  render?: (t: Timeline, version: number) => Promise<FinalOutcome>;
  workplace?: WorkplaceFactory;
  now?: () => number;
}

const EXPIRY_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dir = () => join(dataDir(), "approvals");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function edlTable(t: Timeline): string {
  const rows = t.edl.map(
    (e, i) =>
      `| ${i + 1} | ${e.ref} | ${e.in.toFixed(3)}–${e.out.toFixed(3)} | ${i === 0 || e.transition.type === "cut" ? "cut" : `${e.transition.type} ${e.transition.dur} s`} |`,
  );
  return ["| entry | ref | in–out | transition |", "|---|---|---|---|", ...rows].join("\n");
}

export function createApprovals(deps: ApprovalDeps = {}) {
  const now = deps.now ?? Date.now;
  const render = deps.render ?? renderFinal;
  const workplaceFactory = deps.workplace ?? defaultWorkplaceFactory;
  const iso = (ms: number) => new Date(ms).toISOString();

  async function readProposal(session: string, id: string): Promise<StoredProposal> {
    if (!UUID.test(id)) throw new HttpError(404, "No such proposal.");
    const p = await readJson<StoredProposal>(join(dir(), `${id}.json`));
    if (!p) throw new HttpError(404, "No such proposal.");
    if (p.sessionHash !== sha(session)) throw new HttpError(403, "This proposal belongs to another browser session.");
    if (Date.parse(p.expiresAt) <= now()) throw new HttpError(410, "This proposal expired. Propose the render again.");
    return p;
  }

  async function decide(id: string, decision: "approved" | "declined") {
    const path = join(dir(), `${id}.decision`);
    if (await claimFile(path, decision)) return;
    const saved = (await readFile(path, "utf8").catch(() => "decided")).trim();
    throw new HttpError(409, `This proposal was already ${saved}.`);
  }

  return {
    async propose(session: string, body: { filmId: string; section: string; summary: string }): Promise<RenderProposal> {
      const t = await loadTimeline(body.filmId, body.section);
      if (t.edl.length === 0) throw new HttpError(422, "The edit needs at least one shot.");
      const created = now();
      const p: StoredProposal = {
        id: randomUUID(),
        filmId: t.filmId,
        section: t.section,
        version: t.version + 1,
        edlHash: edlHash(t),
        summary: body.summary,
        entries: t.edl.length,
        secs: edlSecs(t),
        createdAt: iso(created),
        expiresAt: iso(created + EXPIRY_MS),
        sessionHash: sha(session),
      };
      await claimFile(join(dir(), `${p.id}.json`), JSON.stringify(p, null, 2));
      const { sessionHash: _s, ...publicProposal } = p;
      return publicProposal;
    },

    async deny(session: string, id: string): Promise<void> {
      await readProposal(session, id);
      await decide(id, "declined");
    },

    async approve(session: string, id: string): Promise<VersionRecord> {
      const p = await readProposal(session, id);
      const t = await loadTimeline(p.filmId, p.section);
      if (edlHash(t) !== p.edlHash) throw new HttpError(409, "The edit changed; propose again");
      if (t.version + 1 !== p.version) throw new HttpError(409, "A newer version was approved; propose again");
      await decide(id, "approved");
      const vPath = versionPath(p.filmId, p.section, p.version);
      const claim = `${vPath}.claim`;
      if (!(await claimFile(claim, p.id)))
        throw new HttpError(409, `Version ${p.version} is already approved; propose again`);

      let out: FinalOutcome;
      try {
        out = await render(t, p.version);
      } catch (error) {
        await unlink(claim).catch(() => undefined);
        throw new HttpError(502, error instanceof RenderError ? error.message : "The final render failed.");
      }

      const film = await requireFilm(p.filmId);
      const section = resolveSection(film, p.section);
      const name = `${film.name.toUpperCase()} · ${section.code || sectionCode(section.order)} ${section.name} · v${p.version}`;
      const cutId = cutIdOf(p.filmId, p.section, p.version);
      const marker = markerOf(p.filmId, p.section, p.version);

      let ambiguous: VersionRecord["ambiguous"] = "unconfigured";
      let ambiguousError: string | null = null;
      let task: WorkplaceTaskRef | null = null;
      let connection: Awaited<ReturnType<WorkplaceFactory>>;
      try {
        connection = await workplaceFactory();
      } catch {
        connection = undefined;
        ambiguous = "failed";
        ambiguousError = "Could not connect to Ambiguous.";
      }
      if (connection) {
        const title = `VETTU · ${name}`;
        const description = [p.summary, "", edlTable(t), "", marker].join("\n");
        try {
          const found = (await connection.workplace.list(marker)).filter(
            (x) => x.title === title && x.description.split("\n").includes(marker),
          );
          if (found.length > 1) throw new FollowupError("Ambiguous holds more than one record for this version.");
          let recordId: string;
          if (found[0]) recordId = found[0].id;
          else {
            const created = await connection.workplace.create(title, description, async () => {
              // An uncertain earlier write is never retried.
              if (!(await claimFile(join(dir(), `${sha(marker)}.attempt`), p.id)))
                throw new FollowupError("An earlier write for this version is uncertain; check Ambiguous.");
            });
            recordId = created.id;
          }
          const record = await connection.workplace.get(recordId);
          if (record.id !== recordId || record.title !== title || record.description !== description)
            throw new FollowupError("The Ambiguous record differs from the approved fields.");
          task = { id: record.id, title: record.title, url: record.url };
          ambiguous = "saved";
        } catch (error) {
          ambiguous = "failed";
          ambiguousError =
            error instanceof FollowupError ? error.message : "Ambiguous did not confirm the record; check the workspace.";
        } finally {
          await connection.close().catch(() => undefined);
        }
      }

      const record: VersionRecord = {
        version: p.version,
        filmId: p.filmId,
        section: p.section,
        cutId,
        marker,
        edlHash: p.edlHash,
        summary: p.summary,
        secs: out.secs,
        finalUrl: mediaUrl(out.final) ?? "",
        previewUrl: mediaUrl(out.preview) ?? "",
        task,
        ambiguous,
        ambiguousError,
        approvedAt: iso(now()),
        slack: "queued",
        postedAt: null,
      };
      await atomicWriteJson(vPath, record);
      await updateTimeline(p.filmId, p.section, (cur) => {
        cur.version = Math.max(cur.version, p.version);
        if (edlHash(cur) === p.edlHash) {
          cur.status = "approved";
          cur.lastChange = `approved v${p.version}`;
        }
        return cur;
      });
      await enqueueReview({ cutId, version: p.version, title: name, previewPath: out.previewPath, posterPath: out.posterPath });
      return record;
    },

    async view(session: string, filmId: string, sectionRef: string): Promise<ApprovalsView> {
      const film = await requireFilm(filmId);
      const section = resolveSection(film, sectionRef);
      const proposals: StoredProposal[] = [];
      for (const n of await listJsonFiles(dir())) {
        const p = await readJson<StoredProposal>(join(dir(), n)).catch(() => null);
        if (!p || p.filmId !== film.id || p.section !== section.id || p.sessionHash !== sha(session)) continue;
        if (Date.parse(p.expiresAt) <= now()) continue;
        const decided = await readFile(join(dir(), `${p.id}.decision`), "utf8").then(
          () => true,
          () => false,
        );
        if (!decided) proposals.push(p);
      }
      proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const vDir = join(dataDir(), "versions", film.id, section.id);
      const versions = (
        await Promise.all((await listJsonFiles(vDir)).map((n) => readJson<VersionRecord>(join(vDir, n)).catch(() => null)))
      )
        .filter((v): v is VersionRecord => !!v)
        .sort((a, b) => b.version - a.version);
      const top = proposals[0];
      let proposal: RenderProposal | null = null;
      if (top) {
        const { sessionHash: _s, ...rest } = top;
        proposal = rest;
      }
      return {
        proposal,
        versions,
        ambiguous: process.env.AMBIGUOUS_API_KEY?.trim() ? "configured" : "unconfigured",
      };
    },
  };
}

export const approvals = createApprovals();
