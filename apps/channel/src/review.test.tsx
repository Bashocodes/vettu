/**
 * The VETTU review thread, offline, through the SDK's managed delivery fixture:
 * no Slack app, no Intelligence project, no network, no real media.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbstractAgent } from "@ag-ui/client";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { from, type Observable } from "rxjs";
import { createChannel } from "@copilotkit/channels";
import { startChannelsWithGatewayControl } from "@copilotkit/channels-intelligence";
import { z } from "zod";
import { registerReviewThread } from "./review";
import type { ChangeOrderBody, ReviewQueueItem, ReviewThreadState } from "./review-types";
import { createWebClient } from "./web";
import { ManagedGateway, preparedDelivery } from "./testing/managed-gateway";

const LOGICAL = "pid_v1_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const REVISION = "pid_v1_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const CARD_REF = { id: "pref_v1_review_card_001" };
const CUT_ONE = "f_test01:s04:v1";
const CUT_TWO = "f_test01:s04:v2";

type DeliveryInput = Parameters<typeof preparedDelivery>[2];
type Payload = { kind: string } & Record<string, unknown>;

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "vettu-review-test-"));
  await writeFile(join(dir, "preview_v1_540p.mp4"), "placeholder preview one");
  await writeFile(join(dir, "preview_v2_540p.mp4"), "placeholder preview two");
  await writeFile(join(dir, "poster_v1.png"), "placeholder poster");
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function cut(version: 1 | 2, options: { poster?: boolean; missing?: boolean } = {}): ReviewQueueItem {
  return {
    cutId: `f_test01:s04:v${version}`,
    version,
    title: `PLACEHOLDER FILM · §04 · v${version}`,
    previewPath: join(dir, options.missing ? "missing_540p.mp4" : `preview_v${version}_540p.mp4`),
    posterPath: options.poster ? join(dir, "poster_v1.png") : null,
  };
}

function text(value: string, operation: { kind?: "created" | "updated"; mentioned?: boolean } = {}): DeliveryInput {
  return {
    kind: "text",
    text: value,
    operation: {
      kind: operation.kind ?? "created",
      logicalMessageId: LOGICAL,
      revisionId: REVISION,
      mentioned: operation.mentioned ?? false,
    },
  } as DeliveryInput;
}

function click(actionId: string): DeliveryInput {
  return { kind: "interaction", actionId, messageRef: CARD_REF } as DeliveryInput;
}

/** An agent that only counts its runs; clones share the counter. */
class CountingAgent extends AbstractAgent {
  constructor(private readonly runs: { count: number }) {
    super();
  }
  override clone(): CountingAgent {
    const clone = new CountingAgent(this.runs);
    clone.threadId = this.threadId;
    clone.setMessages([...this.messages]);
    clone.setState(this.state);
    return clone;
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    this.runs.count += 1;
    return from([
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
    ] as BaseEvent[]);
  }
}

/** The three VETTU web routes, in memory. */
function fakeVettu(initial: ReviewQueueItem[]) {
  const state = {
    queue: [...initial],
    queueReads: 0,
    posted: [] as string[],
    orders: [] as ChangeOrderBody[],
  };
  const fetchImpl = async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (method === "GET" && pathname === "/api/review/queue") {
      state.queueReads += 1;
      return Response.json(state.queue);
    }
    if (method === "POST" && pathname === "/api/review/posted") {
      state.posted.push(body.cutId);
      state.queue = state.queue.filter((item) => item.cutId !== body.cutId);
      return Response.json({ ok: true });
    }
    if (method === "POST" && pathname === "/api/change-orders") {
      state.orders.push(body);
      return Response.json({ changeOrder: { id: `co_${state.orders.length}` }, duplicate: false });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  };
  return { state, web: createWebClient({ baseUrl: "http://127.0.0.1:3100", fetch: fetchImpl }) };
}

interface HarnessOptions {
  uploadStatus?: number;
  /** How the thread starts: a human @-mention (default) or the app's welcome. */
  start?: "mention" | "welcome";
  /** Thread state left by an earlier listener process, stored before the first event. */
  seed?: ReviewThreadState;
}

async function harness(queue: ReviewQueueItem[], options: HarnessOptions = {}) {
  const gateway = new ManagedGateway();
  const vettu = fakeVettu(queue);
  const runs = { count: 0 };
  const uploads: { filename: string | null; contentType: string | null }[] = [];
  const channel = createChannel({
    name: "support",
    identifyUser: "platform",
    agent: () => new CountingAgent(runs),
  });
  registerReviewThread(channel, { web: vettu.web });

  // The first event of the thread. Every later delivery reuses its canonicalThreadId.
  const first =
    options.start === "welcome"
      ? preparedDelivery("review_welcome", "slack", { kind: "welcome" } as DeliveryInput)
      : preparedDelivery("review_kickoff", "slack", text("<@U0VETTU> review", { mentioned: true }));
  // The SDK keys a thread's subscription as `sub:<canonicalThreadId>` and its
  // state as `threadstate:<canonicalThreadId>` (channels-core thread.js).
  const threadKey = first.canonicalThreadId;
  const subKey = `sub:${threadKey}`;
  const stateKey = `threadstate:${threadKey}`;

  // With appApiBaseUrl + apiKey the launcher keeps subscriptions, thread state and
  // button snapshots in Intelligence KV over the GLOBAL fetch (not appApiFetch).
  // Answer those four routes from memory; everything else stays offline.
  const kv = new Map<string, unknown>();
  if (options.seed) kv.set(stateKey, options.seed);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = /^\/api\/channels\/kv\/(get|set|delete|consume)$/.exec(url.pathname);
    if (url.origin !== "https://api.example" || !route) {
      return Response.json({ error: "offline" }, { status: 404 });
    }
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { key: string; value?: unknown };
    const stored = kv.has(body.key) ? kv.get(body.key) : null;
    if (route[1] === "set") kv.set(body.key, body.value);
    if (route[1] === "delete" || route[1] === "consume") kv.delete(body.key);
    return Response.json(route[1] === "get" || route[1] === "consume" ? { value: stored } : {});
  }) as typeof fetch;

  let handle: Awaited<ReturnType<typeof startChannelsWithGatewayControl>>;
  try {
  handle = await startChannelsWithGatewayControl([channel], {
    session: gateway,
    scope: { projectId: 1, channelName: "support" },
    runtimeInstanceId: "rti_review",
    loadHistory: async () => [],
    appApiBaseUrl: "https://api.example",
    apiKey: "cpk-offline-test",
    appApiFetch: async (input, init) => {
      const url = new URL(String(input));
      if (/\/api\/channels\/deliveries\/[^/]+\/files$/.test(url.pathname)) {
        uploads.push({
          filename: url.searchParams.get("filename"),
          contentType: new Headers(init?.headers).get("content-type"),
        });
        const status = options.uploadStatus ?? 200;
        return status === 200
          ? Response.json({ handle: `file_handle_${uploads.length}` })
          : Response.json({ error: "rejected" }, { status });
      }
      if (url.pathname.endsWith("/charge")) return Response.json({ charged: true });
      if (url.pathname.endsWith("/transcript")) {
        return Response.json({
          messages: [],
          truncation: { messageLimit: false, byteLimit: false, omittedMessageCount: 0 },
        });
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    },
    runCanonical: async (args) => args.execute({}, { threadId: args.threadId, runId: args.runId }),
  });
  } catch (error) {
    globalThis.fetch = realFetch;
    throw error;
  }

  /** Deliver another turn into the SAME thread (same canonicalThreadId). */
  const deliver = async (
    suffix: string,
    input: DeliveryInput,
    actor?: ReturnType<typeof preparedDelivery>["turn"]["actor"],
  ) => {
    const next = preparedDelivery(suffix, "slack", input);
    await gateway.deliver({
      ...first,
      deliveryId: next.deliveryId,
      turn: actor ? { ...next.turn, actor } : next.turn,
    });
    return next;
  };
  const payloads = () => gateway.packets.map(({ payload }) => payload as unknown as Payload);
  const created = () => payloads().filter((payload) => payload.kind === "slack.message.create");
  const replaced = () => payloads().filter((payload) => payload.kind === "slack.message.replace");
  const files = () => payloads().filter((payload) => payload.kind === "slack.file.create");
  // Review cards are the posts carrying a real "Request changes" BUTTON; the
  // kickoff card only mentions those words in its text.
  const cards = () => created().filter((payload) => buttonLabels(payload).includes("Request changes"));
  const kickoffs = () => created().filter((payload) => buttonLabels(payload).includes("Post latest cut"));
  const failures = () => created().filter((payload) => JSON.stringify(payload).includes("upload failed"));
  return {
    gateway,
    vettu,
    runs,
    uploads,
    first,
    kv,
    subKey,
    stateKey,
    deliver,
    payloads,
    created,
    replaced,
    files,
    cards,
    kickoffs,
    failures,
    stop: async () => {
      try {
        await handle.stop();
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  };
}

/** Labels of the buttons in a posted Slack message (empty when it has none). */
function buttonLabels(payload: Payload): string[] {
  const blocks = z
    .array(z.object({ type: z.string(), elements: z.array(z.unknown()).optional() }))
    .safeParse(payload.blocks);
  if (!blocks.success) return [];
  return blocks.data
    .flatMap((block) => (block.type === "actions" ? (block.elements ?? []) : []))
    .flatMap((element) => {
      const button = z
        .object({ type: z.literal("button"), text: z.object({ text: z.string() }) })
        .safeParse(element);
      return button.success ? [button.data.text.text] : [];
    });
}

/** The real Slack action id Channels generated for a button on a posted card. */
function actionId(card: Payload | undefined, label: string): string {
  assert.ok(card, `no card carrying ${label}`);
  const blocks = z
    .array(z.object({ type: z.string(), elements: z.array(z.unknown()).optional() }))
    .parse(card.blocks);
  const button = blocks
    .flatMap((block) => (block.type === "actions" ? (block.elements ?? []) : []))
    .map((element) =>
      z
        .object({ type: z.literal("button"), text: z.object({ text: z.string() }), action_id: z.string() })
        .parse(element),
    )
    .find((element) => element.text.text === label);
  assert.ok(button, `no ${label} button on the card`);
  return button.action_id;
}

describe("VETTU review thread", () => {
  it(
    "a mention posts the preview, the poster and one review card, then marks the cut posted once",
    { timeout: 10_000 },
    async () => {
      const h = await harness([cut(1, { poster: true })]);
      try {
        await h.gateway.deliver(h.first);
        assert.deepEqual(
          h.uploads,
          [
            { filename: "f_test01-s04-v1-540p.mp4", contentType: "application/octet-stream" },
            { filename: "f_test01-s04-v1-poster.png", contentType: "image/png" },
          ],
          JSON.stringify(h.payloads()),
        );
        assert.equal(h.files().length, 2);
        assert.equal(h.cards().length, 1);
        assert.match(JSON.stringify(h.cards()[0]), /PLACEHOLDER FILM · §04 · v1/);
        const kinds = h.payloads().map((payload) => payload.kind);
        assert.ok(
          kinds.indexOf("slack.file.create") < kinds.indexOf("slack.message.create"),
          "the preview lands before the card",
        );
        assert.equal(h.kickoffs().length, 1, "the kickoff card follows the flush");
        assert.deepEqual(h.vettu.state.posted, [CUT_ONE]);

        // The next human reply pulls the queue again: nothing is posted twice.
        await h.deliver("review_reply_after", text("the pacing works"));
        assert.equal(h.vettu.state.queueReads, 2);
        assert.equal(h.uploads.length, 2);
        assert.equal(h.cards().length, 1);
        assert.deepEqual(h.vettu.state.posted, [CUT_ONE]);
      } finally {
        await h.stop();
      }
    },
  );

  it(
    "a failed upload posts a text line, still posts the card, and does not mark the cut posted",
    { timeout: 10_000 },
    async () => {
      const h = await harness([cut(1)], { uploadStatus: 400 });
      try {
        await h.gateway.deliver(h.first);
        assert.equal(h.files().length, 0);
        const [failure] = h.failures();
        assert.ok(failure, JSON.stringify(h.payloads()));
        assert.match(JSON.stringify(failure), /Cut v1 rendered, upload failed: intelligence file upload/);
        assert.equal(h.cards().length, 1);
        assert.deepEqual(h.vettu.state.posted, []);
      } finally {
        await h.stop();
      }
    },
  );

  it("a missing preview is reported without its local path", { timeout: 10_000 }, async () => {
    const h = await harness([cut(1, { missing: true })]);
    try {
      await h.gateway.deliver(h.first);
      assert.equal(h.uploads.length, 0);
      const everything = JSON.stringify(h.payloads());
      assert.match(everything, /upload failed: the preview file could not be read/);
      assert.ok(!everything.includes(dir), "no local path reaches Slack");
      assert.deepEqual(h.vettu.state.posted, []);
    } finally {
      await h.stop();
    }
  });

  it("the first click wins, and each card files its own cut", { timeout: 10_000 }, async () => {
    const h = await harness([cut(1), cut(2)]);
    try {
      await h.gateway.deliver(h.first);
      const [one, two] = h.cards();
      assert.ok(one && two, "one card per queued cut");
      assert.match(JSON.stringify(one), /§04 · v1/);
      assert.notEqual(actionId(one, "Approve"), actionId(two, "Approve"), "cards must not share action ids");

      await h.deliver("review_click_approve", click(actionId(one, "Approve")));
      assert.equal(h.vettu.state.orders.length, 1);
      const [order] = h.vettu.state.orders;
      assert.equal(order.cutId, CUT_ONE);
      assert.equal(order.kind, "approve");
      assert.equal(order.source, "button");
      assert.equal(order.reviewer.name, "Ada");
      assert.equal(order.idempotencyKey, `${CARD_REF.id}:${CUT_ONE}`);
      assert.equal(h.replaced().length, 1);
      assert.match(JSON.stringify(h.replaced()[0]), /Approved by Ada/);

      // Replay Approve, then the opposite choice on the same card: neither lands.
      await h.deliver("review_click_replay", click(actionId(one, "Approve")));
      await h.deliver("review_click_opposite", click(actionId(one, "Request changes")));
      assert.equal(h.replaced().length, 1, "duplicate and opposite clicks keep the first decision");
      assert.equal(h.vettu.state.orders.length, 1);

      // The opposite click opened no note: a reply now is an ordinary message.
      await h.deliver("review_reply_plain", text("nice pacing"));
      assert.equal(h.vettu.state.orders.length, 1);
    } finally {
      await h.stop();
    }
  });

  it(
    "a reply after Request changes files one change order and does not run the agent",
    { timeout: 10_000 },
    async () => {
      const h = await harness([cut(1)]);
      try {
        await h.gateway.deliver(h.first);
        const [card] = h.cards();
        await h.deliver("review_click_changes", click(actionId(card, "Request changes")));
        assert.equal(h.replaced().length, 1);
        assert.match(JSON.stringify(h.replaced()[0]), /Reply in this thread with the change/);
        assert.equal(h.vettu.state.orders.length, 0, "the click alone files nothing");

        const reply = await h.deliver("review_reply_note", text("Hold the third shot half a second longer"));
        assert.equal(h.runs.count, 0, "a change note must not run the agent");
        assert.equal(h.vettu.state.orders.length, 1);
        const [order] = h.vettu.state.orders;
        assert.equal(order.kind, "changes");
        assert.equal(order.source, "reply");
        assert.equal(order.cutId, CUT_ONE);
        assert.equal(order.text, "Hold the third shot half a second longer");
        assert.equal(order.reviewer.name, "Ada");
        assert.equal(order.idempotencyKey, reply.turn.eventId);
        assert.ok(
          h.created().some((payload) => JSON.stringify(payload).includes("Change order filed for PLACEHOLDER FILM")),
        );

        // The note is spent: the next reply is an ordinary message, and the agent
        // answers it (the positive control for the zero-runs proof above).
        await h.deliver("review_reply_next", text("what changed since v1?"));
        assert.equal(h.vettu.state.orders.length, 1);
        assert.equal(h.runs.count, 1, "an ordinary subscribed reply runs the agent");
      } finally {
        await h.stop();
      }
    },
  );

  it("a change note that @-mentions the bot is filed too", { timeout: 10_000 }, async () => {
    const h = await harness([cut(1)]);
    try {
      await h.gateway.deliver(h.first);
      const [card] = h.cards();
      await h.deliver("review_click_changes", click(actionId(card, "Request changes")));
      await h.deliver("review_mention_note", text("<@U0VETTU> trim the second shot", { mentioned: true }));
      assert.equal(h.vettu.state.orders.length, 1);
      assert.equal(h.vettu.state.orders[0].text, "trim the second shot");
      assert.equal(h.runs.count, 0);
      assert.equal(h.vettu.state.queueReads, 1, "a filed note does not pull the queue");
    } finally {
      await h.stop();
    }
  });

  it(
    "a thread started by the welcome card: the clicks subscribe it and the change note is filed",
    { timeout: 10_000 },
    async () => {
      const h = await harness([cut(1)], { start: "welcome" });
      try {
        await h.gateway.deliver(h.first);
        assert.equal(h.kickoffs().length, 1, JSON.stringify(h.payloads()));
        assert.equal(h.vettu.state.queueReads, 0, "the welcome itself pulls nothing");
        assert.equal(h.kv.has(h.subKey), false, "the welcome itself subscribes nothing");

        await h.deliver("review_click_kickoff", click(actionId(h.kickoffs()[0], "Post latest cut")));
        assert.equal(h.kv.get(h.subKey), true, "Post latest cut subscribes the thread");
        assert.equal(h.cards().length, 1);
        assert.deepEqual(h.vettu.state.posted, [CUT_ONE]);

        await h.deliver("review_click_changes", click(actionId(h.cards()[0], "Request changes")));
        assert.match(JSON.stringify(h.replaced().at(-1)), /Reply in this thread with the change/);
        assert.equal(h.kv.get(h.subKey), true, "Request changes keeps the thread subscribed");

        const reply = await h.deliver("review_reply_note", text("Open on the wide shot"));
        assert.equal(h.vettu.state.orders.length, 1, JSON.stringify(h.payloads()));
        const [order] = h.vettu.state.orders;
        assert.equal(order.kind, "changes");
        assert.equal(order.source, "reply");
        assert.equal(order.cutId, CUT_ONE);
        assert.equal(order.text, "Open on the wide shot");
        assert.equal(order.idempotencyKey, reply.turn.eventId);
        assert.equal(h.runs.count, 0, "a change note must not run the agent");
        assert.ok(
          h.created().some((payload) => JSON.stringify(payload).includes("Change order filed for PLACEHOLDER FILM")),
        );

        await h.deliver("review_reply_next", text("does v1 keep the music?"));
        assert.equal(h.runs.count, 1, "an ordinary reply in the welcome thread reaches the agent");
        assert.equal(h.vettu.state.orders.length, 1);
      } finally {
        await h.stop();
      }
    },
  );

  it(
    "an awaited change note is filed even when the thread is not subscribed",
    { timeout: 10_000 },
    async () => {
      const h = await harness([cut(1)], { start: "welcome" });
      try {
        await h.gateway.deliver(h.first);
        await h.deliver("review_click_kickoff", click(actionId(h.kickoffs()[0], "Post latest cut")));
        await h.deliver("review_click_changes", click(actionId(h.cards()[0], "Request changes")));
        // However Slack maps the click and the reply to threads, the awaited
        // note is keyed by the reply's own thread, never by the subscription.
        h.kv.delete(h.subKey);

        await h.deliver("review_reply_note", text("Cut the last beat"));
        assert.equal(h.vettu.state.orders.length, 1);
        assert.equal(h.vettu.state.orders[0].text, "Cut the last beat");
        assert.equal(h.runs.count, 0);

        // Spent, and unsubscribed: an ordinary reply is now ignored.
        await h.deliver("review_reply_next", text("thanks"));
        assert.equal(h.vettu.state.orders.length, 1);
        assert.equal(h.runs.count, 0);
      } finally {
        await h.stop();
      }
    },
  );

  it(
    "a retry after a failed upload posts no second card, so a decided cut cannot be decided again",
    { timeout: 10_000 },
    async () => {
      const h = await harness([cut(1, { missing: true })]);
      try {
        await h.gateway.deliver(h.first);
        assert.equal(h.cards().length, 1);
        const [card] = h.cards();

        // Undecided: a retry re-tries the video, says so, and keeps the one live card.
        await h.deliver("review_reply_first", text("where is the video?"));
        assert.equal(h.vettu.state.queueReads, 2);
        assert.equal(h.failures().length, 2, "the retry still reports the failed upload");
        assert.equal(h.cards().length, 1, "no second card while the first one is live");

        await h.deliver("review_click_approve", click(actionId(card, "Approve")));
        assert.equal(h.vettu.state.orders.length, 1);
        assert.match(JSON.stringify(h.replaced().at(-1)), /Approved by Ada/);
        assert.deepEqual((h.kv.get(h.stateKey) as ReviewThreadState).decided, {
          [CUT_ONE]: { kind: "approve", reviewer: "Ada" },
        });

        // Decided: another retry still posts no card to click the other way.
        await h.deliver("review_reply_great", text("great"));
        assert.equal(h.vettu.state.queueReads, 3);
        assert.equal(h.failures().length, 3);
        assert.equal(h.cards().length, 1, "no second card for a decided cut");
        assert.deepEqual(h.vettu.state.posted, [], "a cut whose video never uploaded stays queued");

        await h.deliver("review_click_changes", click(actionId(card, "Request changes")));
        await h.deliver("review_reply_trim", text("trim it"));
        assert.deepEqual(
          h.vettu.state.orders.map((order) => order.kind),
          ["approve"],
          "the approval stays the only decision",
        );
      } finally {
        await h.stop();
      }
    },
  );

  it(
    "after a listener restart the card is posted again, and a cut decided elsewhere files nothing",
    { timeout: 10_000 },
    async () => {
      const h = await harness([cut(1, { missing: true }), cut(2, { missing: true })], {
        // Cards posted by an earlier listener process: their buttons are gone.
        seed: { carded: { [CUT_ONE]: "an-earlier-listener", [CUT_TWO]: "an-earlier-listener" } },
      });
      try {
        await h.gateway.deliver(h.first);
        const [one, two] = h.cards();
        assert.ok(one && two, "a new process posts fresh cards for cuts carded by an old one");

        // Meanwhile both cuts were decided on another card: v1 approved, and v2
        // sent back with its note already filed.
        const seeded = h.kv.get(h.stateKey) as ReviewThreadState;
        h.kv.set(h.stateKey, {
          ...seeded,
          decided: {
            [CUT_ONE]: { kind: "approve", reviewer: "Grace" },
            [CUT_TWO]: { kind: "changes", reviewer: "Grace" },
          },
        } satisfies ReviewThreadState);

        await h.deliver("review_click_changes_one", click(actionId(one, "Request changes")));
        await h.deliver("review_click_approve_two", click(actionId(two, "Approve")));
        assert.equal(h.vettu.state.orders.length, 0, "a decided cut files no second decision");

        const [first, second] = h.replaced().map((payload) => JSON.stringify(payload));
        assert.match(first, /Approved by Grace/);
        assert.match(second, /Changes requested by Grace/);
        assert.ok(!second.includes("Reply in this thread"), "no reply prompt once the note is filed");
        assert.equal((h.kv.get(h.stateKey) as ReviewThreadState).awaitingNotesFor, undefined);

        // No note is awaited, so a reply is an ordinary message.
        await h.deliver("review_reply_after", text("shorten the opening"));
        assert.equal(h.vettu.state.orders.length, 0);
        assert.equal(h.runs.count, 1);
      } finally {
        await h.stop();
      }
    },
  );

  it("bot posts, edits and unsubscribed threads are ignored", { timeout: 10_000 }, async () => {
    const h = await harness([]);
    try {
      await h.gateway.deliver(h.first); // subscribes and reads the empty queue once
      assert.equal(h.vettu.state.queueReads, 1);
      const createdBefore = h.created().length;

      await h.deliver("review_bot_post", text("Cut v9 rendered"), {
        externalUserId: "B0VETTU",
        kind: "bot",
        displayName: "VETTU",
      });
      await h.deliver("review_edit_post", text("an edited note", { kind: "updated" }));
      assert.equal(h.vettu.state.queueReads, 1);
      assert.equal(h.runs.count, 0);
      assert.equal(h.created().length, createdBefore);

      // A human message in a thread nobody mentioned the bot in.
      await h.gateway.deliver(preparedDelivery("review_other_thread", "slack", text("unrelated chatter")));
      assert.equal(h.vettu.state.queueReads, 1);
      assert.equal(h.runs.count, 0);
    } finally {
      await h.stop();
    }
  });
});
