/** Shared bits for the /api/films routes (not a route file). */
import { HttpError, type GuardContext } from "@/lib/server/guard";

export type IdContext = { params: Promise<{ id: string }> };
export type SectionContext = { params: Promise<{ id: string; sid: string }> };

/** Store writes REQUIRE If-Match: <rev>. Missing → 428. A stale rev → 409 (film-store). */
export function requireRev(g: GuardContext): number {
  const rev = g.ifMatch();
  if (rev === null) throw new HttpError(428, "If-Match required");
  return rev;
}
