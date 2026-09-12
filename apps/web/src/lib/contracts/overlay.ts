/** Seams between the board page (W1), the overlay chat (W3) and LIVE voice. Browser-safe. */
import type { BoardView } from "./board-view";
import type { Timeline } from "./timeline";

/** Props the board page passes to <VettuOverlay/> (components/overlay/vettu-overlay.tsx). */
export interface VettuOverlayProps {
  filmId: string | null;
  board: BoardView | null;
  timeline: Timeline | null; // the active section's timeline (null until loaded)
  activeSection: string | null; // section id
  selectSection(sectionId: string): void;
  /** Re-fetch board + timeline now (after any tool changed the store or the edit). */
  refresh(): Promise<void>;
}

export type LiveState = "unavailable" | "off" | "connecting" | "listening" | "speaking" | "error";
export type LiveEngine = "elevenlabs" | "gpt-live" | "realtime";

export interface LiveLine {
  id: string; // stable display id — rows are never re-sorted
  who: "you" | "vettu" | "status";
  text: string;
}

/** useLiveVoice() from lib/live/live-voice.tsx — the provider sits ABOVE the popup. */
export interface LiveVoiceApi {
  state: LiveState;
  engine: LiveEngine;
  reason: string | null; // why it is unavailable / the controlled error message
  muted: boolean;
  lines: LiveLine[];
  start(): Promise<void>;
  stop(): Promise<void>;
  setMuted(muted: boolean): void;
}
