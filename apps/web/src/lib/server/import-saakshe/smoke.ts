/**
 * NOT a test. Imports SAAKSHE from the film env into VETTU_DATA_DIR and prints the acceptance line,
 * the §04 card count, three resolved media paths, a WORLD summary and the board legend's rows. Run from apps/web with the
 * film env inline and VETTU_DATA_DIR=$(mktemp -d). Writes only into VETTU_DATA_DIR.
 */
import { resolveMedia } from "../roots";
import { buildBoardView } from "../views/board-view";
import { buildWorldView } from "../views/world-view";
import { importSaakshe } from "./import";

async function main() {
  const { film, created } = await importSaakshe();
  const view = buildBoardView(film, { importAvailable: true });
  const s04 = view.sections.find((s) => s.code === "§04");
  const st = view.stats;
  console.log(
    `${view.sections.map((s) => `${s.code} ${s.name}`).join("|")} ${st.plan.text} ${st.master.text} ${st.pct.text} ${st.clips.text} ${s04?.range.text ?? "?"}`,
  );
  console.log(
    `§04 cards ${s04?.cards.length ?? 0} · reserve ${s04?.reserve.length ?? 0} · ${s04?.durText} · ${st.toCreate.text} · ${st.secsLeft.text} · active ${view.active} · created ${created} · film ${film.id} rev ${film.rev} · importRev ${film.source.importRev}`,
  );
  for (const s of view.sections) {
    console.log(`  ${s.code} ${s.range.text} ${s.durText} chip ${s.chipSecs} · ${s.done}/${s.total} · cards ${s.cards.length} · reserve ${s.reserve.length} · tabs ${s.tabs.join(" · ")}`);
  }
  const grid = film.cards.filter((c) => c.section === s04?.id && !c.reserve);
  for (const ref of [grid[0]?.media, grid[0]?.poster, film.runningCut?.media]) {
    console.log(ref ? ((await resolveMedia(ref)) ?? "UNRESOLVED") : "none");
  }
  console.log(`running cut ${JSON.stringify(view.runningCut)}`);
  const world = buildWorldView(film);
  for (const family of [world.cast, world.locations, world.props]) {
    console.log(
      family
        .map((m) => `${m.code} ${m.filled}/${m.total} [${m.tabs.map((t) => `${t.label || "·"} ${t.filled}/${t.total}`).join(", ")}]`)
        .join(" | "),
    );
  }
  // The board legend's rows, grouped exactly as the legend groups them (in use vs reserved, by kind).
  const letters = Object.entries(view.letters);
  type Entry = (typeof letters)[number];
  const inUse = ([, l]: Entry) => l.inUse !== false && l.kind !== "spare-maker";
  const codes = (keep: (e: Entry) => boolean) => letters.filter(keep).map(([code]) => code).join(" ");
  console.log(
    `legend THINGS ${codes((e) => inUse(e) && (e[1].kind ?? "thing") === "thing")} · THE CAST ${codes((e) => inUse(e) && e[1].kind === "who")} · MAKERS ${codes((e) => inUse(e) && e[1].kind === "maker")} · RESERVED ${codes((e) => !inUse(e))}`,
  );
}

main().catch((error) => {
  console.error("smoke failed:", error instanceof Error ? `${error.name} ${error.message}` : String(error));
  process.exit(1);
});
