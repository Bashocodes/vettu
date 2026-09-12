/**
 * The Director's server queue: when Claude can't run (no key, any API error), queue ONE
 * add_sound job on the first shot the brief names (else the first entry). Pure. Server + tests.
 */
import type { EdlEntry } from "@/lib/contracts/timeline";

export const MAX_DIRECTOR_JOBS = 3;
export const FALLBACK_SOUND_SECS = 3;
const SOUND_PROMPT_MAX = 450; // jobCreateBody.sound caps prompt at 450

export interface FallbackSound {
  kind: "sound";
  target: string;
  prompt: string;
  duration: number;
}

/** "S3" / "shot 3" / "e4" / "after S3" inside the brief → the ref, else undefined. */
export function shotRefIn(brief: string): string | undefined {
  const m = /\b(?:shot\s+(\d{1,2})|(S\d{1,2})|(e\d{1,2}))\b/i.exec(brief);
  if (!m) return undefined;
  if (m[1]) return m[1];
  if (m[2]) return `S${m[2].slice(1)}`;
  return m[3]!.toLowerCase();
}

/** A short sound prompt from the brief: one line, the mic-and-detail tail, ≤450 chars. */
export function soundPrompt(brief: string): string {
  const base = brief.replace(/\s+/g, " ").trim();
  const text = `${base || "room tone"} · close · clear · crisp`;
  return text.length > SOUND_PROMPT_MAX ? `${text.slice(0, SOUND_PROMPT_MAX - 1)}…` : text;
}

export function planFallback(brief: string, edl: Pick<EdlEntry, "id" | "ref">[]): FallbackSound | null {
  if (edl.length === 0) return null;
  const named = shotRefIn(brief);
  const known =
    named && edl.some((e) => e.id === named || e.ref === named || (/^\d+$/.test(named) && e.ref === `S${named}`));
  return {
    kind: "sound",
    target: known ? named! : edl[0]!.id,
    prompt: soundPrompt(brief),
    duration: FALLBACK_SOUND_SECS,
  };
}
