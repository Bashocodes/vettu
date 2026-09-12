/**
 * ElevenLabs sound effects (FFMPEG_TOOLS §2.9): POST /v1/sound-generation → mp3,
 * RMS peak measured with astats, one-pass loudnorm to about −20 LUFS into a wav.
 * The caller lays it so the peak lands on the target head. Server only.
 */
import { writeFile } from "node:fs/promises";
import { isWritablePath } from "../roots";
import { GenError, runFfmpeg } from "./ffmpeg";

export const ELEVEN_URL = "https://api.elevenlabs.io/v1/sound-generation";
export const ELEVEN_MODEL = "eleven_text_to_sound_v2";
export const TARGET_LUFS = -20;

export function elevenBody(prompt: string, duration: number): {
  text: string;
  duration_seconds: number;
  model_id: string;
} {
  const d = Math.min(30, Math.max(0.5, Math.round(duration * 10) / 10));
  return { text: prompt.trim(), duration_seconds: d, model_id: ELEVEN_MODEL };
}

export async function requestSound(
  input: { prompt: string; duration: number; outAbs: string },
  deps: { fetch?: typeof fetch; key?: string | null } = {},
): Promise<void> {
  const key = (deps.key === undefined ? process.env.ELEVENLABS_API_KEY : deps.key)?.trim();
  if (!key) throw new GenError("ElevenLabs key not set");
  if (!(await isWritablePath(input.outAbs))) throw new GenError("VETTU may not write there.");
  const f = deps.fetch ?? fetch;
  let bytes: Buffer;
  try {
    const res = await f(ELEVEN_URL, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify(elevenBody(input.prompt, input.duration)),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new GenError(`ElevenLabs refused the sound (HTTP ${res.status}).`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    if (error instanceof GenError) throw error;
    throw new GenError("ElevenLabs could not be reached.");
  }
  if (bytes.byteLength < 200) throw new GenError("ElevenLabs returned an empty sound.");
  await writeFile(input.outAbs, bytes, { mode: 0o600 });
}

/**
 * Parse `ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-` output →
 * the pts_time (seconds) of the loudest frame, or null.
 */
export function parseRmsPeak(text: string): number | null {
  let t: number | null = null;
  let best = -Infinity;
  let bestT: number | null = null;
  for (const line of text.split("\n")) {
    const pts = /pts_time:\s*([0-9.]+)/.exec(line);
    if (pts) {
      t = Number(pts[1]);
      continue;
    }
    const rms = /lavfi\.astats\.Overall\.RMS_level=(-?[0-9.]+|-?inf|nan)/i.exec(line);
    if (rms && t !== null) {
      const v = Number(rms[1]);
      if (Number.isFinite(v) && v > best) {
        best = v;
        bestT = t;
      }
    }
  }
  return bestT;
}

export function peakArgs(inAbs: string): string[] {
  return [
    "-hide_banner", "-v", "error", "-i", inAbs,
    "-af", "aresample=48000,asetnsamples=n=2400,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f", "null", "-",
  ];
}

export async function measurePeak(inAbs: string): Promise<number> {
  const { stdout } = await runFfmpeg(peakArgs(inAbs), 30_000);
  return parseRmsPeak(stdout) ?? 0;
}

export async function normalise(inAbs: string, outAbs: string): Promise<void> {
  if (!(await isWritablePath(outAbs))) throw new GenError("VETTU may not write there.");
  await runFfmpeg(
    [
      "-v", "error", "-y", "-i", inAbs,
      "-af", `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11,aresample=48000`,
      "-ac", "2", "-c:a", "pcm_s16le", outAbs,
    ],
    60_000,
  );
}
