"use client";

/** The number row (DESIGN §4.3): PLAN · → target (only when set) · M · % · clips · s left · X. */
import type { BoardStats } from "@/lib/contracts/board-view";

export function StatPills({ stats }: { stats: BoardStats }) {
  return (
    <div className="v-pills" data-vettu="stats">
      <span className="v-pill" title="planned length">
        {stats.plan.text}
      </span>
      {stats.target ? (
        <span className="v-pill amber" title="target length">
          {stats.target.text}
        </span>
      ) : null}
      <span className="v-pill" title="in the master">
        {stats.master.text}
      </span>
      <span className="v-pill" title="made">
        {stats.pct.text}
      </span>
      <span className="v-pill" title="clips done / planned">
        {stats.clips.text}
      </span>
      <span className="v-pill rose" title="seconds still to make">
        {stats.secsLeft.text}
      </span>
      <span className="v-pill" title="cards to create">
        {stats.toCreate.text}
      </span>
    </div>
  );
}
