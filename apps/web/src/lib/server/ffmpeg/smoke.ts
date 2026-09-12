/**
 * Manual smoke run (NOT a test). Needs the film env inline and a throwaway VETTU_DATA_DIR:
 *   FILM_ROOT=… VETTU_WORK=… VETTU_DATA_DIR=$(mktemp -d) \
 *     node --import tsx src/lib/server/ffmpeg/smoke.ts <clips folder relative to FILM_ROOT> [count]
 * Builds an in-memory film from the first <count> (default 4) MP4s of that folder, seeds the
 * timeline, trims +0.5 s, renders the 540p preview into VETTU_WORK and prints the wall time.
 * Reads the film folder only; writes only to VETTU_DATA_DIR and VETTU_WORK.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Card } from "@/lib/contracts/film";
import { createFilm, newFilmId } from "../film-store";
import { mediaRoots } from "../roots";
import { applyCut, applyTrim, loadTimeline } from "../timeline";

async function main() {
  const rel = process.argv[2];
  const count = Math.min(Number(process.argv[3] ?? 4) || 4, 20);
  const root = mediaRoots().FILM_ROOT;
  if (!rel || !root || !process.env.VETTU_DATA_DIR) {
    console.error("usage: FILM_ROOT=… VETTU_DATA_DIR=… smoke.ts <clips dir> [count]");
    process.exit(2);
  }
  const names = (await readdir(join(root, rel))).filter((n) => n.endsWith(".mp4") && !n.startsWith(".")).sort().slice(0, count);
  const cards: Card[] = names.map((n, i) => ({
    id: `s_smoke/S${i + 1}`,
    section: "s_smoke",
    slot: i + 1,
    kind: "clip",
    media: { root: "FILM_ROOT", p: `${rel}/${n}` },
    poster: null,
    secs: 2,
    in: 0,
    out: null,
    letters: [],
    caption: `smoke ${i + 1}`,
    maker: null,
    status: "cut",
    takes: [],
    reserve: false,
  }));
  const film = await createFilm({
    id: newFilmId(),
    name: "Smoke",
    source: { kind: "new" },
    activeSection: "s_smoke",
    letters: {},
    sections: [
      { id: "s_smoke", code: "§01", name: "SMOKE", order: 1, targetSecs: null, cutSecs: 0, full: false, locked: false, done: 0, total: 0, parked: false, derived: true },
    ],
    cards,
    sounds: [],
    plans: [],
    notes: [],
    world: { cast: [], locations: [], props: [] },
    runningCut: null,
  });
  const seedStart = Date.now();
  const seeded = await loadTimeline(film.id, "s_smoke");
  console.log(`seeded ${seeded.edl.length} entries (probe) in ${Date.now() - seedStart} ms`);
  const t0 = Date.now();
  const result = await applyCut(film.id, "s_smoke", (t) => applyTrim(t, { shot: "S1", delta: 0.5 }));
  const ms = Date.now() - t0;
  console.log(`chip: ${result.chip}`);
  console.log(`preview: ${result.previewUrl ?? "none"} · ${result.timeline.preview?.secs ?? "?"} s of edit`);
  console.log(`wall time (trim + 540p preview): ${ms} ms`);
  const p = result.timeline.preview?.url ? decodeURIComponent(result.timeline.preview.url.split("p=")[1] ?? "") : null;
  if (p) console.log(`output: ${join(mediaRoots().VETTU_WORK ?? "", p)}`);
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
