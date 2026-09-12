import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Film } from "@/lib/contracts/film";
import type { Timeline } from "@/lib/contracts/timeline";
import { createFilm } from "./film-store";
import { createApprovals } from "./render-approvals";
import { listReviewQueue } from "./review-queue";
import { applyTrim, updateTimeline } from "./timeline";

const data = mkdtempSync(join(tmpdir(), "vettu-approvals-"));
process.env.VETTU_DATA_DIR = data;
for (const k of ["FILM_ROOT", "FILM_REPORTS_DIR", "LABS_OUT", "VETTU_WORK", "AMBIGUOUS_API_KEY"]) delete process.env[k];

const session = "a".repeat(64);

async function film(id: string): Promise<Film> {
  return createFilm({
    id,
    name: "Placeholder Film",
    source: { kind: "new" },
    activeSection: "s_one",
    letters: {},
    sections: [
      { id: "s_one", code: "§01", name: "THE ONE", order: 1, targetSecs: null, cutSecs: 0, full: false, locked: false, done: 0, total: 0, parked: false, derived: true },
    ],
    cards: [1, 2].map((slot) => ({
      id: `s_one/S${slot}`, section: "s_one", slot, kind: "clip" as const,
      media: { root: "FILM_ROOT" as const, p: `clips/placeholder_${slot}.mp4` }, poster: null, secs: 3, in: 0, out: null,
      letters: [], caption: "placeholder", maker: null, status: "locked" as const, takes: [], reserve: false,
    })),
    sounds: [],
    plans: [],
    notes: [],
    world: { cast: [], locations: [], props: [] },
    runningCut: null,
  });
}

function fakes() {
  const calls = { render: 0, workplace: 0 };
  const render = async (t: Timeline, version: number) => {
    calls.render++;
    return {
      secs: 6,
      final: { root: "VETTU_WORK" as const, p: `renders/${t.filmId}/${t.section}/v${version}_1080p.mp4` },
      preview: { root: "VETTU_WORK" as const, p: `renders/${t.filmId}/${t.section}/v${version}_540p.mp4` },
      poster: null,
      previewPath: "/placeholder/preview_540p.mp4",
      posterPath: null,
    };
  };
  const workplace = async () => {
    calls.workplace++;
    return undefined; // unconfigured
  };
  return { calls, service: createApprovals({ render, workplace }) };
}

const status = (n: number) => (e: unknown) => (e as { status?: number }).status === n;

test("propose writes only the proposal: no render, no Ambiguous, no version, no outbox", async () => {
  await film("f_prop0001");
  const { calls, service } = fakes();
  const p = await service.propose(session, { filmId: "f_prop0001", section: "§01", summary: "tighter" });
  assert.equal(p.version, 1);
  assert.equal(p.section, "s_one");
  assert.equal(calls.render, 0);
  assert.equal(calls.workplace, 0);
  assert.equal(existsSync(join(data, "versions")), false);
  assert.equal(existsSync(join(data, "outbox")), false);
  assert.ok(readdirSync(join(data, "approvals")).includes(`${p.id}.json`));
  const view = await service.view(session, "f_prop0001", "s_one");
  assert.equal(view.proposal?.id, p.id);
  assert.equal(view.ambiguous, "unconfigured");
});

test("approve renders once, records the version, queues for review; the decision is one-time", async () => {
  await film("f_appr0001");
  const { calls, service } = fakes();
  const p = await service.propose(session, { filmId: "f_appr0001", section: "s_one", summary: "first" });
  await assert.rejects(service.approve("b".repeat(64), p.id), status(403));
  const v = await service.approve(session, p.id);
  assert.equal(calls.render, 1);
  assert.equal(v.version, 1);
  assert.equal(v.ambiguous, "unconfigured");
  assert.equal(v.slack, "queued");
  assert.equal(v.cutId, "f_appr0001:s_one:v1");
  const queue = await listReviewQueue();
  assert.ok(queue.some((q) => q.cutId === "f_appr0001:s_one:v1" && q.title === "PLACEHOLDER FILM · §01 THE ONE · v1"));
  await assert.rejects(service.approve(session, p.id), status(409));
  assert.equal(calls.render, 1);
  await assert.rejects(service.deny(session, p.id), status(409));
});

test("an edit after the proposal → 409 and nothing renders", async () => {
  await film("f_hash0002");
  const { calls, service } = fakes();
  const p = await service.propose(session, { filmId: "f_hash0002", section: "s_one", summary: "x" });
  await updateTimeline("f_hash0002", "s_one", (t) => applyTrim(t, { shot: "S1", delta: 0.5 }));
  await assert.rejects(service.approve(session, p.id), (e: unknown) => status(409)(e) && /propose again/.test(String((e as Error).message)));
  assert.equal(calls.render, 0);
});

test("expired proposals are refused", async () => {
  await film("f_expi0001");
  let clock = Date.now();
  const service = createApprovals({ render: async () => { throw new Error("no"); }, workplace: async () => undefined, now: () => clock });
  const p = await service.propose(session, { filmId: "f_expi0001", section: "s_one", summary: "x" });
  clock += 11 * 60_000;
  await assert.rejects(service.approve(session, p.id), status(410));
});
