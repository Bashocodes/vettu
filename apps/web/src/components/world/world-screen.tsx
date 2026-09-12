"use client";

/**
 * WORLD (`/world?film=<id>`, DESIGN §4.7): film bar (WORLD on) · doctag · family row · member row ·
 * tabs `LABEL filled/total` · slot cards by ratio · lightbox. Label + image only.
 */
import "@/styles/vettu-board.css";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FilmBar } from "@/components/board/film-bar";
import { Badge } from "@/components/board/badge";
import { Lightbox } from "@/components/board/lightbox";
import type { LightboxImage } from "@/components/board/lightbox";
import { api, ApiError } from "@/lib/api-client";
import type { Letter } from "@/lib/contracts/film";
import { WORLD_FAMILIES } from "@/lib/contracts/world-view";
import type { WorldFamily, WorldViewCard, WorldViewMember } from "@/lib/contracts/world-view";
import { useFilm, useWorld } from "@/lib/use-film";

const X_COLOUR = "#f2b53d";
const FAMILY_WORD: Record<WorldFamily, string> = {
  CAST: "the cast",
  LOCATIONS: "the locations",
  PROPS: "the props",
};

function parseAr(ar: string | null): [number, number] {
  const m = /^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/.exec(ar ?? "");
  if (!m) return [7, 3];
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? [w, h] : [7, 3];
}

/** Slot heights (DESIGN §4.7): tall 280 (portrait + 21:9 wide) · square 117 (two stack = one tall) · 7:3 and the rest 206. */
function slotHeight(ar: string | null): number {
  const [w, h] = parseAr(ar);
  if (w === h) return 117;
  if (w < h) return 280;
  return (ar ?? "").replace(/\s/g, "") === "21:9" ? 280 : 206;
}

/** Consecutive squares stack two to a column, like the reference cast page. */
function stackSquares(cards: WorldViewCard[]): WorldViewCard[][] {
  const out: WorldViewCard[][] = [];
  for (const card of cards) {
    const last = out[out.length - 1];
    const square = slotHeight(card.ar) === 117;
    if (square && last && last.length === 1 && slotHeight(last[0]!.ar) === 117) last.push(card);
    else out.push([card]);
  }
  return out;
}

function SlotCard({
  card,
  letters,
  memberColour,
  onOpen,
}: {
  card: WorldViewCard;
  letters: Record<string, Letter>;
  memberColour: string | null;
  onOpen(image: LightboxImage): void;
}) {
  const [w, h] = parseAr(card.ar);
  const ratio = w / h;
  const height = slotHeight(card.ar);
  const width = Math.round(height * ratio);
  const shapeH = 8;
  const shapeW = Math.max(5, Math.min(22, Math.round(shapeH * ratio)));
  const code = card.todo ? "X" : card.code;
  const colour = card.todo
    ? letters.X?.colour ?? X_COLOUR
    : card.code
      ? letters[card.code]?.colour ?? memberColour ?? "#85828e"
      : undefined;

  return (
    <figure className={`v-cc${card.todo ? " todo" : ""}${height === 117 ? " sm" : ""}`} style={{ width }} data-world-card={card.id}>
      <div className="v-cc-media" style={{ aspectRatio: `${w} / ${h}` }}>
        {card.img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.img} alt={card.label} loading="lazy" onClick={() => onOpen({ src: card.img ?? "", alt: card.label })} />
        ) : (
          <div className="v-xbox">{card.label}</div>
        )}
      </div>
      <figcaption className="v-cc-bar">
        <Badge code={code} colour={colour} className="cap" cells={[{ text: card.label, kind: "w" }]} title={card.label} />
        {card.ar ? (
          <span className="v-ratio">
            <i className="v-shape" style={{ width: shapeW, height: shapeH }} />
            {card.ar}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

export function WorldScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const filmId = params.get("film");
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    if (filmId) return;
    let alive = true;
    api.films
      .list()
      .then(({ films }) => {
        const first = films[0];
        if (alive && first) router.replace(`/world?film=${encodeURIComponent(first.id)}`);
      })
      .catch((e) => {
        if (alive) setPickError(e instanceof ApiError ? e.message : "Could not list the films.");
      });
    return () => {
      alive = false;
    };
  }, [filmId, router]);

  const { board, refresh } = useFilm(filmId, { timeline: false });
  const { world, loading, error } = useWorld(filmId);
  const [family, setFamily] = useState<WorldFamily>("CAST");
  const [memberCode, setMemberCode] = useState<string | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const closeLightbox = useCallback(() => setLightbox(null), []);

  const filmName = world?.film ?? board?.film ?? null;
  useEffect(() => {
    if (filmName) document.title = `${filmName} · THE WORLD — VETTU`;
  }, [filmName]);

  const families = world?.family?.length ? world.family : [...WORLD_FAMILIES];
  const members: WorldViewMember[] = world
    ? family === "CAST"
      ? world.cast
      : family === "LOCATIONS"
        ? world.locations
        : world.props
    : [];
  const member = members.find((m) => m.code === memberCode) ?? members[0] ?? null;
  const tab = member?.tabs.find((t) => t.id === tabId) ?? member?.tabs[0] ?? null;
  const showMembers = members.length > 1 || (members.length === 1 && family !== "LOCATIONS");
  const onColour = member?.colour ?? null;

  const onChip = (sectionId: string) => {
    if (!filmId) return;
    router.push(`/?film=${encodeURIComponent(filmId)}#sec-${encodeURIComponent(sectionId)}`);
  };

  return (
    <>
      <FilmBar
        page="world"
        filmId={filmId}
        filmName={filmName}
        sections={board?.sections ?? []}
        importAvailable={board?.importAvailable ?? false}
        onChip={onChip}
        onChanged={refresh}
      />
      <main className="v-wrap v-world" data-vettu="world">
        <div className="v-wdoctag">
          {filmName ? `${filmName} · ${FAMILY_WORD[family]}` : FAMILY_WORD[family]}
        </div>

        <div className="v-famrow" role="tablist" aria-label="world family">
          {families.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={f === family}
              className={`v-fam${f === family ? " on" : ""}`}
              onClick={() => {
                setFamily(f);
                setMemberCode(null);
                setTabId(null);
              }}
            >
              {f}
            </button>
          ))}
        </div>

        {showMembers ? (
          <div className="v-castrow" role="tablist" aria-label="members">
            {members.map((m) => {
              const on = m.code === member?.code;
              return (
                <button
                  key={m.code}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={`v-member${on ? " on" : ""}`}
                  style={on && m.colour ? { background: m.colour, borderColor: m.colour, color: "#0f1a14" } : undefined}
                  title={m.label}
                  onClick={() => {
                    setMemberCode(m.code);
                    setTabId(null);
                  }}
                >
                  {m.code}
                </button>
              );
            })}
          </div>
        ) : null}

        {pickError ? <p className="v-err">{pickError}</p> : null}
        {error ? <p className="v-err">{error}</p> : null}
        {loading && !world ? <p className="v-note">Loading the world…</p> : null}
        {world && members.length === 0 ? <p className="v-note">Nothing in {FAMILY_WORD[family]} yet.</p> : null}

        {member ? (
          <div className="v-wtabs" role="tablist" aria-label="tabs">
            {member.tabs.map((t) => {
              const on = t.id === tab?.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={`v-wtab${on ? " on" : ""}`}
                  style={on && onColour ? { background: onColour, borderColor: onColour, color: "#0f1a14" } : undefined}
                  onClick={() => setTabId(t.id)}
                >
                  {t.label || "ALL"}
                  <span className="ct">
                    {t.filled}/{t.total}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {tab ? (
          tab.cards.length > 0 ? (
            <div className="v-cards">
              {stackSquares(tab.cards).map((group) => {
                const slots = group.map((card) => (
                  <SlotCard
                    key={card.id}
                    card={card}
                    letters={world?.letters ?? {}}
                    memberColour={member?.colour ?? null}
                    onOpen={setLightbox}
                  />
                ));
                return group.length > 1 ? (
                  <div className="v-ccstack" key={group[0]!.id}>
                    {slots}
                  </div>
                ) : (
                  slots
                );
              })}
            </div>
          ) : (
            <p className="v-note">No cards in this tab yet.</p>
          )
        ) : null}
      </main>
      <Lightbox image={lightbox} onClose={closeLightbox} />
    </>
  );
}
