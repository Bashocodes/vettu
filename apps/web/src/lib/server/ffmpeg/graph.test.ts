import assert from "node:assert/strict";
import test from "node:test";
import { buildRenderArgs, planSecs, xfadeOffset, type PlanEntry, type RenderPlan } from "./graph";

const entry = (path: string, dur: number, type: "cut" | "fade" | "slideleft" = "cut", t = 0): PlanEntry => ({
  path,
  in: 0.5,
  dur,
  still: false,
  transition: { type, dur: t },
});

test("all hard cuts join with one concat, silent audio from anullsrc", () => {
  const plan: RenderPlan = { entries: [entry("/w/a b.mp4", 3), entry("/w/c.mp4", 4)], words: [], music: null, sounds: [] };
  const args = buildRenderArgs(plan, { width: 960, height: 540, quality: "preview", output: "/w/out.mp4" });
  assert.ok(Array.isArray(args) && args.every((a) => typeof a === "string"));
  assert.ok(args.includes("/w/a b.mp4")); // a path with a space stays one argument
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /\[v0\]\[v1\]concat=n=2:v=1:a=0\[vcat\]/);
  assert.doesNotMatch(graph, /xfade/);
  assert.ok(args.includes("anullsrc=r=48000:cl=stereo"));
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 6), ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"]);
  assert.equal(args.at(-1), "/w/out.mp4");
  assert.ok(graph.includes("scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p,settb=AVTB"));
});

test("xfade offsets are Σ(d0..d(k-1)) − Σ(t1..tk)", () => {
  const entries = [entry("/a.mp4", 3), entry("/b.mp4", 4, "fade", 0.5), entry("/c.mp4", 5, "slideleft", 1)];
  assert.equal(xfadeOffset(entries, 1), 2.5);
  assert.equal(xfadeOffset(entries, 2), 5.5);
  assert.equal(planSecs(entries), 10.5);
  const args = buildRenderArgs({ entries, words: [], music: null, sounds: [] }, { width: 1920, height: 1080, quality: "final", output: "/o.mp4" });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /xfade=transition=fade:duration=0\.5:offset=2\.5\[x1\]/);
  assert.match(graph, /xfade=transition=slideleft:duration=1:offset=5\.5\[x2\]/);
  assert.ok(args.includes("veryfast") && args.includes("20"));
});

test("words, music, sounds and a still insert become inputs and filters", () => {
  const plan: RenderPlan = {
    entries: [entry("/a.mp4", 3), { ...entry("/still.png", 2), still: true }],
    words: [{ path: "/w.png", start: 1, end: 2.5 }],
    music: { path: "/m.mp3", offset: 13.041667, fadeOutAt: 4 },
    sounds: [{ path: "/s.mp3", at: 1.5, gainDb: -8 }],
  };
  const args = buildRenderArgs(plan, { width: 960, height: 540, quality: "preview", output: "/o.mp4" });
  const graph = args[args.indexOf("-filter_complex") + 1];
  const i = args.indexOf("/still.png");
  assert.deepEqual(args.slice(i - 7, i), ["-loop", "1", "-framerate", "24", "-t", "2", "-i"]);
  assert.deepEqual(args.slice(args.indexOf("/m.mp3") - 3, args.indexOf("/m.mp3")), ["-ss", "13.042", "-i"]);
  assert.match(graph, /overlay=\(W-w\)\/2:H\*0\.70:enable='between\(t,1,2\.5\)'/);
  assert.match(graph, /afade=t=out:st=4:d=0\.4/);
  assert.match(graph, /volume=-8dB,adelay=1500\|1500/);
  assert.match(graph, /amix=inputs=2:duration=longest:normalize=0/);
  assert.ok(!args.includes("anullsrc=r=48000:cl=stereo"));
});
