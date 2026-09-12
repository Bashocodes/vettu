"use client";

/**
 * BOARD (`/?film=<id>`): film bar · <main> (doctag, title, stat pills, running cut, VETTU
 * preview, section slabs, + SECTION, legend) · the overlay at the root, outside <main>.
 */
import "@/styles/vettu-board.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { VettuOverlay } from "@/components/overlay/vettu-overlay";
import { api, ApiError } from "@/lib/api-client";
import { editDiff } from "@/lib/board-format";
import { useFilm } from "@/lib/use-film";
import { FilmBar, NewFilmInline } from "./film-bar";
import { Legend } from "./legend";
import { Lightbox } from "./lightbox";
import type { LightboxImage } from "./lightbox";
import { PreviewFold, RunningCutFold } from "./running-cut";
import { AddSection, SectionRow } from "./section-row";
import { StatPills } from "./stat-pills";

function failText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function scrollToSection(sectionId: string) {
  requestAnimationFrame(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>("[data-sec]")).find(
      (node) => node.dataset.sec === sectionId,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

export function BoardScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const filmId = params.get("film");
  const [pickError, setPickError] = useState<string | null>(null);
  const [noFilms, setNoFilms] = useState(false);

  useEffect(() => {
    if (filmId) return;
    let alive = true;
    api.films
      .list()
      .then(({ films }) => {
        if (!alive) return;
        const first = films[0];
        if (first) router.replace(`/?film=${encodeURIComponent(first.id)}`);
        else setNoFilms(true);
      })
      .catch((e) => {
        if (alive) setPickError(failText(e, "Could not list the films."));
      });
    return () => {
      alive = false;
    };
  }, [filmId, router]);

  const { board, timeline, loading, error, refresh } = useFilm(filmId);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [activeLocal, setActiveLocal] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ring, setRing] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const initialised = useRef<string | null>(null);

  const activeId = activeLocal ?? board?.active ?? null;

  // First load of a film: open the active section (or the #sec-<id> a WORLD chip asked for).
  useEffect(() => {
    if (!board || initialised.current === board.filmId) return;
    initialised.current = board.filmId;
    let fromHash: string | null = null;
    const hash = window.location.hash;
    if (hash.startsWith("#sec-")) {
      const id = decodeURIComponent(hash.slice(5));
      if (board.sections.some((s) => s.id === id)) fromHash = id;
    }
    const first = fromHash ?? board.active;
    setOpenIds(first ? new Set([first]) : new Set());
    setActiveLocal(null);
    if (fromHash) scrollToSection(fromHash);
  }, [board]);

  useEffect(() => {
    if (board && activeLocal && board.active === activeLocal) setActiveLocal(null);
  }, [board, activeLocal]);

  useEffect(() => {
    if (board) document.title = `${board.film} · THE FILM BOARD — VETTU`;
  }, [board]);

  // Scrollspy: ring the ONE section crossing 42.5% of the viewport.
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const band = window.innerHeight * 0.425;
      let hit: string | null = null;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-sec]"))) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= band && rect.bottom > band) {
          hit = el.dataset.sec ?? null;
          break;
        }
      }
      setRing(hit);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    measure();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [board]);

  const selectSection = useCallback(
    (sectionId: string) => {
      if (!filmId) return;
      setOpenIds((prev) => (prev.has(sectionId) ? prev : new Set(prev).add(sectionId)));
      if (board?.active === sectionId) return;
      setActiveLocal(sectionId);
      setActionError(null);
      api.films
        .setActive(filmId, sectionId)
        .then(() => refresh())
        .catch((e) => {
          setActiveLocal(null);
          setActionError(failText(e, "Could not make that section active."));
        });
    },
    [filmId, board?.active, refresh],
  );

  const toggle = useCallback(
    (sectionId: string) => {
      if (openIds.has(sectionId)) {
        setOpenIds((prev) => {
          const next = new Set(prev);
          next.delete(sectionId);
          return next;
        });
      } else {
        selectSection(sectionId);
      }
    },
    [openIds, selectSection],
  );

  const onChip = useCallback(
    (sectionId: string) => {
      selectSection(sectionId);
      scrollToSection(sectionId);
    },
    [selectSection],
  );

  const closeLightbox = useCallback(() => setLightbox(null), []);

  const diff = useMemo(() => {
    if (!board || !timeline || !activeId || timeline.section !== activeId) return null;
    const section = board.sections.find((s) => s.id === activeId);
    return section ? editDiff(timeline, section.cards) : null;
  }, [board, timeline, activeId]);

  const sections = board?.sections ?? [];
  const preview = timeline && timeline.section === activeId ? timeline.preview : null;

  return (
    <>
      <FilmBar
        page="board"
        filmId={filmId}
        filmName={board?.film ?? null}
        sections={sections}
        importAvailable={board?.importAvailable ?? false}
        ringId={ring}
        onChip={onChip}
        onChanged={refresh}
      />
      <main className="v-wrap v-board" data-vettu="board">
        <header className="v-head">
          <div className="v-doctag">VETTU</div>
          <h1 className="v-title">{board ? `${board.film} · THE FILM BOARD` : "THE FILM BOARD"}</h1>
          {board ? <StatPills stats={board.stats} /> : null}
        </header>

        {pickError ? <p className="v-err">{pickError}</p> : null}
        {error ? <p className="v-err">{error}</p> : null}
        {actionError ? <p className="v-err">{actionError}</p> : null}
        {noFilms && !filmId ? (
          <>
            <p className="v-note">No films yet. Name your first film.</p>
            <NewFilmInline />
          </>
        ) : null}
        {loading && !board && filmId ? <p className="v-note">Loading the film board…</p> : null}

        {board?.runningCut ? <RunningCutFold cut={board.runningCut} /> : null}
        {preview ? <PreviewFold preview={preview} /> : null}

        {board && filmId
          ? sections.map((section, index) => (
              <SectionRow
                key={section.id}
                filmId={filmId}
                section={section}
                index={index}
                count={sections.length}
                letters={board.letters}
                open={openIds.has(section.id)}
                active={section.id === activeId}
                diff={section.id === activeId ? diff : null}
                dragging={dragging}
                onDragging={setDragging}
                onToggle={toggle}
                onChanged={refresh}
                onOpenImage={setLightbox}
              />
            ))
          : null}

        {board && filmId ? <AddSection filmId={filmId} onChanged={refresh} /> : null}
        {board ? <Legend letters={board.letters} /> : null}
      </main>
      <Lightbox image={lightbox} onClose={closeLightbox} />
      <VettuOverlay
        filmId={filmId}
        board={board}
        timeline={timeline}
        activeSection={activeId}
        selectSection={selectSection}
        refresh={refresh}
      />
    </>
  );
}
