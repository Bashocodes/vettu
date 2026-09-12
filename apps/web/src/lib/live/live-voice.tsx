"use client";

/**
 * LIVE voice — ElevenLabs Agents over WebRTC.
 *
 * The agent itself (LLM, prompt, voice, the client-tool declarations with "Wait for response") is set
 * up in the ElevenLabs dashboard. VETTU only mints a token (GET /api/live-token, the key stays on the
 * server) and runs the client tools in this tab.
 *
 * Mounted by providers.tsx INSIDE CopilotKitProvider and ABOVE the popup, so minimising the overlay
 * never ends a call. Exports `LiveVoiceProvider` and `useLiveVoice()` (typed by contracts/overlay.ts).
 *
 * Spoken edit = typed edit: each voice tool validates with VETTU_TOOLS, then runs through
 * copilotkit.runTool — the typed chat's own handler, the same /api/cut routes, the call lands in the
 * typed thread — and answers the agent with one short sentence. Calls run one at a time, in order.
 *
 * No key or no agent: state "unavailable" with a controlled reason — never a throw.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useCopilotKit } from "@copilotkit/react-core/v2";
import {
  ConversationProvider,
  useConversationClientTool,
  useConversationControls,
  useConversationInput,
  useConversationMode,
  type HookCallbacks,
} from "@elevenlabs/react";
import { api, ApiError, request } from "@/lib/api-client";
import type { LiveLine, LiveVoiceApi } from "@/lib/contracts/overlay";
import {
  CONTEXT_DEBOUNCE_MS,
  IDLE_END_MS,
  LIVE_CHECK_FAILED,
  LIVE_CHECKING,
  LIVE_IDLE_ENDED,
  LIVE_NEEDS_AGENT,
  LIVE_START_FAILED,
  LIVE_TOKEN_FAILED,
  NO_FILM_CONTEXT,
  TOOL_NOT_READY,
  TYPED_ONLY_TOOL_NAMES,
  VOICE_TOOL_NAMES,
  boardContextText,
  checkToolArgs,
  clearLines,
  createLines,
  disconnectOutcome,
  filmIdFrom,
  liveStateOf,
  midCallErrorLine,
  parseAvailability,
  pushLine,
  spokenResult,
  startFailureReason,
  toolLine,
  toolOutcome,
  typedOnlyOutcome,
  unknownToolLine,
  type SessionPhase,
  type ToolOutcome,
} from "./voice";

const IDLE_CHECK_MS = 15_000;
const START_TIMEOUT_MS = 20_000;

type LiveCallbacks = Pick<
  HookCallbacks,
  | "onConnect"
  | "onDisconnect"
  | "onError"
  | "onMessage"
  | "onModeChange"
  | "onStatusChange"
  | "onUnhandledClientToolCall"
>;
type ToolRunner = (name: string, parameters: unknown) => Promise<string>;

const outside: LiveVoiceApi = {
  state: "unavailable",
  engine: "elevenlabs",
  reason: "LIVE · unavailable",
  muted: false,
  lines: [],
  start: async () => {},
  stop: async () => {},
  setMuted: () => {},
};

const LiveVoiceContext = createContext<LiveVoiceApi>(outside);

/** One registered client tool. A component per tool keeps the hook call count fixed. */
function VoiceTool({ name, run }: { name: string; run: ToolRunner }) {
  useConversationClientTool(name, (parameters: Record<string, unknown>) => run(name, parameters));
  return null;
}

function LiveController({ bus, children }: { bus: RefObject<LiveCallbacks>; children: ReactNode }) {
  const { copilotkit } = useCopilotKit();
  const copilotRef = useRef(copilotkit);
  useEffect(() => {
    copilotRef.current = copilotkit;
  }, [copilotkit]);

  const { startSession, endSession, sendContextualUpdate } = useConversationControls();
  const { isSpeaking } = useConversationMode();
  const { isMuted, setMuted: setSdkMuted } = useConversationInput();
  const setSdkMutedRef = useRef(setSdkMuted);
  useEffect(() => {
    setSdkMutedRef.current = setSdkMuted;
  }, [setSdkMuted]);

  const [available, setAvailable] = useState<boolean | null>(null);
  const availableRef = useRef<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(LIVE_CHECKING);
  const [phase, setPhaseValue] = useState<SessionPhase>("idle");
  const phaseRef = useRef<SessionPhase>("idle");
  const [failed, setFailed] = useState(false);
  const [lines, setLines] = useState<LiveLine[]>([]);
  const linesRef = useRef(createLines("live"));
  const attemptRef = useRef(0);
  const startingRef = useRef(false);
  const lastActivityRef = useRef(0);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const contextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(false);

  const setPhase = useCallback((next: SessionPhase) => {
    phaseRef.current = next;
    setPhaseValue(next);
  }, []);

  const say = useCallback((who: LiveLine["who"], text: string) => {
    const next = pushLine(linesRef.current, who, text);
    if (next === linesRef.current) return;
    linesRef.current = next;
    setLines(next.lines);
  }, []);

  const markAvailable = useCallback((value: boolean, why: string | null) => {
    availableRef.current = value;
    setAvailable(value);
    setReason(why);
  }, []);

  const fail = useCallback(
    (why: string) => {
      startingRef.current = false;
      setPhase("idle");
      setFailed(true);
      setReason(why);
    },
    [setPhase],
  );

  /* ---------- availability (env only, never ElevenLabs) ---------- */

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;
    request<unknown>("/live-token?check=1")
      .then(parseAvailability, (error: unknown) => ({
        available: false,
        reason: error instanceof ApiError && error.message ? error.message : LIVE_CHECK_FAILED,
      }))
      .then((result) => {
        if (cancelled || phaseRef.current !== "idle") return;
        markAvailable(result.available, result.reason);
      });
    return () => {
      cancelled = true;
      aliveRef.current = false;
      if (contextTimerRef.current) clearTimeout(contextTimerRef.current);
      contextTimerRef.current = null;
    };
  }, [markAvailable]);

  /* ---------- silent context: the open film ---------- */

  const sendBoardContext = useCallback(async () => {
    const filmId = typeof window === "undefined" ? null : filmIdFrom(window.location.search);
    let text = NO_FILM_CONTEXT;
    if (filmId) {
      try {
        text = boardContextText(await api.films.board(filmId));
      } catch {
        return; // no context rather than a wrong one
      }
    }
    if (phaseRef.current !== "connected") return;
    try {
      sendContextualUpdate(text);
    } catch {
      // the call ended while the board loaded
    }
  }, [sendContextualUpdate]);

  const scheduleContext = useCallback(() => {
    if (contextTimerRef.current) clearTimeout(contextTimerRef.current);
    contextTimerRef.current = setTimeout(() => {
      contextTimerRef.current = null;
      void sendBoardContext();
    }, CONTEXT_DEBOUNCE_MS);
  }, [sendBoardContext]);

  /* ---------- client tools: one at a time, never a throw ---------- */

  const enqueue = useCallback((task: () => Promise<string>): Promise<string> => {
    const run = queueRef.current.then(task);
    queueRef.current = run.catch(() => undefined);
    return run.catch(() => spokenResult({ ok: false, message: "" }));
  }, []);

  const runVoiceTool = useCallback<ToolRunner>(
    (name, parameters) =>
      enqueue(async () => {
        lastActivityRef.current = Date.now();
        const checked = checkToolArgs(name, parameters);
        let outcome: ToolOutcome;
        if (!checked.ok) {
          outcome = { ok: false, message: checked.message };
        } else {
          try {
            outcome = toolOutcome(
              await copilotRef.current.runTool({ name, parameters: checked.data, followUp: false }),
            );
          } catch {
            outcome = { ok: false, message: TOOL_NOT_READY };
          }
        }
        lastActivityRef.current = Date.now();
        say("status", toolLine(name, outcome));
        if (outcome.ok) scheduleContext();
        return spokenResult(outcome);
      }),
    [enqueue, say, scheduleContext],
  );

  const refuseTool = useCallback<ToolRunner>(
    async (name) => {
      const outcome = typedOnlyOutcome(name);
      say("status", toolLine(name, outcome));
      return spokenResult(outcome);
    },
    [say],
  );

  /* ---------- SDK callbacks (forwarded by LiveVoiceProvider) ---------- */

  useEffect(() => {
    bus.current = {
      onStatusChange: ({ status }) => {
        const current = phaseRef.current;
        if (status === "connecting") {
          if (current === "token") setPhase("connecting");
        } else if (status === "connected") {
          if (current === "token" || current === "connecting") setPhase("connected");
        } else if (current === "connecting" || current === "connected") {
          setPhase("idle"); // disconnecting · disconnected
        }
      },
      onConnect: () => {
        if (phaseRef.current !== "connected") return;
        startingRef.current = false;
        lastActivityRef.current = Date.now();
        setFailed(false);
        setReason(null);
        say("status", "LIVE · connected");
        void sendBoardContext();
      },
      onDisconnect: (details) => {
        startingRef.current = false;
        const outcome = disconnectOutcome(details);
        if (phaseRef.current !== "idle") setPhase("idle");
        say("status", outcome.line);
        if (outcome.failed) {
          setFailed(true);
          setReason(outcome.reason);
        }
      },
      onError: (message, context) => {
        if (startingRef.current && phaseRef.current !== "connected") {
          console.warn("[vettu] live: the call did not start");
          fail(startFailureReason(message, context));
          return;
        }
        if (phaseRef.current === "connected") {
          console.warn("[vettu] live: an error during the call");
          say("status", midCallErrorLine(message));
        }
      },
      onMessage: ({ message, role }) => {
        lastActivityRef.current = Date.now();
        say(role === "user" ? "you" : "vettu", message);
      },
      onModeChange: ({ mode }) => {
        if (mode === "speaking") lastActivityRef.current = Date.now();
      },
      onUnhandledClientToolCall: (call) => {
        console.warn("[vettu] live: the agent called a tool this page does not register");
        say("status", unknownToolLine(call?.tool_name));
      },
    };
  });

  /* ---------- public API ---------- */

  const start = useCallback(async () => {
    // Read into a local: narrowing phaseRef.current here would outlive the await below.
    const before: SessionPhase = phaseRef.current;
    if (availableRef.current !== true || before !== "idle") return;
    const attempt = ++attemptRef.current;
    startingRef.current = false;
    setFailed(false);
    setReason(null);
    linesRef.current = clearLines(linesRef.current);
    setLines([]);
    setPhase("token");

    let token: string;
    try {
      const reply = await request<{ token?: unknown }>("/live-token");
      if (typeof reply.token !== "string" || !reply.token) throw new Error("no token");
      token = reply.token;
    } catch (error) {
      if (attempt !== attemptRef.current || !aliveRef.current) return;
      setPhase("idle");
      if (error instanceof ApiError && error.status === 503) {
        markAvailable(false, error.message || LIVE_NEEDS_AGENT);
        return;
      }
      setFailed(true);
      setReason(error instanceof ApiError && error.message ? error.message : LIVE_TOKEN_FAILED);
      return;
    }
    if (attempt !== attemptRef.current || !aliveRef.current || phaseRef.current !== "token") return;

    startingRef.current = true;
    lastActivityRef.current = Date.now();
    try {
      // A conversation token means WebRTC; the SDK opens the mic on this click's behalf.
      startSession({ conversationToken: token, connectionType: "webrtc" });
    } catch {
      fail(LIVE_START_FAILED);
      return;
    }

    setTimeout(() => {
      if (!aliveRef.current || attempt !== attemptRef.current) return;
      const current = phaseRef.current;
      if (current !== "token" && current !== "connecting") return;
      attemptRef.current += 1;
      try {
        endSession();
      } catch {
        // nothing to end
      }
      fail("LIVE · the voice call did not start in time.");
    }, START_TIMEOUT_MS);
  }, [endSession, fail, markAvailable, setPhase, startSession]);

  const stop = useCallback(async () => {
    attemptRef.current += 1; // invalidates a start still waiting on its token
    startingRef.current = false;
    const was = phaseRef.current;
    if (was === "idle") return;
    setPhase("idle");
    setFailed(false);
    setReason(null);
    if (was === "token") {
      say("status", "LIVE · stopped");
      return;
    }
    try {
      endSession();
    } catch {
      // already ended
    }
  }, [endSession, say, setPhase]);

  const setMuted = useCallback((next: boolean) => {
    if (phaseRef.current !== "connected") return;
    try {
      setSdkMutedRef.current(next);
    } catch {
      // no active conversation
    }
  }, []);

  /* ---------- billing guards: idle end · page leave ---------- */

  useEffect(() => {
    if (phase !== "connected") return;
    const timer = setInterval(() => {
      if (phaseRef.current !== "connected" || Date.now() - lastActivityRef.current < IDLE_END_MS) return;
      say("status", LIVE_IDLE_ENDED);
      void stop();
    }, IDLE_CHECK_MS);
    return () => clearInterval(timer);
  }, [phase, say, stop]);

  useEffect(() => {
    const end = () => {
      if (phaseRef.current === "idle") return;
      attemptRef.current += 1;
      try {
        endSession();
      } catch {
        // already ended
      }
    };
    window.addEventListener("beforeunload", end);
    window.addEventListener("pagehide", end);
    return () => {
      window.removeEventListener("beforeunload", end);
      window.removeEventListener("pagehide", end);
    };
  }, [endSession]);

  const state = liveStateOf({ available, phase, speaking: isSpeaking, failed });
  const live = state === "connecting" || state === "listening" || state === "speaking";
  const value = useMemo<LiveVoiceApi>(
    () => ({
      state,
      engine: "elevenlabs",
      reason: live ? null : reason,
      muted: phase === "connected" && isMuted,
      lines,
      start,
      stop,
      setMuted,
    }),
    [state, live, reason, phase, isMuted, lines, start, stop, setMuted],
  );

  return (
    <LiveVoiceContext.Provider value={value}>
      {VOICE_TOOL_NAMES.map((name) => (
        <VoiceTool key={name} name={name} run={runVoiceTool} />
      ))}
      {TYPED_ONLY_TOOL_NAMES.map((name) => (
        <VoiceTool key={name} name={name} run={refuseTool} />
      ))}
      {children}
    </LiveVoiceContext.Provider>
  );
}

export function LiveVoiceProvider({ children }: { children: ReactNode }) {
  // The SDK keeps provider callbacks behind refs; these forward to the controller's current handlers.
  const bus = useRef<LiveCallbacks>({});
  const callbacks = useMemo<LiveCallbacks>(
    () => ({
      onConnect: (props) => bus.current.onConnect?.(props),
      onDisconnect: (details) => bus.current.onDisconnect?.(details),
      onError: (message, context) => bus.current.onError?.(message, context),
      onMessage: (payload) => bus.current.onMessage?.(payload),
      onModeChange: (mode) => bus.current.onModeChange?.(mode),
      onStatusChange: (status) => bus.current.onStatusChange?.(status),
      onUnhandledClientToolCall: (call) => bus.current.onUnhandledClientToolCall?.(call),
    }),
    [],
  );
  return (
    <ConversationProvider {...callbacks}>
      <LiveController bus={bus}>{children}</LiveController>
    </ConversationProvider>
  );
}

export function useLiveVoice(): LiveVoiceApi {
  return useContext(LiveVoiceContext);
}
