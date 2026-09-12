"use client";

/**
 * The film bar (DESIGN §4.1 + §7), fixed on both pages: VETTU wordmark · hairline · film name
 * (opens the film menu) · BOARD / WORLD · § chips.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { BoardSection } from "@/lib/contracts/board-view";
import type { FilmSummary } from "@/lib/contracts/film";
import { VettuMark } from "@/components/brand/VettuMark";

function failText(error: unknown): string {
  return error instanceof ApiError ? error.message : "That did not work. Try again.";
}

export interface FilmBarProps {
  page: "board" | "world";
  filmId: string | null;
  filmName: string | null;
  sections: BoardSection[];
  importAvailable: boolean;
  ringId?: string | null;
  onChip?(sectionId: string): void;
  onChanged?(): Promise<void> | void;
}

export function FilmBar({ page, filmId, filmName, sections, importAvailable, ringId, onChip, onChanged }: FilmBarProps) {
  const [menuLeft, setMenuLeft] = useState<number | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const q = filmId ? `?film=${encodeURIComponent(filmId)}` : "";

  const toggleMenu = () => {
    if (menuLeft !== null) {
      setMenuLeft(null);
      return;
    }
    const left = buttonRef.current?.getBoundingClientRect().left ?? 12;
    setMenuLeft(Math.max(8, Math.min(left, window.innerWidth - 310)));
  };

  return (
    <>
      <nav className="v-bar" data-vettu="filmbar" aria-label="film bar">
        <Link className="v-brand" href={`/${q}`} aria-label="VETTU board">
          <VettuMark />
        </Link>
        <span className="v-hair" aria-hidden="true" />
        <button
          ref={buttonRef}
          type="button"
          className="v-filmbtn"
          aria-haspopup="menu"
          aria-expanded={menuLeft !== null}
          onClick={toggleMenu}
        >
          {filmName ?? "FILMS"}
          <span className="caret">▾</span>
        </button>
        <Link className={`v-pg${page === "board" ? " on" : ""}`} href={`/${q}`}>
          BOARD
        </Link>
        <Link className={`v-pg${page === "world" ? " on" : ""}`} href={`/world${q}`}>
          WORLD
        </Link>
        {sections.length > 0 ? (
          <div className="v-sqs">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`v-sq${s.out ? " out" : ""}${ringId === s.id ? " ring" : ""}`}
                style={{ background: s.colour.bg }}
                title={s.out ? `${s.code} ${s.name} — parked` : `${s.code} ${s.name}`}
                onClick={() => onChip?.(s.id)}
              >
                <span className="n" style={{ color: s.colour.fg }}>
                  {s.code}
                </span>
                <span className="c">{s.total > 0 ? `${s.done}/${s.total}` : "—"}</span>
                <span className="s" style={{ color: s.colour.fg }}>
                  {s.chipSecs}
                </span>
                {s.full ? (
                  <span className="d" style={{ color: s.colour.fg }}>
                    ◆
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </nav>
      {menuLeft !== null ? (
        <FilmMenu
          page={page}
          left={menuLeft}
          filmId={filmId}
          filmName={filmName}
          importAvailable={importAvailable}
          anchor={buttonRef}
          onClose={() => setMenuLeft(null)}
          onChanged={onChanged}
        />
      ) : null}
    </>
  );
}

function FilmMenu({
  page,
  left,
  filmId,
  filmName,
  importAvailable,
  anchor,
  onClose,
  onChanged,
}: {
  page: "board" | "world";
  left: number;
  filmId: string | null;
  filmName: string | null;
  importAvailable: boolean;
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose(): void;
  onChanged?(): Promise<void> | void;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [films, setFilms] = useState<FilmSummary[] | null>(null);
  const [canImport, setCanImport] = useState(importAvailable);
  const [mode, setMode] = useState<"list" | "new" | "rename">("list");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.films
      .list()
      .then((list) => {
        if (!alive) return;
        setFilms(list.films);
        if (list.importAvailable) setCanImport(true);
      })
      .catch((e) => {
        if (alive) setError(failText(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  const go = (id: string, where: "board" | "world" = page) => {
    onClose();
    router.push(`${where === "world" ? "/world" : "/"}?film=${encodeURIComponent(id)}`);
  };

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(failText(e));
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    act(async () => {
      const value = name.trim();
      if (!value) return;
      const film = await api.films.create(value);
      go(film.id, "board");
    });

  const rename = () =>
    act(async () => {
      const value = name.trim();
      if (!value || !filmId) return;
      await api.films.rename(filmId, value);
      setMode("list");
      await onChanged?.();
      onClose();
    });

  const importFilm = () =>
    act(async () => {
      const film = await api.films.importSaakshe();
      go(film.id, "board");
    });

  return (
    <div className="v-menu" ref={ref} role="menu" style={{ left }} data-vettu="film-menu">
      <div className="v-menu-title">FILMS</div>
      {films === null && !error ? <div className="v-note" style={{ margin: "4px 8px" }}>Loading…</div> : null}
      {(films ?? []).map((film) => (
        <button
          key={film.id}
          type="button"
          role="menuitem"
          className={`v-menu-item${film.id === filmId ? " on" : ""}`}
          onClick={() => go(film.id)}
        >
          <span className="name">{film.name}</span>
          <span className="meta">{film.sections} §</span>
        </button>
      ))}
      <div className="v-menu-sep" />
      {mode === "new" ? (
        <form
          className="v-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            className="v-input"
            autoFocus
            value={name}
            maxLength={80}
            placeholder="FILM NAME"
            aria-label="new film name"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="v-btn primary" disabled={busy || !name.trim()}>
            Create
          </button>
        </form>
      ) : mode === "rename" ? (
        <form
          className="v-form"
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
        >
          <input
            className="v-input"
            autoFocus
            value={name}
            maxLength={80}
            aria-label="film name"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="v-btn primary" disabled={busy || !name.trim()}>
            Save
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            className="v-menu-item"
            onClick={() => {
              setName("");
              setMode("new");
            }}
          >
            New film
          </button>
          {filmId ? (
            <button
              type="button"
              role="menuitem"
              className="v-menu-item"
              onClick={() => {
                setName(filmName ?? "");
                setMode("rename");
              }}
            >
              Rename film
            </button>
          ) : null}
          {canImport ? (
            <button type="button" role="menuitem" className="v-menu-item" disabled={busy} onClick={() => void importFilm()}>
              Import SAAKSHE
            </button>
          ) : null}
        </>
      )}
      {error ? <div className="v-err" style={{ margin: "6px 8px" }}>{error}</div> : null}
    </div>
  );
}

/** Shown when the store has no film yet. */
export function NewFilmInline() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="v-form"
      style={{ padding: 0, marginTop: 14, maxWidth: 480 }}
      onSubmit={async (e) => {
        e.preventDefault();
        const value = name.trim();
        if (!value) return;
        setBusy(true);
        setError(null);
        try {
          const film = await api.films.create(value);
          router.replace(`/?film=${encodeURIComponent(film.id)}`);
        } catch (err) {
          setError(failText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        className="v-input"
        value={name}
        maxLength={80}
        placeholder="FILM NAME"
        aria-label="new film name"
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="v-btn primary" disabled={busy || !name.trim()}>
        New film
      </button>
      {error ? <span className="v-err">{error}</span> : null}
    </form>
  );
}
