import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebError, createWebClient } from "./web";

interface Seen {
  url: string;
  method: string;
  contentType: string | null;
  body: string | null;
}

function recorder(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const entry: Seen = {
      url,
      method: init.method ?? "GET",
      contentType: new Headers(init.headers).get("content-type"),
      body: typeof init.body === "string" ? init.body : null,
    };
    seen.push(entry);
    return respond(entry);
  };
  return { seen, fetchImpl };
}

const item = {
  cutId: "f_test01:s04:v1",
  version: 1,
  title: "PLACEHOLDER FILM · §04 · v1",
  previewPath: "/tmp/placeholder_540p.mp4",
  posterPath: null,
};

describe("VETTU web client", () => {
  it("reads the review queue from VETTU_WEB_URL and skips malformed items", async () => {
    const previous = process.env.VETTU_WEB_URL;
    process.env.VETTU_WEB_URL = "http://127.0.0.1:3100/";
    try {
      const { seen, fetchImpl } = recorder(() => Response.json([item, { cutId: 5 }]));
      const queue = await createWebClient({ fetch: fetchImpl }).getQueue();
      assert.deepEqual(queue, [item]);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, "http://127.0.0.1:3100/api/review/queue");
      assert.equal(seen[0].method, "GET");
      assert.equal(seen[0].contentType, "application/json");
    } finally {
      if (previous === undefined) delete process.env.VETTU_WEB_URL;
      else process.env.VETTU_WEB_URL = previous;
    }
  });

  it("marks a cut posted with a JSON body", async () => {
    const { seen, fetchImpl } = recorder(() => Response.json({ ok: true }));
    await createWebClient({ baseUrl: "http://127.0.0.1:3100", fetch: fetchImpl }).markPosted(item.cutId);
    assert.equal(seen[0].url, "http://127.0.0.1:3100/api/review/posted");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].contentType, "application/json");
    assert.deepEqual(JSON.parse(seen[0].body ?? ""), { cutId: item.cutId });
  });

  it("files a change order and reports a duplicate", async () => {
    const { seen, fetchImpl } = recorder(() => Response.json({ changeOrder: { id: "co_1" }, duplicate: true }));
    const client = createWebClient({ baseUrl: "http://127.0.0.1:3100", fetch: fetchImpl });
    const body = {
      idempotencyKey: "evt_1",
      cutId: item.cutId,
      kind: "changes" as const,
      text: "hold the third shot longer",
      reviewer: { id: "U1", name: "Ada" },
      source: "reply" as const,
    };
    assert.deepEqual(await client.postChangeOrder(body), { duplicate: true });
    assert.equal(seen[0].url, "http://127.0.0.1:3100/api/change-orders");
    assert.deepEqual(JSON.parse(seen[0].body ?? ""), body);
  });

  it("refuses an invalid change order before any request", async () => {
    const { seen, fetchImpl } = recorder(() => Response.json({}));
    const client = createWebClient({ baseUrl: "http://127.0.0.1:3100", fetch: fetchImpl });
    await assert.rejects(
      client.postChangeOrder({
        idempotencyKey: "evt_1",
        cutId: item.cutId,
        kind: "changes",
        text: "x".repeat(4001),
        reviewer: { id: "U1", name: "Ada" },
        source: "reply",
      }),
      (error: unknown) => error instanceof WebError && /not valid/.test(error.message),
    );
    assert.equal(seen.length, 0);
  });

  it("turns server and network failures into controlled sentences", async () => {
    const conflict = recorder(() => Response.json({ error: "That cut is not approved." }, { status: 409 }));
    await assert.rejects(
      createWebClient({ baseUrl: "http://127.0.0.1:3100", fetch: conflict.fetchImpl }).markPosted(item.cutId),
      (error: unknown) =>
        error instanceof WebError && error.status === 409 && error.message === "VETTU answered 409: That cut is not approved.",
    );
    const down = createWebClient({
      baseUrl: "http://127.0.0.1:3100",
      fetch: async () => {
        throw new TypeError("connect ECONNREFUSED 127.0.0.1:3100");
      },
    });
    await assert.rejects(
      down.getQueue(),
      (error: unknown) => error instanceof WebError && error.message === "VETTU is not reachable.",
    );
    const odd = recorder(() => Response.json({ queue: [] }));
    await assert.rejects(
      createWebClient({ baseUrl: "http://127.0.0.1:3100", fetch: odd.fetchImpl }).getQueue(),
      (error: unknown) => error instanceof WebError && /unexpected review queue/.test(error.message),
    );
  });
});
