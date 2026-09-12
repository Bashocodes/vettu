"use client";

/**
 * The overlay's live props, shared with the slot components (header, pill) and the chat's
 * tool-call cards. CopilotKit memoises slots and captures tool renderers at first registration,
 * so anything that must stay current is read from here, never from a closure.
 */
import { createContext, useContext } from "react";
import type { VettuOverlayProps } from "@/lib/contracts/overlay";

export const VettuOverlayContext = createContext<VettuOverlayProps | null>(null);

export function useVettuOverlay(): VettuOverlayProps | null {
  return useContext(VettuOverlayContext);
}
