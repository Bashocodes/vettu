"use client";

/**
 * Card grid + card (DESIGN §4.6): 7:3 media box, row one is sacred (X · F · C takes · S pinned
 * right), maker + 7-word caption, EF / other letters, faint cut timecode. Words-only face when
 * there is no media. Also the tab-pane sound and plan rows.
 */
import { useRef, useState } from "react";
import type { BoardCard, BoardSound, BoardTake } from "@/lib/contracts/board-view";
import type { CardKind, CardLetter, Letter } from "@/lib/contracts/film";
import { letterColour, mediaUrl } from "@/lib/contracts/film";
import type { EditChip, InsertedEntry } from "@/lib/board-format";
import { clipWords, ladderClass, rangeText, secsText, splitCode } from "@/lib/board-format";
import { Badge } from "./badge";
import type { LightboxImage } from "./lightbox";

type Letters = Record<string, Letter>;
const MAX_C = 3;
const X_COLOUR = "#f2b53d";

function takeNumber(take: BoardTake): string {
  const c = take.letters.find((l) => l.code === "C");
  if (c) return c.text;
  const tail = take.id.split("/").pop() ?? take.id;
  return tail.replace(/^C/, "");
}

const isEf = (l: CardLetter) => /\bEF\b/.test(l.text);

function CardMedia({
  kind,
  url,
  poster,
  words,
  label,
  inPoint,
  outPoint,
  onOpenImage,
}: {
  kind: CardKind;
  url: string | null;
  poster: string | null;
  words: string;
  label: string;
  inPoint: number;
  outPoint: number | null;
  onOpenImage?: (image: LightboxImage) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  if (!url || kind === "words") {
    return (
      <div className="v-media">
        <div className="v-face">
          {label ? <span>{label}</span> : null}
          {words || "—"}
        </div>
      </div>
    );
  }

  if (kind === "image") {
    return (
      <div className="v-media">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img loading="lazy" src={url} alt={words} onClick={() => onOpenImage?.({ src: url, alt: words })} />
      </div>
    );
  }

  const play = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.currentTime < inPoint || (outPoint !== null && v.currentTime >= outPoint)) v.currentTime = inPoint;
    void v.play().catch(() => undefined);
  };
  const pause = () => videoRef.current?.pause();
  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) play();
    else v.pause();
  };

  return (
    <div className="v-media" onMouseEnter={play} onMouseLeave={pause} onClick={toggle}>
      <video
        ref={videoRef}
        key={url}
        src={url}
        poster={poster ?? undefined}
        preload="none"
        muted
        playsInline
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          if (outPoint !== null && v.currentTime >= outPoint) v.currentTime = inPoint;
        }}
      />
    </div>
  );
}

export function Card({
  card,
  letters,
  chip,
  onOpenImage,
}: {
  card: BoardCard;
  letters: Letters;
  chip?: EditChip;
  onOpenImage?: (image: LightboxImage) => void;
}) {
  const lead = card.takes.find((t) => t.lead) ?? null;
  const [shownId, setShownId] = useState<string | null>(lead?.id ?? null);
  const shown = card.takes.find((t) => t.id === shownId) ?? null;

  const kind = shown ? shown.kind : card.kind;
  const url = shown ? shown.url : card.url;
  const poster = shown ? shown.poster : card.poster;
  const caption = shown ? shown.caption : card.caption;
  const maker = shown ? shown.maker : card.maker;
  const shownLetters = shown ? shown.letters : card.letters;
  const ownMedia = !shown || shown.lead;

  const xLetters = card.letters.filter((l) => l.code === "X");
  const fLetter = card.letters.find((l) => l.code === "F" && !isEf(l)) ?? null;

  // C badges: one per take (clickable) or the card's own C letters.
  let visibleTakes = card.takes;
  let hiddenTakes: BoardTake[] = [];
  if (card.takes.length > MAX_C) {
    visibleTakes = card.takes.slice(0, MAX_C);
    if (shown && !visibleTakes.includes(shown)) visibleTakes = [...card.takes.slice(0, MAX_C - 1), shown];
    hiddenTakes = card.takes.filter((t) => !visibleTakes.includes(t));
  }
  const ownC = card.takes.length === 0 ? card.letters.filter((l) => l.code === "C") : [];

  const pick = (take: BoardTake) => {
    if (shownId === take.id) {
      if (!lead) setShownId(null);
      return;
    }
    setShownId(take.id);
  };

  const extra = shownLetters.filter((l) => isEf(l) || !["F", "C", "X", "S"].includes(l.code));
  const secs = secsText(card.secs);
  const todo = card.status === "todo" || card.status === "candidate" || xLetters.length > 0;
  const tc = card.inCut ? rangeText(card.cutIn, card.cutOut) : null;
  const words = caption || card.caption;

  const cls = ["v-card", todo ? "todo" : "", chip?.change === "removed" ? "removed" : ""].filter(Boolean).join(" ");

  return (
    <figure className={cls} data-card={card.id}>
      <CardMedia
        kind={kind}
        url={url}
        poster={poster}
        words={words}
        label={card.slot !== null ? `S ${card.slot}` : ""}
        inPoint={ownMedia ? card.in : 0}
        outPoint={ownMedia ? card.out : null}
        onOpenImage={onOpenImage}
      />
      <div className="v-cbody">
        <div className="v-row">
          {xLetters.map((l, i) => (
            <Badge key={`x${i}`} code="X" colour={letters.X?.colour ?? X_COLOUR} cells={l.text ? [{ text: l.text }] : []} />
          ))}
          {fLetter ? <Badge code="F" colour={letterColour(letters, "F")} cells={[{ text: fLetter.text }]} /> : null}
          {visibleTakes.map((take) => (
            <Badge
              key={take.id}
              code="C"
              colour={letterColour(letters, "C")}
              cells={[{ text: takeNumber(take) }]}
              on={shown?.id === take.id}
              title={take.caption}
              onClick={() => pick(take)}
            />
          ))}
          {hiddenTakes.length > 0 ? (
            <Badge
              more
              cells={[{ text: `+${hiddenTakes.length}` }]}
              title={hiddenTakes.map((t) => `C ${takeNumber(t)}`).join(" · ")}
              onClick={() => {
                const next = hiddenTakes[0];
                if (next) setShownId(next.id);
              }}
            />
          ) : null}
          {ownC.map((l, i) => (
            <Badge
              key={`c${i}`}
              code="C"
              colour={letterColour(letters, "C")}
              cells={[{ text: l.text }]}
              on={card.kind === "clip" && ownC.length === 1}
            />
          ))}
          {card.slot !== null ? (
            <Badge
              code="S"
              className="s-badge"
              ladder={ladderClass(todo ? "placed" : card.status)}
              cells={secs ? [{ text: String(card.slot) }, { text: secs, kind: "t" }] : [{ text: String(card.slot) }]}
            />
          ) : null}
        </div>

        {words ? (
          <div className="v-row">
            <Badge
              code={maker}
              colour={maker ? (maker === "X" ? letters.X?.colour ?? X_COLOUR : letterColour(letters, maker)) : undefined}
              className="cap"
              cells={[{ text: clipWords(words), kind: "w" }]}
              title={words}
            />
          </div>
        ) : null}

        {extra.length > 0 ? (
          <div className="v-row">
            {extra.map((l, i) => (
              <Badge key={`e${i}`} code={l.code} colour={letterColour(letters, l.code)} cells={[{ text: l.text }]} />
            ))}
          </div>
        ) : null}

        {chip ? (
          <div className="v-row">
            <Badge className="edit" cells={[{ text: chip.text }]} title="YOUR EDIT — the film of record is unchanged" />
          </div>
        ) : null}

        <div className="v-foot">{tc ? <span className="v-tc">{tc}</span> : null}</div>
      </div>
    </figure>
  );
}

export function InsertedCard({
  item,
  onOpenImage,
}: {
  item: InsertedEntry;
  onOpenImage?: (image: LightboxImage) => void;
}) {
  const video = mediaUrl(item.insert?.video ?? null);
  const still = mediaUrl(item.insert?.still ?? null);
  const words = item.insert?.prompt ?? "a new shot";
  const secs = secsText(Math.max(0, item.entry.out - item.entry.in));
  return (
    <figure className="v-card todo" data-card={item.entry.ref}>
      <CardMedia
        kind={video ? "clip" : still ? "image" : "words"}
        url={video ?? still}
        poster={still}
        words={words}
        label="NOT YET"
        inPoint={0}
        outPoint={null}
        onOpenImage={onOpenImage}
      />
      <div className="v-cbody">
        <div className="v-row">
          <Badge className="edit" cells={[{ text: item.text }]} />
          {item.insert ? <Badge cells={[{ text: item.insert.status.toUpperCase() }]} /> : null}
          {secs ? <Badge className="s-badge" cells={[{ text: secs }]} /> : null}
        </div>
        <div className="v-row">
          <Badge className="cap" cells={[{ text: clipWords(words), kind: "w" }]} title={words} />
        </div>
        <div className="v-foot" />
      </div>
    </figure>
  );
}

export function CardGrid({
  cards,
  letters,
  chips = {},
  inserted = [],
  onOpenImage,
  emptyText = "No cards yet.",
}: {
  cards: BoardCard[];
  letters: Letters;
  chips?: Record<string, EditChip>;
  inserted?: InsertedEntry[];
  onOpenImage?: (image: LightboxImage) => void;
  emptyText?: string;
}) {
  if (cards.length === 0 && inserted.length === 0) return <p className="v-empty">{emptyText}</p>;
  return (
    <div className="v-grid">
      {cards.map((card) => (
        <Card
          key={card.id}
          card={card}
          letters={letters}
          chip={card.slot !== null ? chips[`S${card.slot}`] : undefined}
          onOpenImage={onOpenImage}
        />
      ))}
      {inserted.map((item) => (
        <InsertedCard key={item.entry.id} item={item} onOpenImage={onOpenImage} />
      ))}
    </div>
  );
}

export function SoundRows({ sounds, letters }: { sounds: BoardSound[]; letters: Letters }) {
  if (sounds.length === 0) return <p className="v-empty">Nothing here yet.</p>;
  return (
    <div className="v-sounds">
      {sounds.map((sound) => {
        const { letter, rest } = splitCode(sound.code);
        return (
          <div className="v-sound" key={sound.id}>
            <Badge code={letter} colour={letterColour(letters, letter)} cells={rest ? [{ text: rest }] : []} />
            <span className="v-sound-name">{sound.name}</span>
            {sound.selected ? <Badge cells={[{ text: "SELECTED" }]} /> : null}
            {sound.url ? <audio controls preload="none" src={sound.url} /> : null}
          </div>
        );
      })}
    </div>
  );
}

export function PlanRows({ plans }: { plans: { id: string; title: string }[] }) {
  if (plans.length === 0) return <p className="v-empty">No plans yet.</p>;
  return (
    <div className="v-plans">
      {plans.map((plan) => (
        <div className="v-plan" key={plan.id}>
          <Badge cells={[{ text: "PLAN" }]} />
          <span>{plan.title}</span>
        </div>
      ))}
    </div>
  );
}
