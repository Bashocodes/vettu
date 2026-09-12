/**
 * Director probe (G2) — NOT a test (needs ANTHROPIC_API_KEY and network). One Claude run that
 * must make ONE tool call (add_sound) against a temp data dir with a one-shot placeholder film.
 * Provider keys (Kling, ElevenLabs) are removed first, so no credits are spent: the queued job
 * fails fast with "key not set" but its job file exists. The integrator runs:
 *
 *   cd apps/web && node --env-file=../../.env --import tsx src/lib/server/director/probe.ts
 *
 * Prints `G2 PASS · tool=<name> · job=<path>` or `G2 FAIL · <reason>`. Never prints a key.
 */
import { mkdtempSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function main(): Promise<number> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    console.log("G2 FAIL · ANTHROPIC_API_KEY is not set");
    return 1;
  }
  const base = mkdtempSync(join(tmpdir(), "vettu-g2-"));
  process.env.VETTU_DATA_DIR = base;
  process.env.VETTU_WORK = join(base, "work");
  delete process.env.KLING_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;

  // Imported after the env is set (roots.ts reads it at call time; this keeps it obvious).
  const { createFilm, newFilmId } = await import("../film-store");
  const { dataDir } = await import("../roots");
  const { openTimeline } = await import("../gen/bridge");
  const { startGeneratorJob } = await import("../gen/start");
  const { directorModelId, directorTools, runClaudeDirector, directorFailure } = await import("./claude");

  try {
    const film = await createFilm({
      id: newFilmId(),
      name: "PROBE",
      source: { kind: "new" },
      activeSection: "s01",
      targetSecs: null,
      letters: {},
      sections: [
        { id: "s01", code: "§01", name: "THE PROBE", order: 1, targetSecs: null, cutSecs: 4, full: false, locked: false, done: 1, total: 1, parked: false, derived: true },
      ],
      cards: [
        {
          id: "s01/S1",
          section: "s01",
          slot: 1,
          kind: "clip",
          media: { root: "VETTU_WORK", p: "probe/placeholder.mp4" },
          poster: null,
          secs: 4,
          in: 0,
          out: 4,
          letters: [],
          caption: "placeholder shot: a door in a quiet hall",
          maker: null,
          status: "cut",
          takes: [],
          reserve: false,
        },
      ],
      sounds: [],
      plans: [],
      notes: [],
      world: { cast: [], locations: [], props: [] },
      runningCut: null,
    });
    const tl = await openTimeline(film.id, "s01");
    if (tl.edl.length === 0) {
      console.log("G2 FAIL · the probe film seeded an empty edit");
      return 1;
    }
    const queued: Array<{ tool: string; jobId: string }> = [];
    const tools = directorTools({
      target: { filmId: film.id, section: tl.section },
      timeline: () => tl,
      startJob: startGeneratorJob,
      onQueued: (q) => void queued.push(q),
      maxJobs: 1,
    });
    const out = await runClaudeDirector({
      apiKey: key,
      model: directorModelId(),
      brief: "Lay one close, clear, crisp door-latch click on S1 (1 second). Use add_sound once.",
      timeline: tl,
      tools,
      toolChoice: { type: "tool", toolName: "add_sound" },
      maxSteps: 1,
    });
    const first = queued[0];
    if (!first) {
      console.log(`G2 FAIL · no job was queued (tools called: ${out.toolNames.join(", ") || "none"})`);
      return 1;
    }
    const jobPath = join(dataDir(), "jobs", `${first.jobId}.json`);
    try {
      await access(jobPath);
    } catch {
      console.log(`G2 FAIL · tool=${first.tool} but no job file at ${jobPath}`);
      return 1;
    }
    console.log(`G2 PASS · tool=${first.tool} · job=${jobPath}`);
    return 0;
  } catch (error) {
    console.log(`G2 FAIL · ${directorFailure(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
