import { wordsBody } from "@/lib/contracts/timeline";
import { drawWordsPng } from "@/lib/server/ffmpeg/words";
import { guarded } from "@/lib/server/guard";
import { applyCut, applyWords, loadTimeline } from "@/lib/server/timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = guarded("write", async (g) => {
  const b = await g.json(wordsBody);
  const t = await loadTimeline(b.filmId, b.section);
  applyWords(t, { text: b.text, start: b.start, end: b.end, png: null }); // guards before drawing
  const png = await drawWordsPng(t.filmId, t.section, b.text);
  return g.reply(
    await applyCut(b.filmId, t.section, (cur) => applyWords(cur, { text: b.text, start: b.start, end: b.end, png })),
  );
});
