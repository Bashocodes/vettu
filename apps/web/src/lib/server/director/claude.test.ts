import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Job, JobCreateBody } from "@/lib/contracts/jobs";
import type { Timeline } from "@/lib/contracts/timeline";
import { HttpError } from "../guard";
import { checkAnimateBody } from "../gen/animate";
import {
  DEFAULT_DIRECTOR_MODEL,
  directorFailure,
  directorModelId,
  directorPrompt,
  directorTools,
  type QueuedJob,
} from "./claude";

const fixture = (): Timeline =>
  JSON.parse(readFileSync(new URL("../../contracts/fixtures/timeline.json", import.meta.url), "utf8")) as Timeline;

const target = { filmId: "f_fixture01", section: "s04" };
const options = { toolCallId: "call_1", messages: [] };

function fakeJob(body: JobCreateBody, n: number): Job {
  return {
    id: `job_${String(n).padStart(8, "0")}`,
    filmId: body.filmId,
    section: body.section,
    kind: body.kind,
    status: "running",
    title: `${body.kind} · placeholder`,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    progress: null,
    insertId: body.kind === "animate" ? "ins_aaaaaa" : null,
    result: null,
    error: null,
  };
}

type Exec = (input: unknown, opts: typeof options) => Promise<unknown>;
const exec = (tools: ReturnType<typeof directorTools>, name: string) => tools[name]!.execute as unknown as Exec;

test("model id: MODEL env with the anthropic prefix stripped; default claude-opus-5", () => {
  assert.equal(directorModelId(undefined), DEFAULT_DIRECTOR_MODEL);
  assert.equal(directorModelId(""), "claude-opus-5");
  assert.equal(directorModelId("anthropic:claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(directorModelId("anthropic/claude-opus-5"), "claude-opus-5");
  assert.equal(directorModelId("claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(directorModelId("openai:placeholder-model"), "claude-opus-5", "a non-Claude id never reaches Anthropic");
});

test("the prompt carries the brief and the section's entries", () => {
  const p = directorPrompt("placeholder brief", fixture());
  assert.match(p, /^Brief: placeholder brief/);
  assert.match(p, /e3 · S3 · 0\.00–5\.04 s · placeholder shot 3/);
});

test("tools: list_shots · animate_insert · add_sound; no draw", () => {
  const tools = directorTools({ target, timeline: fixture, startJob: async (b) => fakeJob(b, 1) });
  assert.deepEqual(Object.keys(tools).sort(), ["add_sound", "animate_insert", "list_shots"]);
});

test("execute returns { jobId, status } without waiting for the provider", async () => {
  const bodies: JobCreateBody[] = [];
  const queued: QueuedJob[] = [];
  let providerFinished = false;
  const startJob = async (body: JobCreateBody) => {
    bodies.push(body);
    // the slow provider keeps running in the background and never resolves in this test
    void new Promise<void>(() => {}).then(() => {
      providerFinished = true;
    });
    return fakeJob(body, bodies.length);
  };
  const tools = directorTools({ target, timeline: fixture, startJob, onQueued: (q) => void queued.push(q) });

  const started = Date.now();
  const sound = (await exec(tools, "add_sound")({ target: "S3", prompt: "close · clear · crisp latch", duration: 1 }, options)) as {
    jobId: string;
    status: string;
  };
  assert.equal(sound.jobId, "job_00000001");
  assert.equal(sound.status, "running");
  assert.equal(providerFinished, false);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(bodies[0], { kind: "sound", ...target, target: "S3", prompt: "close · clear · crisp latch", duration: 1 });

  const anim = (await exec(tools, "animate_insert")({ fromShot: "S3", prompt: "a hand lifts the lantern" }, options)) as {
    jobId: string;
    insertId: string;
  };
  assert.equal(anim.jobId, "job_00000002");
  assert.equal(anim.insertId, "ins_aaaaaa");
  const animateBody = bodies[1]!;
  assert.equal(animateBody.kind, "animate");
  assert.equal(animateBody.section, "s04", "the section is pinned by the server");
  assert.equal(animateBody.kind === "animate" ? animateBody.secs : null, 5, "secs defaults to 5");
  assert.deepEqual(
    queued.map((q) => q.tool),
    ["add_sound", "animate_insert"],
  );
});

test("execute never throws: a refused job comes back as { error }", async () => {
  const tools = directorTools({
    target,
    timeline: fixture,
    startJob: async (body) => {
      if (body.kind === "animate") checkAnimateBody(body);
      throw new HttpError(404, "No shot S99 in this section's edit.");
    },
  });
  const noShot = (await exec(tools, "animate_insert")({ prompt: "placeholder" }, options)) as { error: string };
  assert.match(noShot.error, /fromShot/);
  const missing = (await exec(tools, "add_sound")({ target: "S99", prompt: "placeholder words", duration: 1 }, options)) as {
    error: string;
  };
  assert.equal(missing.error, "No shot S99 in this section's edit.");
  const invalid = (await exec(tools, "add_sound")({ target: "S1", prompt: "x", duration: 1 }, options)) as { error: string };
  assert.match(invalid.error, /^Invalid arguments/);
});

test("at most 3 jobs per Director run; list_shots is read-only", async () => {
  let n = 0;
  const tools = directorTools({ target, timeline: fixture, startJob: async (b) => fakeJob(b, ++n) });
  const add = exec(tools, "add_sound");
  for (let i = 0; i < 3; i++) {
    const r = (await add({ target: "S1", prompt: "placeholder words", duration: 1 }, options)) as { jobId?: string };
    assert.ok(r.jobId);
  }
  const fourth = (await add({ target: "S1", prompt: "placeholder words", duration: 1 }, options)) as { error: string };
  assert.match(fourth.error, /at most 3/);
  assert.equal(n, 3);
  const shots = (await exec(tools, "list_shots")({}, options)) as { shots: Array<{ entry: string; ref: string }> };
  assert.equal(shots.shots.length, 13);
  assert.deepEqual({ entry: shots.shots[0]!.entry, ref: shots.shots[0]!.ref }, { entry: "e1", ref: "S1" });
});

test("failures are controlled words, never provider text", () => {
  assert.equal(directorFailure({ statusCode: 401, message: "secret provider text" }), "Claude API error HTTP 401");
  assert.equal(directorFailure(new Error("secret provider text")), "Claude could not run");
});
