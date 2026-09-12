/**
 * The push-in placeholder (FFMPEG_TOOLS §2.8 step 3): a slow zoom on a still,
 * 1920×1080 @ 24 fps, `secs` long. Server only.
 */
import { isWritablePath } from "../roots";
import { GenError, runFfmpeg } from "./ffmpeg";

export function pushInArgs(stillAbs: string, outAbs: string, secs: number): string[] {
  const frames = Math.max(24, Math.round(24 * secs));
  const vf =
    "scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160," +
    `zoompan=z='min(zoom+0.0012,1.12)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=24,` +
    "format=yuv420p";
  return [
    "-v", "error", "-y",
    "-loop", "1", "-i", stillAbs,
    "-vf", vf,
    "-frames:v", String(frames),
    "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-movflags", "+faststart",
    outAbs,
  ];
}

export async function pushIn(stillAbs: string, outAbs: string, secs: number): Promise<void> {
  if (!(await isWritablePath(outAbs))) throw new GenError("VETTU may not write there.");
  await runFfmpeg(pushInArgs(stillAbs, outAbs, secs), 60_000);
}
