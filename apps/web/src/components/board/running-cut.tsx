"use client";

/**
 * The running-cut fold (DESIGN §4.4) and the VETTU PREVIEW fold. The record plays in the first;
 * an edit's preview plays only in the second. Closed on load; the player stops at `to`.
 */
import { useRef, useState } from "react";
import type { KeyboardEvent, SyntheticEvent } from "react";
import { fmt } from "@/lib/contracts/film";
import type { BoardRunningCut } from "@/lib/contracts/board-view";
import type { PreviewInfo } from "@/lib/contracts/timeline";
import { centis } from "@/lib/board-format";

interface FoldProps {
  numText: string;
  name: string;
  src: string;
  poster: string | null;
  from: number;
  to: number | null;
  musicBed: string | null;
  defaultOpen: boolean;
  vettu: string;
}

function CutFold({ numText, name, src, poster, from, to, musicBed, defaultOpen, vettu }: FoldProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [now, setNow] = useState(0);
  const started = useRef(false);

  const toggle = () => setOpen((o) => !o);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };
  const guard = (event: SyntheticEvent) => event.stopPropagation();

  const readout = (v: HTMLVideoElement) => {
    const end = to ?? Number.POSITIVE_INFINITY;
    setNow(Math.max(0, Math.min(v.currentTime, end) - from));
  };
  const onLoaded = (event: SyntheticEvent<HTMLVideoElement>) => {
    const v = event.currentTarget;
    if (v.currentTime < from) v.currentTime = from;
  };
  const onPlay = (event: SyntheticEvent<HTMLVideoElement>) => {
    const v = event.currentTarget;
    if (!started.current || v.currentTime < from - 0.05 || (to !== null && v.currentTime >= to - 0.02)) {
      started.current = true;
      if (v.currentTime < from - 0.05 || (to !== null && v.currentTime >= to - 0.02)) v.currentTime = from;
    }
  };
  const onTime = (event: SyntheticEvent<HTMLVideoElement>) => {
    const v = event.currentTarget;
    if (to !== null && v.currentTime >= to && !v.paused) v.pause();
    readout(v);
  };

  return (
    <section className={`v-sec v-cut${open ? " open" : ""}`} data-vettu={vettu}>
      <div className="v-sum nowrap" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={onKey}>
        <span className="v-snum amber">{numText}</span>
        <span className="v-sname">{name}</span>
        {musicBed ? (
          <audio className="v-cutmus" controls preload="none" src={musicBed} onClick={guard} onKeyDown={guard} />
        ) : (
          <span className="v-grow" />
        )}
        <span className="v-readout" aria-live="off">
          {centis(now)}
        </span>
      </div>
      <div className="v-secbody" hidden={!open}>
        <video
          key={src}
          className="v-cutvideo"
          controls
          preload="none"
          playsInline
          poster={poster ?? undefined}
          src={src}
          onLoadedMetadata={onLoaded}
          onPlay={onPlay}
          onTimeUpdate={onTime}
          onSeeked={(e) => readout(e.currentTarget)}
        />
      </div>
    </section>
  );
}

export function RunningCutFold({ cut }: { cut: BoardRunningCut }) {
  return (
    <CutFold
      vettu="running-cut"
      numText={cut.lengthText}
      name="THE RUNNING CUT · 16:9"
      src={cut.url}
      poster={cut.poster}
      from={cut.from}
      to={cut.to}
      musicBed={cut.musicBed}
      defaultOpen={false}
    />
  );
}

export function PreviewFold({ preview }: { preview: PreviewInfo }) {
  return (
    <CutFold
      key={preview.url}
      vettu="preview"
      numText={fmt(preview.secs)}
      name={`VETTU PREVIEW v${preview.draft}`}
      src={preview.url}
      poster={null}
      from={0}
      to={null}
      musicBed={null}
      defaultOpen
    />
  );
}
