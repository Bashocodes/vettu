"use client";

/** WORLD — `/world?film=<id>`. useSearchParams lives under a Suspense boundary. */
import { Suspense } from "react";
import { WorldScreen } from "@/components/world/world-screen";

export default function WorldPage() {
  return (
    <Suspense fallback={null}>
      <WorldScreen />
    </Suspense>
  );
}
