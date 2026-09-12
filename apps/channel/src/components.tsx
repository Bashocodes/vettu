/**
 * VETTU copy for the Slack review thread.
 *
 * The interactive cards (review card, kickoff card) live in review.tsx because
 * their buttons carry handlers. This file holds the words and the settled
 * decision cards a click replaces a review card with.
 *
 * One tree renders as Slack Block Kit; a surface that cannot render a node
 * skips it rather than failing.
 */
import { Message, Header, Section, Markdown, Fields, Field, Context } from "@copilotkit/channels";

/** Colour rail by state — always paired with words, never colour alone. */
export const ACCENT = {
  review: "#C8A05C",
  approved: "#35D492",
  changes: "#E07A5F",
} as const;

export const KICKOFF_TITLE = "VETTU review thread";

export const KICKOFF_TEXT =
  "Cuts approved in VETTU land in this thread: a 540p preview, then a card to *Approve* or *Request changes*. " +
  "After *Request changes*, reply here with the change in one message and VETTU files it as a change order.\n\n" +
  "Just approved a cut in VETTU? Click *Post latest cut*.";

export const REVIEW_CARD_NOTE =
  "Approve records your decision in VETTU. Request changes asks for your note as a reply in this thread. " +
  "Nothing here renders or publishes anything.";

/** A Slack user, workspace user or bot id (U…, W…, B…): never a name to show people. */
const PLATFORM_ID = /^[UWB][A-Z0-9]{8,}$/;

/**
 * The reviewer's name as shown, or "" when there is none. A value that is only a
 * platform id counts as none, so no card reads "by U0…" — decisions stored in
 * thread state before this rule pass through here too.
 */
export function reviewerName(value: string | null | undefined): string {
  const name = (value ?? "").trim();
  return name && !PLATFORM_ID.test(name) ? name : "";
}

/** "Approved by Ada", or just "Approved" when the reviewer has no name to show. */
function decidedBy(decision: string, reviewer: string): string {
  const name = reviewerName(reviewer);
  return name ? `${decision} by ${name}` : decision;
}

export interface DecisionCardProps {
  title: string;
  version: number;
  /** Display name; "" or a bare platform id shows the decision without a name. */
  reviewer: string;
}

/** What an Approve click turns the review card into. */
export function approvedCard({ title, version, reviewer }: DecisionCardProps) {
  return (
    <Message accent={ACCENT.approved}>
      <Header>{title}</Header>
      <Fields>
        <Field label="Decision">{decidedBy("Approved", reviewer)}</Field>
        <Field label="Version">{`v${version}`}</Field>
      </Fields>
      <Context>Recorded in VETTU as an approval.</Context>
    </Message>
  );
}

/**
 * A change request whose note is already filed (or no longer awaited). No
 * reply prompt: a reply now would not become a change order.
 */
export function changesRecordedCard({ title, version, reviewer }: DecisionCardProps) {
  return (
    <Message accent={ACCENT.changes}>
      <Header>{title}</Header>
      <Fields>
        <Field label="Decision">{decidedBy("Changes requested", reviewer)}</Field>
        <Field label="Version">{`v${version}`}</Field>
      </Fields>
      <Context>Recorded in VETTU as a change request for this cut.</Context>
    </Message>
  );
}

/** What a Request changes click turns the review card into. */
export function notesRequestedCard({ title, version, reviewer }: DecisionCardProps) {
  return (
    <Message accent={ACCENT.changes}>
      <Header>{title}</Header>
      <Fields>
        <Field label="Decision">{decidedBy("Changes requested", reviewer)}</Field>
        <Field label="Version">{`v${version}`}</Field>
      </Fields>
      <Section>
        <Markdown>Reply in this thread with the change.</Markdown>
      </Section>
      <Context>The next reply in this thread is filed in VETTU as the change order for this cut.</Context>
    </Message>
  );
}
