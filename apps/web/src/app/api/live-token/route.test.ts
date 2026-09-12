import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LIVE_NEEDS_AGENT, LIVE_NEEDS_KEY } from "@/lib/live/voice";

process.env.VETTU_DATA_DIR = mkdtempSync(join(tmpdir(), "vettu-live-token-"));
const load = () => import("./route");

const HOST = "127.0.0.1:3100";
const KEY = "placeholder-key-for-tests";
const AGENT = "agent_placeholder";

function call(query = "", init: { method?: string; host?: string; cookie?: string | null; site?: string } = {}) {
  const headers: Record<string, string> = { host: init.host ?? HOST, origin: `http://${HOST}` };
  if (init.cookie !== null) headers.cookie = init.cookie ?? `vettu-session=${"a".repeat(64)}`;
  if (init.site) headers["sec-fetch-site"] = init.site;
  return new Request(`http://${HOST}/api/live-token${query}`, { method: init.method ?? "GET", headers });
}

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(env);
  try {
    await fn();
  } finally {
    apply(saved);
  }
}

type FetchCall = { url: string; init: RequestInit | undefined };

/** Replace global fetch for one test; `reply` undefined = any call fails the test. */
async function withFetch(reply: ((url: string) => Promise<Response>) | undefined, fn: (calls: FetchCall[]) => Promise<void>) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (!reply) throw new Error("fetch must not be called");
    return reply(url);
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("check=1 reports availability from env only and never calls ElevenLabs", async () => {
  const { GET } = await load();
  await withFetch(undefined, async (calls) => {
    const cases: Array<[Record<string, string | undefined>, unknown]> = [
      [{ ELEVENLABS_API_KEY: undefined, ELEVENLABS_AGENT_ID: undefined }, { available: false, reason: LIVE_NEEDS_KEY }],
      [{ ELEVENLABS_API_KEY: "  ", ELEVENLABS_AGENT_ID: AGENT }, { available: false, reason: LIVE_NEEDS_KEY }],
      [{ ELEVENLABS_API_KEY: KEY, ELEVENLABS_AGENT_ID: undefined }, { available: false, reason: LIVE_NEEDS_AGENT }],
      [{ ELEVENLABS_API_KEY: KEY, ELEVENLABS_AGENT_ID: AGENT }, { available: true, reason: null }],
    ];
    for (const [env, expected] of cases) {
      await withEnv(env, async () => {
        const response = await GET(call("?check=1"), {});
        const text = await response.text();
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(text), expected);
        assert.equal(text.includes(KEY), false);
        assert.equal(text.includes(AGENT), false);
        assert.equal(response.headers.get("cache-control"), "no-store");
      });
    }
    assert.equal(calls.length, 0);
  });
});

test("an unconfigured mint is a controlled 503 without calling ElevenLabs", async () => {
  const { GET } = await load();
  await withFetch(undefined, async (calls) => {
    await withEnv({ ELEVENLABS_API_KEY: undefined, ELEVENLABS_AGENT_ID: AGENT }, async () => {
      const response = await GET(call(), {});
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: LIVE_NEEDS_KEY });
    });
    await withEnv({ ELEVENLABS_API_KEY: KEY, ELEVENLABS_AGENT_ID: undefined }, async () => {
      const response = await GET(call(), {});
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: LIVE_NEEDS_AGENT });
    });
    assert.equal(calls.length, 0);
  });
});

test("a mint replies { token } only, with the key sent as xi-api-key on the server", async () => {
  const { GET } = await load();
  await withEnv({ ELEVENLABS_API_KEY: KEY, ELEVENLABS_AGENT_ID: AGENT }, async () => {
    await withFetch(
      async () => Response.json({ token: "token-placeholder", conversation_id: "conv_placeholder" }),
      async (calls) => {
        const response = await GET(call(), {});
        const text = await response.text();
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(text), { token: "token-placeholder" });
        assert.equal(text.includes(KEY), false);
        assert.equal(text.includes("conv_placeholder"), false);
        assert.equal(calls.length, 1);
        const url = new URL(calls[0].url);
        assert.equal(url.origin + url.pathname, "https://api.elevenlabs.io/v1/convai/conversation/token");
        assert.equal(url.searchParams.get("agent_id"), AGENT);
        assert.equal(new Headers(calls[0].init?.headers).get("xi-api-key"), KEY);
        assert.ok(calls[0].init?.signal, "the provider call carries a timeout signal");
      },
    );
  });
});

test("provider refusals, empty bodies, timeouts and network errors stay controlled", async () => {
  const { GET } = await load();
  await withEnv({ ELEVENLABS_API_KEY: KEY, ELEVENLABS_AGENT_ID: AGENT }, async () => {
    await withFetch(
      async () => new Response("provider detail that must not leak", { status: 401 }),
      async () => {
        const response = await GET(call(), {});
        const text = await response.text();
        assert.equal(response.status, 502);
        assert.deepEqual(JSON.parse(text), { error: "LIVE · ElevenLabs refused the token (401)" });
        assert.equal(text.includes("provider detail"), false);
      },
    );
    await withFetch(
      async () => Response.json({ nothing: true }),
      async () => {
        const response = await GET(call(), {});
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { error: "LIVE · ElevenLabs sent no token." });
      },
    );
    await withFetch(
      async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      async () => {
        const response = await GET(call(), {});
        assert.equal(response.status, 504);
        assert.deepEqual(await response.json(), { error: "LIVE · ElevenLabs did not answer in time." });
      },
    );
    await withFetch(
      async () => {
        throw new TypeError("fetch failed: getaddrinfo placeholder.host");
      },
      async () => {
        const response = await GET(call(), {});
        const text = await response.text();
        assert.equal(response.status, 502);
        assert.deepEqual(JSON.parse(text), { error: "LIVE · ElevenLabs could not be reached." });
        assert.equal(text.includes("getaddrinfo"), false);
      },
    );
  });
});

test("a mint needs the session cookie, a same-site fetch, a loopback host and GET", async () => {
  const { GET } = await load();
  await withEnv({ ELEVENLABS_API_KEY: KEY, ELEVENLABS_AGENT_ID: AGENT }, async () => {
    await withFetch(undefined, async (calls) => {
      assert.equal((await GET(call("", { cookie: null }), {})).status, 403);
      assert.equal((await GET(call("", { cookie: "vettu-session=short" }), {})).status, 403);
      assert.equal((await GET(call("", { site: "cross-site" }), {})).status, 403);
      assert.equal((await GET(call("", { host: "evil.example" }), {})).status, 403);
      assert.equal((await GET(call("", { method: "POST" }), {})).status, 405);
      assert.equal(calls.length, 0);
    });
  });
});
