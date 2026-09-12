"use client";

/** The badge legend (DESIGN §4.6): things · the cast · makers · the S ladder · reserved. */
import type { Letter } from "@/lib/contracts/film";
import { Badge } from "./badge";

type Row = { key: string; items: [string, Letter][]; reserved: boolean };

export function Legend({ letters }: { letters: Record<string, Letter> }) {
  const entries = Object.entries(letters);
  const inUse = (l: Letter) => l.inUse !== false && l.kind !== "spare-maker";
  const rows: Row[] = [
    { key: "THINGS", items: entries.filter(([, l]) => inUse(l) && (l.kind ?? "thing") === "thing"), reserved: false },
    { key: "THE CAST", items: entries.filter(([, l]) => inUse(l) && l.kind === "who"), reserved: false },
    { key: "MAKERS", items: entries.filter(([, l]) => inUse(l) && l.kind === "maker"), reserved: false },
  ];
  const reserved = entries.filter(([, l]) => !inUse(l));
  const ladder: [string, string][] = [
    ["b-placed", "PLACED"],
    ["b-cut", "IN THE CUT"],
    ["b-master", "IN THE MASTER"],
    ["b-locked", "LOCKED"],
  ];

  return (
    <section className="v-legend" data-vettu="legend" aria-label="legend">
      <div className="v-lg-title">LEGEND</div>
      {rows
        .filter((row) => row.items.length > 0)
        .map((row) => (
          <div className="v-lg-row" key={row.key}>
            <span className="v-lg-key">{row.key}</span>
            <span className="v-lg-items">
              {row.items.map(([code, l]) => (
                <Badge key={code} code={code} colour={l.colour} cells={[{ text: l.label }]} />
              ))}
            </span>
          </div>
        ))}
      <div className="v-lg-row">
        <span className="v-lg-key">THE S LADDER</span>
        <span className="v-lg-items">
          {ladder.map(([cls, label]) => (
            <span className="v-lg-step" key={cls}>
              <Badge code="S" ladder={cls} cells={[{ text: "7" }, { text: "4s", kind: "t" }]} />
              {label}
            </span>
          ))}
        </span>
      </div>
      {reserved.length > 0 ? (
        <div className="v-lg-row reserved">
          <span className="v-lg-key">RESERVED — NOT YET IN USE</span>
          <span className="v-lg-items">
            {reserved.map(([code, l]) => (
              <Badge key={code} code={code} colour={l.colour} cells={[{ text: l.label }]} />
            ))}
          </span>
        </div>
      ) : null}
    </section>
  );
}
