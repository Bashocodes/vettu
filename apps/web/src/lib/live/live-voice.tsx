"use client";

/**
 * STUB from the integrator — the LIVE stream replaces the implementation, keeping
 * `LiveVoiceProvider` and `useLiveVoice()` exports. The provider is mounted ABOVE the popup
 * (providers.tsx) so minimising the overlay never ends a call.
 */
import { createContext, useContext, useMemo } from "react";
import type { LiveVoiceApi } from "@/lib/contracts/overlay";

const unavailable: LiveVoiceApi = {
  state: "unavailable",
  engine: "gpt-live",
  reason: "LIVE · waits for OpenAI",
  muted: false,
  lines: [],
  start: async () => {},
  stop: async () => {},
  setMuted: () => {},
};

const LiveVoiceContext = createContext<LiveVoiceApi>(unavailable);

export function LiveVoiceProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo(() => unavailable, []);
  return <LiveVoiceContext.Provider value={value}>{children}</LiveVoiceContext.Provider>;
}

export function useLiveVoice(): LiveVoiceApi {
  return useContext(LiveVoiceContext);
}
