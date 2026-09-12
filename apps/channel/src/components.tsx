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

export interface DecisionCardProps {
  title: string;
  version: number;
  reviewer: string;
}

/** What an Approve click turns the review card into. */
export function approvedCard({ title, version, reviewer }: DecisionCardProps) {
  return (
    <Message accent={ACCENT.approved}>
      <Header>{title}</Header>
      <Fields>
        <Field label="Decision">{`Approved by ${reviewer}`}</Field>
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
        <Field label="Decision">{`Changes requested by ${reviewer}`}</Field>
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
        <Field label="Decision">{`Changes requested by ${reviewer}`}</Field>
        <Field label="Version">{`v${version}`}</Field>
      </Fields>
      <Section>
        <Markdown>Reply in this thread with the change.</Markdown>
      </Section>
      <Context>The next reply in this thread is filed in VETTU as the change order for this cut.</Context>
    </Message>
  );
}
