"use client";

/**
 * VETTU overlay chat — CopilotKit v2 CopilotPopup floating over the film board.
 * Never CopilotSidebar: it writes the body margin and reflows the board. The popup and its pill are
 * position:fixed, so opening, minimising and closing never shift the layout.
 *
 * Slots are memoised on identity by the kit, so the header and pill slots are module constants
 * that read live data from context (VettuOverlayContext, useLiveVoice), never from closures.
 * The LIVE session lives in LiveVoiceProvider ABOVE the popup: minimising never ends a call.
 */
import "@/styles/vettu-overlay.css";
import { useEffect, useLayoutEffect, useMemo, useRef, type FC, type SVGProps } from "react";
import {
  CopilotPopup,
  useConfigureSuggestions,
  useCopilotChatConfiguration,
  type CopilotChatLabels,
  type CopilotModalHeaderProps,
} from "@copilotkit/react-core/v2";
import type { LiveLine, LiveState, LiveVoiceApi, VettuOverlayProps } from "@/lib/contracts/overlay";
import { useLiveVoice } from "@/lib/live/live-voice";
import { VettuControl } from "@/components/vettu-control";
import { VettuUI } from "@/components/vettu-ui";
import { isNearBottom, isTypingTarget, liveRowText } from "@/lib/tool-run";
import { VettuOverlayContext, useVettuOverlay } from "./overlay-context";

export type { VettuOverlayProps } from "@/lib/contracts/overlay";

const LABELS: Partial<CopilotChatLabels> = {
  modalHeaderTitle: "VETTU",
  welcomeMessageText: "Say the cut.",
  chatInputPlaceholder: "Say the cut…",
  chatToggleOpenLabel: "Open VETTU",
  chatToggleCloseLabel: "Minimise VETTU",
};

const SUGGESTIONS = {
  suggestions: [
    { title: "Hold S3 of §04 half a second longer", message: "Hold S3 of §04 half a second longer" },
    { title: "Rename §02 to THE BRIDGE", message: "Rename §02 to THE BRIDGE" },
    { title: "Render a preview", message: "Render a preview" },
  ],
  available: "before-first-message" as const,
};

/** Clears the film bar at the top (KIT_OVERLAY T2). */
const POPUP_HEIGHT = "min(640px, calc(100dvh - 190px))";

const isStreaming = (state: LiveState) => state === "listening" || state === "speaking";
const isLiveOn = (state: LiveState) => state === "connecting" || isStreaming(state);

export function liveReasonText(reason: string | null): string {
  if (!reason) return "LIVE · unavailable";
  return /^LIVE\b/i.test(reason) ? reason : `LIVE · ${reason}`;
}

// ── LIVE button + strip ──────────────────────────────────────────────────────

function MicGlyph() {
  return (
    <svg className="vettu-glyph" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" fill="currentColor" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5V15" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function LevelBars() {
  return (
    <span className="vettu-bars" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function LiveButton({ live }: { live: LiveVoiceApi }) {
  const { state } = live;
  if (state === "unavailable") {
    const text = liveReasonText(live.reason);
    return (
      <button type="button" className="vettu-live" data-state="unavailable" disabled title={text}>
        {text}
      </button>
    );
  }
  const on = isStreaming(state);
  const label = state === "connecting" ? "LIVE …" : state === "error" ? "LIVE !" : "LIVE";
  const title =
    state === "error"
      ? (live.reason ?? "LIVE stopped. Click to start a new session.")
      : state === "connecting"
        ? "Connecting…"
        : on
          ? "End LIVE"
          : "Start LIVE voice";
  const toggle = () => {
    void (on ? live.stop() : live.start()).catch(() => undefined);
  };
  return (
    <span className="vettu-live-group">
      {on ? (
        <button
          type="button"
          className="vettu-mute"
          aria-pressed={live.muted}
          title={live.muted ? "Unmute the mic" : "Mute the mic"}
          onClick={() => live.setMuted(!live.muted)}
        >
          {live.muted ? "MUTED" : "MIC"}
        </button>
      ) : null}
      <button
        type="button"
        className="vettu-live"
        data-state={state}
        aria-pressed={on}
        aria-label={`${label}: ${title}`}
        disabled={state === "connecting"}
        title={title}
        onClick={toggle}
      >
        {on ? <MicGlyph /> : null}
        {state === "speaking" ? <LevelBars /> : null}
        <span>{label}</span>
      </button>
    </span>
  );
}

const WHO: Record<LiveLine["who"], string> = { you: "YOU", vettu: "VETTU", status: "·" };

function LiveStrip({ live }: { live: LiveVoiceApi }) {
  const rows = live.lines.slice(-5);
  const boxRef = useRef<HTMLDivElement>(null);
  // Stick to the newest words only while the reader sits at the bottom of the (capped) strip.
  const stickRef = useRef(true);
  const growth = rows.map((line) => `${line.id}:${line.text.length}`).join("|");
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [growth, live.state, live.reason]);
  const idle =
    live.state === "connecting"
      ? "Connecting…"
      : live.state === "speaking"
        ? "VETTU is speaking…"
        : live.state === "listening"
          ? "Listening — say the cut."
          : null;
  return (
    <div
      ref={boxRef}
      className="vettu-strip"
      role="log"
      aria-live="polite"
      aria-label="LIVE transcript"
      onScroll={(event) => {
        stickRef.current = isNearBottom(event.currentTarget);
      }}
    >
      {rows.map((line) => {
        const shown = liveRowText(line.text);
        return (
          <div key={line.id} className="vettu-line" data-who={line.who}>
            <span className="vettu-who">{WHO[line.who]}</span>
            <span className="vettu-said" title={shown.clipped ? line.text : undefined}>
              {shown.text}
            </span>
          </div>
        );
      })}
      {!rows.length && idle ? (
        <div className="vettu-line" data-who="status">
          <span className="vettu-who">·</span>
          <span className="vettu-said">{idle}</span>
        </div>
      ) : null}
      {live.state === "error" && live.reason ? (
        <div className="vettu-line" data-who="error" role="alert">
          <span className="vettu-who">LIVE</span>
          <span className="vettu-said">{live.reason}</span>
        </div>
      ) : null}
    </div>
  );
}

// ── header slot ──────────────────────────────────────────────────────────────

export function VettuOverlayHeader() {
  const overlay = useVettuOverlay();
  const config = useCopilotChatConfiguration();
  const live = useLiveVoice();
  const board = overlay?.board ?? null;
  const active =
    board && overlay?.activeSection ? (board.sections.find((s) => s.id === overlay.activeSection) ?? null) : null;
  const where = board ? `${board.film}${active ? ` · ${active.code} ${active.name}` : ""}` : "No film open";
  const showStrip = isLiveOn(live.state) || (live.state === "error" && !!live.reason);
  return (
    <>
      <header className="copilotKitHeader vettu-head" data-vettu="overlay">
        <span className="vettu-mark">VETTU</span>
        <span className="vettu-where" title={where}>
          {board ? <span className="vettu-film">{board.film}</span> : <span className="vettu-dim">No film open</span>}
          {active ? (
            <>
              <span className="vettu-code">{active.code}</span>
              <span className="vettu-sname">{active.name}</span>
            </>
          ) : null}
        </span>
        <LiveButton live={live} />
        <button
          type="button"
          className="vettu-min"
          aria-label="Minimise VETTU"
          title="Minimise (Esc)"
          onClick={() => config?.setModalOpen(false)}
        >
          <span aria-hidden="true">–</span>
        </button>
      </header>
      {showStrip ? <LiveStrip live={live} /> : null}
    </>
  );
}

const HEADER_SLOT: Partial<CopilotModalHeaderProps> = {
  children: () => <VettuOverlayHeader />,
};

// ── pill (toggle slot) ───────────────────────────────────────────────────────

const PillOpenFace: FC<SVGProps<SVGSVGElement>> = () => {
  const live = useLiveVoice();
  return (
    <span className="vettu-pill-face">
      <span className="vettu-pill-mark">VETTU</span>
      <span className="vettu-pill-dot" data-live={isStreaming(live.state) ? "on" : "off"} data-state={live.state}>
        <span className="vettu-pill-led" />
      </span>
    </span>
  );
};

const PillCloseFace: FC<SVGProps<SVGSVGElement>> = () => {
  const live = useLiveVoice();
  return (
    <span className="vettu-pill-face">
      <span className="vettu-pill-mark">VETTU</span>
      <span className="vettu-pill-dot" data-live={isStreaming(live.state) ? "on" : "off"} data-open="true">
        <span className="vettu-pill-min">–</span>
      </span>
    </span>
  );
};

/** Props for the kit's own toggle (keeps data-slot="chat-toggle-button", data-state, aria-pressed). */
const TOGGLE_SLOT = {
  className: "vettu-pill",
  "data-vettu": "pill",
  openIcon: PillOpenFace,
  closeIcon: PillCloseFace,
};

// ── the overlay ──────────────────────────────────────────────────────────────

export function VettuOverlay(props: VettuOverlayProps) {
  const { filmId, board, timeline, activeSection, selectSection, refresh } = props;
  const value = useMemo<VettuOverlayProps>(
    () => ({ filmId, board, timeline, activeSection, selectSection, refresh }),
    [filmId, board, timeline, activeSection, selectSection, refresh],
  );

  useConfigureSuggestions(SUGGESTIONS, []);

  // `c` toggles the chat — never while typing in a field (Esc already closes the popup).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "c" || event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
      const toggle = document.querySelector<HTMLButtonElement>('[data-slot="chat-toggle-button"]');
      if (!toggle) return;
      event.preventDefault();
      toggle.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <VettuOverlayContext.Provider value={value}>
      <VettuControl {...value} />
      <VettuUI {...value} />
      <CopilotPopup
        defaultOpen={false}
        clickOutsideToClose={false}
        header={HEADER_SLOT}
        toggleButton={TOGGLE_SLOT}
        width={440}
        height={POPUP_HEIGHT}
        labels={LABELS}
      />
    </VettuOverlayContext.Provider>
  );
}
