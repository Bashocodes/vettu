import { createChannel } from "@copilotkit/channels";
import { makeChannelAgent } from "./agent";
import { required } from "./env";
import { registerReviewThread } from "./review";
import { postLatestCut, readThread } from "./tools";

// Fail at startup, not on the first Slack event: the review thread pulls
// VETTU's queue from this loopback origin (e.g. http://127.0.0.1:3100).
required("VETTU_WEB_URL");

export const channel = createChannel({
  // Must equal the Channel Code in Intelligence, character for character. A
  // mismatch leaves the Channel at "Waiting for runtime" and is validated at
  // startup, not here.
  name: required("CHANNEL_CODE"),

  // Required. "platform" derives the canonical user from provider + workspace +
  // platform user id. Do NOT move this onto CopilotRuntime — that one is for
  // web requests and must be absent on a Channels-only runtime.
  identifyUser: "platform",

  agent: makeChannelAgent,
  tools: [readThread, postLatestCut],

  // Managed Slack hides tool steps by default; show them so a reviewer sees
  // "post_latest_cut" working instead of a silent pause.
  showToolStatus: true,

  // Injected into the agent's prompt on every run.
  context: [
    {
      description: "VETTU review",
      value:
        "VETTU posts approved cuts of a film section here; reviewers approve or request changes; you answer questions about the cut and never approve on anyone's behalf.",
    },
    {
      description: "Surface",
      value:
        "This is a Slack review thread. Several reviewers may be reading and some joined late. Each cut arrives as a 540p preview video followed by a review card; a decision shows as that card changing to Approved, or to a request for a reply with the change.",
    },
  ],
});

// Mention → subscribe → pull the queue → kickoff card. Subscribed replies file
// an awaited change note or let the agent answer. Welcome → kickoff card.
registerReviewThread(channel);
