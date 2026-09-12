/**
 * LIVE token route — one ElevenLabs Agents WebRTC conversation token per LIVE click.
 *
 * GET ?check=1 → { available, reason } — reads env only, never calls ElevenLabs.
 * GET          → { token } — nothing else: never the key, never the provider body.
 *
 * The key and agent id live in server env (ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID). A billed token is
 * minted only for VETTU's own page: loopback host (guard), the SameSite=Strict session cookie, and no
 * cross-site fetch.
 */
import { guarded, HttpError, SESSION_COOKIE } from "@/lib/server/guard";
import { LIVE_NEEDS_AGENT, LIVE_NEEDS_KEY } from "@/lib/live/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_URL = "https://api.elevenlabs.io/v1/convai/conversation/token";
const TIMEOUT_MS = 10_000;

function liveConfig() {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim() || null;
  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim() || null;
  const reason = !apiKey ? LIVE_NEEDS_KEY : !agentId ? LIVE_NEEDS_AGENT : null;
  return { apiKey, agentId, reason };
}

function hasSessionCookie(request: Request): boolean {
  const value = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  return !!value && /^[a-f0-9]{64}$/.test(value);
}

export const GET = guarded("read", async (g) => {
  const { apiKey, agentId, reason } = liveConfig();
  if (g.url.searchParams.get("check") === "1") {
    return g.reply({ available: reason === null, reason });
  }
  if (!apiKey || !agentId) throw new HttpError(503, reason ?? LIVE_NEEDS_KEY);
  if (!hasSessionCookie(g.request)) throw new HttpError(403, "Reload the page to start a session.");
  if (g.request.headers.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "Use VETTU's own page.");

  let response: Response;
  try {
    response = await fetch(`${TOKEN_URL}?agent_id=${encodeURIComponent(agentId)}`, {
      method: "GET",
      headers: { "xi-api-key": apiKey, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.error("[vettu] live token:", timedOut ? "timeout" : "network error");
    throw new HttpError(
      timedOut ? 504 : 502,
      timedOut ? "LIVE · ElevenLabs did not answer in time." : "LIVE · ElevenLabs could not be reached.",
    );
  }

  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    console.error("[vettu] live token refused:", response.status);
    throw new HttpError(502, `LIVE · ElevenLabs refused the token (${response.status})`);
  }

  let token: unknown;
  try {
    token = ((await response.json()) as { token?: unknown } | null)?.token;
  } catch {
    token = undefined;
  }
  if (typeof token !== "string" || !token) throw new HttpError(502, "LIVE · ElevenLabs sent no token.");
  return g.reply({ token });
});
