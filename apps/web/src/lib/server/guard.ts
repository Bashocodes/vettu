/**
 * The guard every VETTU route uses (split from the kit's followup-http.ts).
 *
 * - "read":    GET/HEAD · loopback host only · sets the session cookie if absent · `?session=1` → ready.
 * - "write":   POST/PATCH/PUT/DELETE · loopback · Origin === this host · JSON body · session cookie · body cap.
 * - "upload":  POST · loopback · Origin · session · multipart/form-data · Content-Length cap.
 * - "service": server-to-server from the channel process · loopback · no foreign Origin · JSON · body cap.
 *
 * Errors: HttpError messages pass through; zod/JSON → 400; anything else → a generic 500.
 * Never an fs or provider error text (it can carry paths or credentials).
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const SESSION_COOKIE = "vettu-session";
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

export type GuardMode = "read" | "write" | "upload" | "service";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface GuardContext {
  session: string;
  request: Request;
  url: URL;
  /** JSON reply with no-store and (when new) the session cookie. */
  reply(value: unknown, status?: number, headers?: Record<string, string>): Response;
  /** Raw response with the session cookie header added when new. */
  withSession(response: Response): Response;
  /** Parse + validate the JSON body (write/service modes). Throws HttpError 400/413. */
  json<T>(schema: z.ZodType<T>): Promise<T>;
  /** `If-Match` as a store rev, or null when absent. Throws 400 when malformed. */
  ifMatch(): number | null;
}

export interface GuardOptions {
  maxBytes?: number; // write/service JSON cap (default 16 000 chars); upload cap in bytes
}

export function guarded<C = unknown>(
  mode: GuardMode,
  handler: (g: GuardContext, context: C) => Promise<Response>,
  options: GuardOptions = {},
) {
  return async (request: Request, context: C): Promise<Response> => {
    const url = new URL(request.url);
    // Next may normalise request.url to localhost; compare Origin with the real Host.
    const expected = new URL(url);
    expected.host = request.headers.get("host") || url.host;
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    const hasSession = !!cookie && /^[a-f0-9]{64}$/.test(cookie);
    const session = hasSession ? cookie : randomBytes(32).toString("hex");
    const cookieHeader = `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=86400${url.protocol === "https:" ? "; Secure" : ""}`;
    const withSession = (response: Response) => {
      if (!hasSession && mode !== "service") response.headers.append("Set-Cookie", cookieHeader);
      return response;
    };
    const reply = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
      withSession(
        Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } }),
      );

    // A matching arbitrary Host/Origin can be DNS rebinding against local credentials.
    if (!LOOPBACK.includes(expected.hostname)) {
      return Response.json({ error: "VETTU accepts loopback hosts only." }, { status: 403 });
    }
    const method = request.method.toUpperCase();
    const origin = request.headers.get("origin");
    const contentType = request.headers.get("content-type") ?? "";
    const cap = options.maxBytes ?? (mode === "upload" ? 200 * 1024 * 1024 : 16_000);

    if (mode === "read") {
      if (method !== "GET" && method !== "HEAD") return reply({ error: "Method not allowed." }, 405);
      if (url.searchParams.get("session") === "1") return reply({ status: "ready" });
    } else if (mode === "service") {
      if (method !== "POST" && method !== "GET") return reply({ error: "Method not allowed." }, 405);
      if (origin && origin !== expected.origin) return reply({ error: "Foreign origin." }, 403);
      if (method === "POST" && !contentType.startsWith("application/json"))
        return reply({ error: "Send JSON." }, 415);
    } else {
      if (!["POST", "PATCH", "PUT", "DELETE"].includes(method))
        return reply({ error: "Method not allowed." }, 405);
      if (origin !== expected.origin) return reply({ error: "Use VETTU's own page." }, 403);
      if (mode === "write" && !contentType.startsWith("application/json"))
        return reply({ error: "Send JSON." }, 415);
      if (mode === "upload" && !contentType.startsWith("multipart/form-data"))
        return reply({ error: "Send multipart/form-data." }, 415);
      if (!hasSession) return reply({ error: "Reload the page to start a session." }, 403);
      if (mode === "upload") {
        const length = Number(request.headers.get("content-length") ?? "NaN");
        if (!Number.isFinite(length) || length > cap)
          return reply({ error: "That file is too large." }, 413);
      }
    }

    const g: GuardContext = {
      session,
      request,
      url,
      reply,
      withSession,
      async json<T>(schema: z.ZodType<T>) {
        const text = await request.text();
        if (text.length > cap) throw new HttpError(413, "The request is too large.");
        let raw: unknown;
        try {
          raw = text ? JSON.parse(text) : {};
        } catch {
          throw new HttpError(400, "The request body is not valid JSON.");
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          throw new HttpError(
            400,
            `Invalid request${first ? `: ${first.path.join(".") || "body"} — ${first.message}` : "."}`,
          );
        }
        return parsed.data;
      },
      ifMatch() {
        const h = request.headers.get("if-match");
        if (h == null) return null;
        const n = Number(h.replace(/^W\//, "").replace(/"/g, "").trim());
        if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "If-Match must be the film rev.");
        return n;
      },
    };

    try {
      return await handler(g, context);
    } catch (error) {
      if (error instanceof HttpError) return reply({ error: error.message, ...error.extra }, error.status);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return reply({ error: "Invalid request." }, 400);
      console.error(`[vettu] ${request.method} ${url.pathname} failed:`, error instanceof Error ? error.name : "error");
      return reply({ error: "VETTU could not complete that request." }, 500);
    }
  };
}
