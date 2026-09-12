/**
 * Card tests.
 *
 * `renderToIR` lowers a Channels JSX tree to the platform-neutral IR the adapter
 * is handed, so these run with no Slack app, no Intelligence project and no
 * credentials of any kind.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToIR } from "@copilotkit/channels";
import { ACCENT, approvedCard, changesRecordedCard, notesRequestedCard } from "./components";
import { reviewCards } from "./review";
import { createWebClient } from "./web";

/** The rendered IR as a searchable string. */
async function render(node: unknown): Promise<string> {
  return JSON.stringify(renderToIR((await node) as never));
}

const offline = createWebClient({
  baseUrl: "http://127.0.0.1:3100",
  fetch: async () => {
    throw new TypeError("offline");
  },
});
const { ReviewCard, KickoffCard } = reviewCards({ web: offline });

describe("review card", () => {
  it("names the cut and its version and offers Approve and Request changes", async () => {
    const out = await render(
      ReviewCard({ cutId: "f_test01:s02:v3", version: 3, title: "PLACEHOLDER FILM · §02 · v3" }),
    );
    assert.ok(out.includes("PLACEHOLDER FILM · §02 · v3"));
    assert.ok(out.includes("v3"));
    assert.ok(out.includes("Approve"));
    assert.ok(out.includes("Request changes"));
    assert.ok(out.includes(ACCENT.review));
  });

  it("says in words that a click records a decision and publishes nothing", async () => {
    const out = await render(ReviewCard({ cutId: "f_test01:s02:v1", version: 1, title: "T" }));
    assert.ok(out.includes("Nothing here renders or publishes anything"));
  });
});

describe("decision cards", () => {
  it("an approval names the reviewer, in words and colour", async () => {
    const out = await render(approvedCard({ title: "T", version: 2, reviewer: "Ada" }));
    assert.ok(out.includes("Approved by Ada"));
    assert.ok(out.includes("v2"));
    assert.ok(out.includes(ACCENT.approved));
  });

  it("a change request asks for the change as a reply in the thread", async () => {
    const out = await render(notesRequestedCard({ title: "T", version: 2, reviewer: "Ada" }));
    assert.ok(out.includes("Changes requested by Ada"));
    assert.ok(out.includes("Reply in this thread with the change"));
    assert.ok(out.includes(ACCENT.changes));
    assert.ok(!out.includes("Approve"), "a settled card carries no buttons");
  });

  it("a change request whose note is filed invites no reply", async () => {
    const out = await render(changesRecordedCard({ title: "T", version: 2, reviewer: "Ada" }));
    assert.ok(out.includes("Changes requested by Ada"));
    assert.ok(!out.includes("Reply in this thread"));
    assert.ok(out.includes(ACCENT.changes));
    assert.ok(!out.includes("Approve"), "a settled card carries no buttons");
  });
});

describe("kickoff card", () => {
  it("carries the Post latest cut button", async () => {
    const out = await render(KickoffCard());
    assert.ok(out.includes("VETTU review thread"));
    assert.ok(out.includes("Post latest cut"));
  });
});
