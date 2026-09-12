"use client";

/** The letter badge grammar (DESIGN §4.6): coloured letter square + dark value cells. */
import type { MouseEvent } from "react";

export interface BadgeCell {
  text: string;
  kind?: "t" | "w";
}

export interface BadgeProps {
  code?: string | null;
  colour?: string;
  cells?: BadgeCell[];
  on?: boolean;
  more?: boolean;
  ladder?: string;
  title?: string;
  className?: string;
  onClick?: () => void;
}

export function Badge({ code, colour, cells = [], on, more, ladder, title, className, onClick }: BadgeProps) {
  const cls = ["v-bd", on ? "on" : "", more ? "more" : "", ladder ?? "", className ?? ""].filter(Boolean).join(" ");
  const inner = (
    <>
      {code ? <em style={ladder || !colour ? undefined : { background: colour }}>{code}</em> : null}
      {cells.map((cell, i) => (
        <i key={i} className={cell.kind}>
          {cell.text}
        </i>
      ))}
    </>
  );
  if (onClick) {
    const handle = (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    };
    return (
      <button type="button" className={cls} title={title} onClick={handle}>
        {inner}
      </button>
    );
  }
  return (
    <span className={cls} title={title}>
      {inner}
    </span>
  );
}
