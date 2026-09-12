/**
 * The VETTU review thread (KIT_CHANNEL §7).
 *
 * VETTU (the web app) only queues approved cuts. Nothing can post into a Slack
 * thread proactively, so every Slack event in the review thread pulls the queue:
 * the 540p preview, the poster frame, then a review card with Approve and
 * Request changes. A click records a decision in VETTU; it never renders,
 * publishes or resumes the agent.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  Message,
  Header,
  Section,
  Markdown,
  Fields,
  Field,
  Context,
  Actions,
  Button,
} from "@copilotkit/channels";
import type {
  Channel,
  ChannelMessage,
  InteractionContext,
  ProviderActor,
  Thread,
} from "@copilotkit/channels";
import {
  ACCENT,
  KICKOFF_TEXT,
  KICKOFF_TITLE,
  REVIEW_CARD_NOTE,
  approvedCard,
  changesRecordedCard,
  notesRequestedCard,
  reviewerName,
} from "./components";
import {
  reviewThreadState,
  type ReviewDecision,
  type ReviewQueueItem,
  type ReviewThreadState,
} from "./review-types";
import { WebError, web, type WebClient } from "./web";

export interface ReviewDeps {
  web: WebClient;
}

const defaultDeps: ReviewDeps = { web };

/**
 * This listener process. The review cards it posts have live buttons; after a
 * restart those buttons are dead, so a new process may post a fresh card.
 */
const LISTENER_BOOT = randomUUID();

/** Per-thread state as a review flow uses it. Handler, click and tool threads all fit. */
export interface ReviewStateThread {
  state(): Promise<unknown>;
  setState(value: ReviewThreadState): Promise<void>;
}

/** What a flush needs from a thread. A handler's, a click's and a tool's thread all fit. */
export interface ReviewPostTarget extends Pick<Thread, "post" | "postFile">, ReviewStateThread {}

export interface FlushedCut {
  cutId: string;
  version: number;
  title: string;
  /** The 540p preview reached Slack. */
  uploaded: boolean;
  /** A review card was posted by this flush (false when the thread already has one, or the cut is decided). */
  cardPosted: boolean;
  /** VETTU recorded the cut as posted (only when uploaded and a card is in the thread). */
  marked: boolean;
}

export interface FlushResult {
  cuts: FlushedCut[];
  /** A controlled sentence when VETTU could not be read or updated. */
  error: string | null;
}

export interface FlushOptions {
  /** Say so in the thread when nothing is queued (the kickoff button). */
  announceEmpty?: boolean;
  /** Say so in the thread when VETTU cannot be reached. */
  announceErrors?: boolean;
}

/** Largest local file the channel will read and upload. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Pull VETTU's review queue into this thread. For each cut: post the preview
 * (and the poster when there is one), post its review card, and only then mark
 * it posted. A cut whose preview did not upload keeps its card but stays queued,
 * so the next Slack event retries the video.
 *
 * A retry never posts a second card for a cut this process already carded in
 * this thread, or one already decided here: a second card with the same props
 * mints the same button ids and would take over the first card's handlers.
 */
export async function flushReviewQueue(
  thread: ReviewPostTarget,
  deps: ReviewDeps = defaultDeps,
  options: FlushOptions = {},
): Promise<FlushResult> {
  const { ReviewCard } = reviewCards(deps);
  const result: FlushResult = { cuts: [], error: null };
  let queue: ReviewQueueItem[];
  try {
    queue = await deps.web.getQueue();
  } catch (error) {
    result.error = webMessage(error);
    if (options.announceErrors) await thread.post(`Could not pull VETTU's review queue: ${result.error}`);
    return result;
  }
  if (queue.length === 0) {
    if (options.announceEmpty) await thread.post("No approved cuts are waiting for review.");
    return result;
  }
  const known = await readStateOrEmpty(thread);
  for (const item of queue) {
    const hasCard =
      Boolean(known.decided?.[item.cutId]) || known.carded?.[item.cutId] === LISTENER_BOOT;
    const uploaded = await postPreview(thread, item, { withPoster: !hasCard });
    const cut: FlushedCut = {
      cutId: item.cutId,
      version: item.version,
      title: item.title,
      uploaded,
      cardPosted: false,
      marked: false,
    };
    result.cuts.push(cut);
    if (!hasCard) {
      // A component element, not a pre-rendered tree: see reviewCards().
      await thread.post(<ReviewCard cutId={item.cutId} version={item.version} title={item.title} />);
      cut.cardPosted = true;
      try {
        await updateState(thread, (prev) => ({
          ...prev,
          carded: { ...prev.carded, [item.cutId]: LISTENER_BOOT },
        }));
      } catch {
        console.warn(`[vettu-review] could not note the review card for ${item.cutId} in thread state`);
      }
    }
    if (!uploaded) continue;
    try {
      await deps.web.markPosted(item.cutId);
      cut.marked = true;
    } catch (error) {
      result.error = webMessage(error);
      console.warn(`[vettu-review] ${item.cutId} is in Slack but VETTU did not record it as posted`);
    }
  }
  return result;
}

/** The sentence a tool hands back to the model after a flush. */
export function describeFlush(result: FlushResult): string {
  if (result.cuts.length === 0) {
    return result.error
      ? `Could not read VETTU's review queue: ${result.error} Nothing was posted.`
      : "No approved cuts are waiting for review. Nothing was posted.";
  }
  const lines = result.cuts.map((cut) => {
    if (!cut.uploaded) {
      return cut.cardPosted
        ? `${cut.title}: the preview video did not upload; its review card is posted, and VETTU retries the video only on the next event in this thread.`
        : `${cut.title}: the preview video did not upload again; no new review card was posted because this thread already has its card or its decision, and VETTU retries the video on the next event in this thread.`;
    }
    const posted = cut.cardPosted
      ? "preview and review card posted"
      : "preview posted; no new review card, because this thread already has its card or its decision";
    return `${cut.title}: ${posted}${cut.marked ? "" : " (VETTU did not record it as posted, so it may be posted again)"}.`;
  });
  return `Pulled ${result.cuts.length} cut(s) for review. ${lines.join(" ")} Reviewers decide with the card buttons.`;
}

export interface ReviewCardProps {
  cutId: string;
  version: number;
  title: string;
}

/**
 * The review card and the kickoff card, bound to their dependencies.
 *
 * Both are posted as component elements (`<ReviewCard …/>`), never as trees
 * rendered up front. The SDK mints an inline tree's action ids from the tree
 * path alone, so two review cards of the same shape would share ids and a click
 * on one card would run the other card's handler. A component element hashes
 * its props (the cutId) into the ids. Props therefore stay plain JSON; the
 * dependencies are closed over here instead.
 */
export function reviewCards(deps: ReviewDeps = defaultDeps) {
  function ReviewCard({ cutId, version, title }: ReviewCardProps) {
    // The SDK keeps both buttons' handlers after the card is replaced, and
    // duplicate or opposite clicks still dispatch. Queue clicks and settle only
    // after a successful update: the first decision wins, a failed one stays
    // retryable. The in-memory latch covers repeat clicks on this card; the
    // thread's recorded decision covers any other card for the same cut.
    let settled = false;
    let previous: Promise<void> = Promise.resolve();
    const decide = (kind: "approve" | "changes", ctx: InteractionContext<string>) => {
      const report = async () => {
        if (settled) return;
        let known: ReviewThreadState;
        try {
          known = await readState(ctx.thread);
        } catch {
          await ctx.thread.post(`VETTU could not check earlier decisions on v${version} in this thread. Click again.`);
          return;
        }
        const prior = known.decided?.[cutId];
        if (prior) {
          // Decided on another card: show that decision here and file nothing.
          await ctx.thread.update(ctx.message.ref, settledCard(prior, known, { cutId, title, version }));
          settled = true;
          return;
        }
        const reviewer = reviewerOf(ctx.actor);
        if (kind === "approve") {
          try {
            await deps.web.postChangeOrder({
              idempotencyKey: idempotencyKey(`${ctx.message.ref.id}:${cutId}`),
              cutId,
              kind: "approve",
              reviewer,
              source: "button",
            });
          } catch (error) {
            await ctx.thread.post(
              `VETTU could not record the approval of v${version}: ${webMessage(error)} Click Approve again.`,
            );
            return;
          }
          try {
            await updateState(ctx.thread, (prev) =>
              withDecision(prev, cutId, { kind: "approve", reviewer: reviewer.name }),
            );
          } catch {
            console.warn(`[vettu-review] the approval of ${cutId} is filed but not noted in thread state`);
          }
          // Use the interaction's thread, whose delivery is live now.
          await ctx.thread.update(ctx.message.ref, approvedCard({ title, version, reviewer: reviewer.name }));
        } else {
          const decision: ReviewDecision = { kind: "changes", reviewer: reviewer.name };
          const next = await updateState(ctx.thread, (prev) =>
            prev.decided?.[cutId]
              ? prev
              : { ...withDecision(prev, cutId, decision), awaitingNotesFor: cutId, awaitingTitle: title },
          );
          const recorded = next.decided?.[cutId];
          if (recorded && recorded !== decision) {
            // Another card for this cut was decided between the check and the write.
            await ctx.thread.update(ctx.message.ref, settledCard(recorded, next, { cutId, title, version }));
            settled = true;
            return;
          }
          // The note is a plain reply; a thread first reached through the welcome
          // kickoff was never @-mentioned, so subscribe here for the replies after it.
          await ctx.thread.subscribe();
          await ctx.thread.update(
            ctx.message.ref,
            notesRequestedCard({ title, version, reviewer: reviewer.name }),
          );
        }
        settled = true;
      };
      previous = previous.then(report, report);
      return previous;
    };
    return (
      <Message accent={ACCENT.review}>
        <Header>{title}</Header>
        <Fields>
          <Field label="Version">{`v${version}`}</Field>
          <Field label="Status">Waiting for review</Field>
        </Fields>
        <Context>{REVIEW_CARD_NOTE}</Context>
        <Actions>
          <Button
            value="approve"
            style="primary"
            onClick={async (ctx) => {
              await decide("approve", ctx);
            }}
          >
            Approve
          </Button>
          <Button
            value="changes"
            style="danger"
            onClick={async (ctx) => {
              await decide("changes", ctx);
            }}
          >
            Request changes
          </Button>
        </Actions>
      </Message>
    );
  }

  function KickoffCard() {
    return (
      <Message accent={ACCENT.review}>
        <Header>{KICKOFF_TITLE}</Header>
        <Section>
          <Markdown>{KICKOFF_TEXT}</Markdown>
        </Section>
        <Actions>
          <Button
            value="post_latest_cut"
            style="primary"
            onClick={async (ctx) => {
              // The welcome card lands in a thread nobody @-mentioned: subscribe
              // so reviewers' replies after the posted cut reach this listener.
              await ctx.thread.subscribe();
              await flushReviewQueue(ctx.thread, deps, { announceEmpty: true, announceErrors: true });
            }}
          >
            Post latest cut
          </Button>
        </Actions>
      </Message>
    );
  }

  return { ReviewCard, KickoffCard };
}

export const { ReviewCard, KickoffCard } = reviewCards();

/**
 * Wire the review thread onto a Channel: mention → subscribe → pull the queue →
 * kickoff card (once per thread); human replies → file an awaited change note,
 * else (subscribed threads only) pull the queue and let the agent answer;
 * welcome → kickoff card (once per thread).
 */
export function registerReviewThread(channel: Channel, deps: ReviewDeps = defaultDeps): void {
  const { KickoffCard } = reviewCards(deps);

  channel.onMention(async ({ thread, message }) => {
    await thread.subscribe();
    // Mentioned turns reach only onMention, so a change note that @-mentions
    // the bot must be filed here too, or it would be silently dropped.
    if (isHumanCreated(message) && (await fileAwaitedNote(thread, message, deps))) return;
    await flushReviewQueue(thread, deps, { announceErrors: true });
    // Every mention pulls the queue; only a thread without one gets the kickoff card.
    if (await claimKickoff(thread)) await thread.post(<KickoffCard />);
  });

  // Non-mentioned turns only ever reach onMessage. Bots (including our own
  // posts), apps, edits and deletes never trigger work.
  channel.onMessage(async ({ thread, message }) => {
    if (!isHumanCreated(message)) return;
    // An awaited note comes before the subscription gate. Awaiting state is
    // keyed by this very thread and only a Request changes click writes it, so
    // its presence already proves this is a review thread.
    // A change note is filed and nothing else: the agent does not also answer it.
    if (await fileAwaitedNote(thread, message, deps)) return;
    if (!(await thread.isSubscribed())) return;
    await flushReviewQueue(thread, deps);
    await thread.runAgent();
  });

  channel.onWelcome(async ({ thread }) => {
    if (await claimKickoff(thread)) await thread.post(<KickoffCard />);
  });
}

/** When Request changes is awaiting a note in this thread, file this message as it. */
async function fileAwaitedNote(
  thread: Pick<Thread, "post"> & ReviewStateThread,
  message: ChannelMessage,
  deps: ReviewDeps,
): Promise<boolean> {
  // Unreadable state counts as "not awaiting": most messages reaching here are
  // ordinary chatter, and a failure must not post an error into them.
  const state = await readStateOrEmpty(thread);
  const cutId = state.awaitingNotesFor;
  if (!cutId) return false;
  const label = state.awaitingTitle || cutId;
  const text = noteText(message.text);
  if (!text) {
    await thread.post(`Reply with the change for ${label} in words, and VETTU files it as a change order.`);
    return true;
  }
  const reviewer = reviewerOf(message.actor);
  try {
    await deps.web.postChangeOrder({
      idempotencyKey: idempotencyKey(message.eventId || message.ref.id || `${reviewer.id}:${cutId}:${text}`),
      cutId,
      kind: "changes",
      text,
      reviewer,
      source: "reply",
    });
  } catch (error) {
    await thread.post(`VETTU could not file that change order: ${webMessage(error)} Reply again to retry.`);
    return true;
  }
  try {
    // Clear only this cut's note; keep every recorded decision and card.
    await updateState(thread, (prev) => (prev.awaitingNotesFor === cutId ? withoutAwaiting(prev) : prev));
  } catch {
    console.warn(`[vettu-review] the change order for ${cutId} is filed but its note is still marked as awaited`);
  }
  await thread.post(`Change order filed for ${label}.`);
  return true;
}

// ── thread state ─────────────────────────────────────────────────────────────

/** Stored state, checked. Malformed state counts as empty. Throws when unreadable. */
async function readState(thread: ReviewStateThread): Promise<ReviewThreadState> {
  const parsed = reviewThreadState.safeParse((await thread.state()) ?? {});
  return parsed.success ? parsed.data : {};
}

async function readStateOrEmpty(thread: ReviewStateThread): Promise<ReviewThreadState> {
  try {
    return await readState(thread);
  } catch {
    return {};
  }
}

/**
 * Every state write in this process runs one at a time, and each derives its
 * patch from a fresh read inside the queue. A flush noting its card can then
 * never wipe a click's awaited note, and the reverse. The queue holds only a
 * state read and a state write, never an upload.
 */
let stateWrites: Promise<unknown> = Promise.resolve();

function updateState(
  thread: ReviewStateThread,
  change: (prev: ReviewThreadState) => ReviewThreadState,
): Promise<ReviewThreadState> {
  const run = async () => {
    const next = change(await readState(thread));
    await thread.setState(next);
    return next;
  };
  const done = stateWrites.then(run, run);
  stateWrites = done.catch(() => undefined);
  return done;
}

/** Record a decision unless the cut already has one: the first decision stays. */
function withDecision(prev: ReviewThreadState, cutId: string, decision: ReviewDecision): ReviewThreadState {
  if (prev.decided?.[cutId]) return prev;
  return { ...prev, decided: { ...prev.decided, [cutId]: decision } };
}

function withoutAwaiting(prev: ReviewThreadState): ReviewThreadState {
  const next: ReviewThreadState = {};
  if (prev.decided) next.decided = prev.decided;
  if (prev.carded) next.carded = prev.carded;
  if (prev.kickoffPosted) next.kickoffPosted = prev.kickoffPosted;
  return next;
}

/**
 * Claim this thread's one kickoff card: true when it has none yet. The check and
 * the write run in the state queue, so two quick mentions cannot both post one.
 * Unreadable state posts the card as before, so no thread is left without one.
 */
async function claimKickoff(thread: ReviewStateThread): Promise<boolean> {
  const seen: { posted: boolean | null } = { posted: null };
  try {
    await updateState(thread, (prev) => {
      seen.posted = prev.kickoffPosted === true;
      return seen.posted ? prev : { ...prev, kickoffPosted: true };
    });
  } catch {
    console.warn("[vettu-review] could not note the kickoff card in thread state");
  }
  return seen.posted !== true;
}

/** The settled card for a decision made earlier, on another card for the same cut. */
function settledCard(prior: ReviewDecision, known: ReviewThreadState, cut: ReviewCardProps) {
  const props = { title: cut.title, version: cut.version, reviewer: prior.reviewer };
  if (prior.kind === "approve") return approvedCard(props);
  // Only invite a reply while that reply would still become the change order.
  return known.awaitingNotesFor === cut.cutId ? notesRequestedCard(props) : changesRecordedCard(props);
}

// ── files ────────────────────────────────────────────────────────────────────

async function postPreview(
  thread: ReviewPostTarget,
  item: ReviewQueueItem,
  options: { withPoster: boolean },
): Promise<boolean> {
  const stem = fileStem(item.cutId);
  const failed = (reason: string) => thread.post(`Cut v${item.version} rendered, upload failed: ${reason}`);
  let uploaded = false;

  const video = await readLocalFile(item.previewPath, ".mp4");
  if (!video) {
    // Never the fs error: it carries local paths into a shared channel.
    await failed("the preview file could not be read.");
  } else {
    const sent = await sendFile(thread, { bytes: video, filename: `${stem}-540p.mp4`, title: item.title }, item.version);
    if (sent.ok) uploaded = true;
    else await failed(uploadError(sent.error));
  }

  // The poster frame goes up as an image: the fallback when Slack shows the MP4
  // as a plain file. A retry for a cut whose card is already here skips it.
  if (options.withPoster && item.posterPath) {
    const poster = await readLocalFile(item.posterPath, ".png");
    if (poster) {
      const sent = await sendFile(
        thread,
        {
          bytes: poster,
          filename: `${stem}-poster.png`,
          title: `${item.title} · poster`,
          altText: `Poster frame of ${item.title}`,
        },
        item.version,
      );
      if (!sent.ok) console.warn(`[vettu-review] the poster for ${item.cutId} did not upload`);
    }
  }
  return uploaded;
}

async function sendFile(
  thread: ReviewPostTarget,
  args: Parameters<ReviewPostTarget["postFile"]>[0],
  version: number,
) {
  try {
    return await thread.postFile(args);
  } catch (error) {
    // A provider-effect failure seals this delivery and must propagate, so the
    // SDK never reports a false "complete". Say so first, best effort.
    try {
      await thread.post(`Cut v${version} rendered, upload failed: Slack did not confirm the file.`);
    } catch {
      // The delivery is already sealed.
    }
    throw error;
  }
}

async function readLocalFile(path: string, extension: string): Promise<Uint8Array | null> {
  if (!isAbsolute(path) || !path.toLowerCase().endsWith(extension)) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

// ── small helpers ────────────────────────────────────────────────────────────

function isHumanCreated(message: ChannelMessage): boolean {
  return message.actor.kind === "human" && message.operation.kind === "created";
}

/** The platform id, and a name only when the provider gave a real one: never the raw id as the name. */
function reviewerOf(actor: ProviderActor): { id: string; name: string } {
  const id = (actor.id ?? "").slice(0, 200);
  const name = (reviewerName(actor.name) || reviewerName(actor.handle)).slice(0, 200);
  return { id, name };
}

/** The change-order key limit is 300 characters; hash anything longer. */
function idempotencyKey(raw: string): string {
  return raw.length <= 300 ? raw : `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/** The reply text without bot mention tokens, capped at the change-order limit. */
function noteText(text: string): string {
  return text
    .replace(/<@[A-Za-z0-9]+(?:\|[^>]*)?>/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, 4000);
}

function fileStem(cutId: string): string {
  return cutId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "cut";
}

/** The SDK's upload error text, trimmed, with anything path-like removed. */
function uploadError(error: string | undefined): string {
  const text = (error ?? "unknown error")
    .replace(/(?:\/[^\s/]+){2,}/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function webMessage(error: unknown): string {
  return error instanceof WebError ? error.message : "VETTU could not complete that request.";
}
