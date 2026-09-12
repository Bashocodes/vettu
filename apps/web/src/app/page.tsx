"use client";

/** BOARD — `/?film=<id>`. useSearchParams lives under a Suspense boundary. */
import { Suspense } from "react";
import { BoardScreen } from "@/components/board/board-screen";

export default function BoardPage() {
  return (
    <Suspense fallback={null}>
      <BoardScreen />
    </Suspense>
  );
}
