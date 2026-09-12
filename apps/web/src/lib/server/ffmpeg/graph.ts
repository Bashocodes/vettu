/**
 * Pure FFmpeg argument builder for the edit (FFMPEG_TOOLS §2.6–§2.7). No I/O, no shell:
 * the result is an argument array for spawn(FFMPEG, args). Every input path is its own arg.
 */
import type { MediaSrc } from "@/lib/contracts/film";
import type { Timeline, TransitionType } from "@/lib/contracts/timeline";

const STILL_EXT = /\.(png|jpe?g|webp)$/i;
export function isStillMedia(m: MediaSrc): boolean {
  return STILL_EXT.test("src" in m ? m.src : m.p);
}

/** The media an EDL ref plays: an insert (video, else its still looped) or a shot's clip. */
export function mediaForRef(t: Timeline, ref: string): { media: MediaSrc; still: boolean } | null {
  const insert = t.inserts.find((x) => x.id === ref);
  if (insert) {
    if (insert.video) return { media: insert.video, still: false };
    if (insert.still) return { media: insert.still, still: true };
    return null;
  }
  const shot = t.shots.find((s) => s.id === ref);
  const clip = t.clips.find((c) => c.id === (shot ? shot.clipId : ref));
  return clip ? { media: clip.media, still: isStillMedia(clip.media) } : null;
}

export interface PlanEntry {
  path: string; // absolute, already allowlisted
  in: number;
  dur: number;
  still: boolean; // image → -loop 1 -t d
  transition: { type: TransitionType; dur: number }; // INTO this entry (ignored on 0)
}
export interface PlanWords {
  path: string; // PNG
  start: number;
  end: number;
}
export interface PlanMusic {
  path: string;
  offset: number;
  fadeOutAt: number | null;
}
export interface PlanSound {
  path: string;
  at: number;
  gainDb: number;
}
export interface RenderPlan {
  entries: PlanEntry[];
  words: PlanWords[];
  music: PlanMusic | null;
  sounds: PlanSound[];
}
export type RenderQuality = "preview" | "final" | "final-videotoolbox";

const n3 = (x: number) => String(Math.round(x * 1000) / 1000);

/** Transition duration actually used between entries (cut → 0). */
export function joinDur(e: PlanEntry, index: number): number {
  if (index === 0 || e.transition.type === "cut") return 0;
  return Math.max(0, e.transition.dur);
}

/** Total seconds of the joined picture: Σd − Σt. */
export function planSecs(entries: PlanEntry[]): number {
  let total = 0;
  entries.forEach((e, i) => {
    total += e.dur - joinDur(e, i);
  });
  return Math.round(total * 1000) / 1000;
}

/** xfade offset for entry k (k ≥ 1): Σ(d0..d(k-1)) − Σ(t1..tk). */
export function xfadeOffset(entries: PlanEntry[], k: number): number {
  let sum = 0;
  for (let i = 0; i < k; i++) sum += entries[i].dur;
  for (let i = 1; i <= k; i++) sum -= joinDur(entries[i], i);
  return Math.round(sum * 1000) / 1000;
}

export function buildRenderArgs(
  plan: RenderPlan,
  options: { width: number; height: number; quality: RenderQuality; output: string },
): string[] {
  const { width: W, height: H } = options;
  if (plan.entries.length === 0) throw new Error("empty plan");
  const total = planSecs(plan.entries);
  const args: string[] = ["-hide_banner", "-nostdin", "-v", "error", "-y"];
  const filters: string[] = [];
  let input = 0;

  // ── picture inputs ──
  const entryInputs: number[] = [];
  for (const e of plan.entries) {
    if (e.still) args.push("-loop", "1", "-framerate", "24", "-t", n3(e.dur), "-i", e.path);
    else args.push("-ss", n3(e.in), "-t", n3(e.dur), "-i", e.path);
    entryInputs.push(input++);
  }
  const wordInputs: number[] = [];
  for (const w of plan.words) {
    args.push("-loop", "1", "-framerate", "24", "-t", n3(Math.max(w.end, total)), "-i", w.path);
    wordInputs.push(input++);
  }
  let musicInput: number | null = null;
  if (plan.music) {
    args.push("-ss", n3(plan.music.offset), "-i", plan.music.path);
    musicInput = input++;
  }
  const soundInputs: number[] = [];
  for (const s of plan.sounds) {
    args.push("-i", s.path);
    soundInputs.push(input++);
  }
  let silentInput: number | null = null;
  if (musicInput === null && soundInputs.length === 0) {
    args.push("-f", "lavfi", "-t", n3(total), "-i", "anullsrc=r=48000:cl=stereo");
    silentInput = input++;
  }

  // ── per-entry picture chains ──
  plan.entries.forEach((_, i) => {
    filters.push(
      `[${entryInputs[i]}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p,settb=AVTB[v${i}]`,
    );
  });

  // ── joins ──
  let acc: string;
  const allCut = plan.entries.every((e, i) => joinDur(e, i) === 0);
  if (plan.entries.length === 1) {
    acc = "v0";
  } else if (allCut) {
    filters.push(`${plan.entries.map((_, i) => `[v${i}]`).join("")}concat=n=${plan.entries.length}:v=1:a=0[vcat]`);
    acc = "vcat";
  } else {
    acc = "v0";
    for (let k = 1; k < plan.entries.length; k++) {
      const e = plan.entries[k];
      const t = joinDur(e, k);
      const out = `x${k}`;
      if (t === 0) filters.push(`[${acc}][v${k}]concat=n=2:v=1:a=0[${out}]`);
      else
        filters.push(
          `[${acc}][v${k}]xfade=transition=${e.transition.type}:duration=${n3(t)}:offset=${n3(xfadeOffset(plan.entries, k))}[${out}]`,
        );
      acc = out;
    }
  }

  // ── words overlays ──
  plan.words.forEach((w, j) => {
    filters.push(`[${wordInputs[j]}:v]scale=${Math.round(W / 2)}:-1[card${j}]`);
    filters.push(
      `[${acc}][card${j}]overlay=(W-w)/2:H*0.70:enable='between(t,${n3(w.start)},${n3(w.end)})'[vw${j}]`,
    );
    acc = `vw${j}`;
  });
  filters.push(`[${acc}]null[vout]`);

  // ── audio ──
  const parts: string[] = [];
  if (musicInput !== null && plan.music) {
    const fade =
      plan.music.fadeOutAt !== null && plan.music.fadeOutAt < total
        ? `,afade=t=out:st=${n3(plan.music.fadeOutAt)}:d=0.4`
        : "";
    filters.push(`[${musicInput}:a]aresample=48000,aformat=channel_layouts=stereo${fade}[am]`);
    parts.push("am");
  }
  plan.sounds.forEach((s, j) => {
    const ms = Math.max(0, Math.round(s.at * 1000));
    filters.push(
      `[${soundInputs[j]}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${n3(s.gainDb)}dB,adelay=${ms}|${ms}[as${j}]`,
    );
    parts.push(`as${j}`);
  });
  if (silentInput !== null) {
    filters.push(`[${silentInput}:a]aresample=48000,aformat=channel_layouts=stereo[asil]`);
    parts.push("asil");
  }
  const head =
    parts.length === 1
      ? `[${parts[0]}]`
      : `${parts.map((p) => `[${p}]`).join("")}amix=inputs=${parts.length}:duration=longest:normalize=0,`;
  filters.push(`${head}apad=whole_dur=${n3(total)},atrim=end=${n3(total)}[aout]`);

  args.push("-filter_complex", filters.join(";"), "-map", "[vout]", "-map", "[aout]", "-t", n3(total));
  if (options.quality === "preview") {
    args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "28");
  } else if (options.quality === "final") {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20");
  } else {
    args.push("-c:v", "h264_videotoolbox", "-b:v", "8M");
  }
  args.push("-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", options.output);
  return args;
}

/** 1080p → 540p copy for Slack. */
export function downscaleArgs(input: string, output: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-v", "error", "-y", "-i", input,
    "-vf", "scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", output,
  ];
}

/** One PNG poster frame. */
export function posterArgs(input: string, output: string, at: number): string[] {
  return ["-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", n3(at), "-i", input, "-frames:v", "1", "-vf", "scale=960:-2", output];
}

export function probeArgs(path: string): string[] {
  return [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", path,
  ];
}
