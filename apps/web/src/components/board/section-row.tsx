"use client";

/**
 * One section slab (DESIGN §4.5): § number (drag handle) · name · non-empty tab pills · seconds
 * pill · ◇ ◆ 🔒 / LATER · faint range · ⋯ actions. The YOUR EDIT strip sits under the ACTIVE
 * section's header; the record pills never change because of an edit.
 */
import { useEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { BoardSection, TabName } from "@/lib/contracts/board-view";
import type { Letter } from "@/lib/contracts/film";
import type { EditDiff } from "@/lib/board-format";
import { sectionNumber } from "@/lib/board-format";
import { JobStrip } from "@/components/jobs/job-strip";
import { Badge } from "./badge";
import { CardGrid, PlanRows, SoundRows } from "./card";
import type { LightboxImage } from "./lightbox";

const DRAG_TYPE = "text/x-vettu-section";

function failText(error: unknown): string {
  return error instanceof ApiError ? error.message : "That did not work. Try again.";
}

export interface SectionRowProps {
  filmId: string;
  section: BoardSection;
  index: number;
  count: number;
  letters: Record<string, Letter>;
  open: boolean;
  active: boolean;
  diff: EditDiff | null;
  dragging: string | null;
  onDragging(sectionId: string | null): void;
  onToggle(sectionId: string): void;
  onChanged(): Promise<void>;
  onOpenImage(image: LightboxImage): void;
}

export function SectionRow({
  filmId,
  section,
  index,
  count,
  letters,
  open,
  active,
  diff,
  dragging,
  onDragging,
  onToggle,
  onChanged,
  onOpenImage,
}: SectionRowProps) {
  const [tab, setTab] = useState<TabName | null>(null);
  const wasOpen = useRef(false);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "ask" | "withCards">(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) setTab(null);
  }, [open]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (event: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenu(false);
        setConfirm(null);
      }
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(false);
        setConfirm(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMenu(false);
      setConfirm(null);
      await onChanged();
    } catch (e) {
      setError(failText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (withCards: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.films.removeSection(filmId, section.id, withCards);
      setMenu(false);
      setConfirm(null);
      await onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !withCards) setConfirm("withCards");
      else setError(failText(e));
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    const name = (renaming ?? "").trim();
    if (!name || name === section.name) {
      setRenaming(null);
      return;
    }
    await run(() => api.films.patchSection(filmId, section.id, { name }));
    setRenaming(null);
  };

  const toggle = () => onToggle(section.id);
  const onSumKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };
  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const clickTab = (event: MouseEvent, name: TabName) => {
    stop(event);
    if (tab === name) {
      setTab(null);
      if (!wasOpen.current && open) onToggle(section.id);
      return;
    }
    if (tab === null) wasOpen.current = open;
    setTab(name);
    if (!open) onToggle(section.id);
  };

  // drag-reorder by the § number handle
  const onDragStart = (event: DragEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.dataTransfer.setData(DRAG_TYPE, section.id);
    event.dataTransfer.setData("text/plain", section.code);
    event.dataTransfer.effectAllowed = "move";
    onDragging(section.id);
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!dragging || dragging === section.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!dropHover) setDropHover(true);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDropHover(false);
    const moved = event.dataTransfer.getData(DRAG_TYPE) || dragging;
    onDragging(null);
    if (moved && moved !== section.id) void run(() => api.films.moveSection(filmId, moved, index));
  };

  // `lifted` un-dims a parked slab while its menu, rename input or an error shows: opacity < 1 makes
  // the slab a stacking context and the next slab would paint over the ⋯ menu.
  const lifted = menu || renaming !== null || error !== null;
  const cls = [
    "v-sec",
    open ? "open" : "",
    section.out ? "out" : "",
    active ? "active" : "",
    dropHover ? "drop" : "",
    lifted ? "lifted" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const pane = (name: TabName) => {
    switch (name) {
      case "R·CLIPS":
        return (
          <CardGrid
            cards={section.reserve.filter((c) => c.kind === "clip")}
            letters={letters}
            onOpenImage={onOpenImage}
            emptyText="No reserve clips."
          />
        );
      case "R·IMAGES":
        return (
          <CardGrid
            cards={section.reserve.filter((c) => c.kind !== "clip")}
            letters={letters}
            onOpenImage={onOpenImage}
            emptyText="No reserve images."
          />
        );
      case "MUSIC":
        return <SoundRows sounds={section.music} letters={letters} />;
      case "NARRATION":
        return <SoundRows sounds={section.narration} letters={letters} />;
      case "SFX":
        return <SoundRows sounds={section.sfx} letters={letters} />;
      case "PLANS":
        return <PlanRows plans={section.plans} />;
      default:
        return <p className="v-empty">{name} — nothing in VETTU yet.</p>;
    }
  };

  const { fg, bg } = section.colour;

  return (
    <section
      className={cls}
      data-sec={section.id}
      onDragOver={onDragOver}
      onDragLeave={() => setDropHover(false)}
      onDrop={onDrop}
    >
      <div className="v-sum" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={onSumKey}>
        <span
          className="v-snum"
          style={{ color: fg }}
          draggable
          title="drag to reorder"
          onDragStart={onDragStart}
          onDragEnd={() => onDragging(null)}
        >
          {sectionNumber(section.code)}
        </span>
        {renaming !== null ? (
          <input
            className="v-nameinput"
            value={renaming}
            autoFocus
            aria-label="section name"
            maxLength={80}
            disabled={busy}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void saveName();
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={() => void saveName()}
          />
        ) : (
          <span className="v-sname">{section.name}</span>
        )}
        <span className="v-tabs">
          {section.tabs.map((name) => (
            <button
              key={name}
              type="button"
              className={`v-tb${tab === name ? " on" : ""}`}
              onClick={(e) => clickTab(e, name)}
            >
              {name}
            </button>
          ))}
        </span>
        <span className="v-sdur" style={{ color: fg, borderColor: fg, background: bg }}>
          {section.durText}
        </span>
        <span className="v-sst">
          {section.out ? (
            <span className="v-later">LATER</span>
          ) : (
            <>
              {section.glyphs.cut ? <span className="g-cut">◇</span> : null}
              {section.glyphs.master ? <span className="g-master">◆</span> : null}
              {section.glyphs.lock ? (
                <span className="g-lock" role="img" aria-label="locked">
                  🔒
                </span>
              ) : null}
            </>
          )}
        </span>
        <span className="v-stc">{section.range.text}</span>
        <button
          type="button"
          className="v-more"
          aria-label={`${section.code} actions`}
          aria-expanded={menu}
          onClick={(e) => {
            stop(e);
            setMenu((m) => !m);
            setConfirm(null);
          }}
        >
          ⋯
        </button>
      </div>

      {menu ? (
        <div className="v-secmenu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="v-menu-item"
            disabled={busy}
            onClick={() => {
              setRenaming(section.name);
              setMenu(false);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="v-menu-item"
            disabled={busy}
            onClick={() => void run(() => api.films.patchSection(filmId, section.id, { parked: !section.out }))}
          >
            {section.out ? "Bring back into the film" : "Park it (LATER)"}
          </button>
          <button
            type="button"
            className="v-menu-item"
            disabled={busy || index === 0}
            onClick={() => void run(() => api.films.moveSection(filmId, section.id, index - 1))}
          >
            Move up
          </button>
          <button
            type="button"
            className="v-menu-item"
            disabled={busy || index >= count - 1}
            onClick={() => void run(() => api.films.moveSection(filmId, section.id, index + 1))}
          >
            Move down
          </button>
          <div className="v-menu-sep" />
          {confirm === null ? (
            <button type="button" className="v-menu-item danger" disabled={busy} onClick={() => setConfirm("ask")}>
              Remove…
            </button>
          ) : (
            <div className="v-confirm">
              {confirm === "ask"
                ? `Remove ${section.code} ${section.name}?`
                : "It still holds cards. Remove it with its cards?"}
              <div className="v-form">
                <button
                  type="button"
                  className="v-btn danger"
                  disabled={busy}
                  onClick={() => void remove(confirm === "withCards")}
                >
                  {confirm === "ask" ? "Remove" : "Remove with its cards"}
                </button>
                <button type="button" className="v-btn" disabled={busy} onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {error ? <div className="v-err">{error}</div> : null}
        </div>
      ) : null}

      {!menu && error ? <div className="v-err" style={{ padding: "0 18px 10px" }}>{error}</div> : null}

      {active && diff?.show ? (
        <div className="v-editstrip" data-vettu="your-edit">
          <span className={`v-editlabel${diff.approved ? " approved" : ""}`}>{diff.label}</span>
          <span className="v-editpill">{diff.pill}</span>
          {diff.words > 0 ? <Badge cells={[{ text: `${diff.words} WORDS` }]} /> : null}
          {diff.lastChange ? <span className="v-editlast">{diff.lastChange}</span> : null}
        </div>
      ) : null}

      {active ? <JobStrip filmId={filmId} section={section.id} /> : null}

      {open && tab ? <div className="v-tabpane">{pane(tab)}</div> : null}
      {open && !tab ? (
        <div className="v-secbody">
          {section.notes.length > 0 ? (
            <div className="v-notes">
              {section.notes.map((note, i) => (
                <div key={i}>{note}</div>
              ))}
            </div>
          ) : null}
          <CardGrid
            cards={section.cards}
            letters={letters}
            chips={active && diff?.show ? diff.chips : {}}
            inserted={active && diff?.show ? diff.inserted : []}
            onOpenImage={onOpenImage}
          />
        </div>
      ) : null}
    </section>
  );
}

export function AddSection({ filmId, onChanged }: { filmId: string; onChanged(): Promise<void> }) {
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const value = (name ?? "").trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      await api.films.addSection(filmId, { name: value });
      setName(null);
      await onChanged();
    } catch (e) {
      setError(failText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="v-add" data-vettu="add-section">
      {name === null ? (
        <button type="button" className="v-addbtn" onClick={() => setName("")}>
          + SECTION
        </button>
      ) : (
        <form
          className="v-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className="v-input"
            value={name}
            autoFocus
            maxLength={80}
            placeholder="THE NEXT PART"
            aria-label="new section name"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setName(null);
            }}
          />
          <button type="submit" className="v-btn primary" disabled={busy || !name.trim()}>
            Add
          </button>
          <button type="button" className="v-btn" disabled={busy} onClick={() => setName(null)}>
            Cancel
          </button>
        </form>
      )}
      {error ? <span className="v-err">{error}</span> : null}
    </div>
  );
}
