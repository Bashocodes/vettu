/**
 * The VETTU review assistant's tools.
 *
 * A channel tool handler receives the LIVE thread, so post_latest_cut can post
 * the preview and the review card mid-run. A later click records a decision; it
 * does not resume the agent.
 *
 * The return value is what the *agent* reads back, not what the user sees.
 * Return raw data (it is JSON-stringified for you) or a short natural-language
 * sentence — never `{ ok: true }`, and never hand-stringify.
 */
import { defineChannelTool } from "@copilotkit/channels";
import { z } from "zod";
import { describeFlush, flushReviewQueue, type ReviewDeps } from "./review";

/** Read what reviewers have already said in this thread. */
export const readThread = defineChannelTool({
  name: "read_thread",
  description:
    "Read the recent messages in this review thread: which cuts were posted, which versions are under review, who approved or requested changes, and what they asked for. Call this FIRST on any question about a cut — the thread already says it, and asking a reviewer to repeat a note is the worst thing you can do here.",
  parameters: z.object({}),
  async handler(_args, { thread }) {
    const messages = await thread.getMessages();
    if (messages.length === 0) {
      return "This surface does not expose conversation history, or the thread is empty. Say that you cannot see earlier messages and ask which cut and version the reviewer means.";
    }
    return messages;
  },
});

/** Injection keeps gateway tests independent of a running VETTU web app. */
export function createPostLatestCutTool(deps?: ReviewDeps) {
  return defineChannelTool({
    name: "post_latest_cut",
    description:
      "Post every cut VETTU has approved and queued for review into this thread: its 540p preview video, then a review card with Approve and Request changes buttons. Call it when someone asks for the latest cut. It never approves anything; only reviewers' clicks decide. Report exactly what the result says.",
    parameters: z.object({}),
    async handler(_args, { thread }) {
      const result = await flushReviewQueue(thread, deps);
      return describeFlush(result);
    },
  });
}

/**
 * The path that still works after a listener restart: old cards' buttons are
 * bound in-process and a click on them is silently dropped, but a fresh mention
 * posts a new kickoff card and a subscribed reply reruns the agent, which can
 * call this tool.
 */
export const postLatestCut = createPostLatestCutTool();
