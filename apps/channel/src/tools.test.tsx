import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { describeFlush } from "./review";
import { createPostLatestCutTool, readThread } from "./tools";
import { createWebClient } from "./web";

/** Only the methods these tools call; the rest of Thread is irrelevant here. */
const stubContext = (thread: Record<string, unknown>) =>
  ({
    thread,
    user: { id: "u1", name: "Ada" },
    actor: { id: "a1", kind: "human" },
    platform: "slack",
  }) as never;

describe("read_thread", () => {
  it("returns the messages when the surface exposes history", async () => {
    const messages = [{ id: "1", role: "user", content: "the second shot runs long" }];
    const result = await readThread.handler({}, stubContext({ getMessages: mock.fn(async () => messages) }));
    assert.deepEqual(result, messages);
  });

  it("degrades into an instruction, not an empty array, when history is unavailable", async () => {
    // getMessages() returns [] rather than throwing where history is unreadable.
    // Handing that [] to the model reads as "nothing was said about this cut".
    const result = await readThread.handler({}, stubContext({ getMessages: mock.fn(async () => []) }));
    assert.equal(typeof result, "string");
    assert.match(String(result), /cannot see earlier messages/i);
  });
});

describe("post_latest_cut", () => {
  it("tells the model when nothing is queued and posts nothing", async () => {
    const post = mock.fn(async () => ({ id: "m1" }));
    const postFile = mock.fn(async () => ({ ok: true }));
    const tool = createPostLatestCutTool({
      web: createWebClient({ baseUrl: "http://127.0.0.1:3100", fetch: async () => Response.json([]) }),
    });
    const result = await tool.handler({}, stubContext({ post, postFile }));
    assert.match(String(result), /No approved cuts are waiting for review/);
    assert.equal(post.mock.callCount(), 0);
    assert.equal(postFile.mock.callCount(), 0);
  });

  it("never claims a review card was posted when a retry skipped it", () => {
    const base = { cutId: "f_test01:s04:v1", version: 1, title: "PLACEHOLDER FILM · §04 · v1" };
    const skipped = describeFlush({
      cuts: [{ ...base, uploaded: true, cardPosted: false, marked: true }],
      error: null,
    });
    assert.match(skipped, /preview posted; no new review card/);
    assert.doesNotMatch(skipped, /preview and review card posted/);

    const failedAgain = describeFlush({
      cuts: [{ ...base, uploaded: false, cardPosted: false, marked: false }],
      error: null,
    });
    assert.match(failedAgain, /did not upload again; no new review card was posted/);

    const fresh = describeFlush({
      cuts: [{ ...base, uploaded: true, cardPosted: true, marked: true }],
      error: null,
    });
    assert.match(fresh, /preview and review card posted\./);
  });

  it("reports an unreachable VETTU to the model without claiming a post", async () => {
    const post = mock.fn(async () => ({ id: "m1" }));
    const tool = createPostLatestCutTool({
      web: createWebClient({
        baseUrl: "http://127.0.0.1:3100",
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    });
    const result = await tool.handler({}, stubContext({ post, postFile: mock.fn() }));
    assert.match(String(result), /Could not read VETTU's review queue: VETTU is not reachable\./);
    assert.match(String(result), /Nothing was posted/);
    assert.equal(post.mock.callCount(), 0);
  });
});
