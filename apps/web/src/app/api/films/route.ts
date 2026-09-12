import { z } from "zod";
import type { FilmsList } from "@/lib/contracts/film";
import { emptyFilm } from "@/lib/server/film-ops";
import { createFilm, listFilms, newFilmId } from "@/lib/server/film-store";
import { guarded } from "@/lib/server/guard";
import { filmEnvConfigured } from "@/lib/server/roots";
import { baseLetters, seedSampleFilm } from "@/lib/server/sample-film";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let seeding: Promise<void> | null = null;

/** GET /api/films → { films, importAvailable }. An empty store gets the sample film first. */
export const GET = guarded("read", async (g) => {
  let films = await listFilms();
  if (films.length === 0) {
    seeding ??= (async () => {
      if ((await listFilms()).length === 0) await seedSampleFilm();
    })().finally(() => {
      seeding = null;
    });
    await seeding;
    films = await listFilms();
  }
  const body: FilmsList = { films, importAvailable: filmEnvConfigured() };
  return g.reply(body);
});

const createBody = z.object({ name: z.string().max(400) }).strict();

/** POST /api/films { name } → a new empty film (201). */
export const POST = guarded("write", async (g) => {
  const body = await g.json(createBody);
  const film = await createFilm(emptyFilm(newFilmId(), body.name, baseLetters()));
  return g.reply(film, 201);
});
