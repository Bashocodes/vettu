/**
 * The film store core: VETTU_DATA_DIR/films/<id>.json. Server only.
 * Writes are atomic (tmp + rename), bump `rev`, and require the caller's expected rev
 * (If-Match) → HttpError 409 on a stale write. The hand and the agent share this one store.
 * Section/card operations are pure functions elsewhere (film-ops.ts) applied via mutateFilm.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Film, FilmSummary } from "@/lib/contracts/film";
import { HttpError } from "./guard";
import { dataDir } from "./roots";

const ID = /^f_[a-z0-9]{6,32}$/;

export function newFilmId(): string {
  return `f_${randomBytes(6).toString("hex")}`;
}

export function filmsDir(): string {
  return join(dataDir(), "films");
}

function filmPath(id: string): string {
  if (!ID.test(id)) throw new HttpError(404, "No such film.");
  return join(filmsDir(), `${id}.json`);
}

export async function readFilm(id: string): Promise<Film | null> {
  try {
    return JSON.parse(await readFile(filmPath(id), "utf8")) as Film;
  } catch (error) {
    if (error instanceof HttpError) return null;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function requireFilm(id: string): Promise<Film> {
  const film = await readFilm(id);
  if (!film) throw new HttpError(404, "No such film.");
  return film;
}

export async function listFilms(): Promise<FilmSummary[]> {
  let names: string[] = [];
  try {
    names = await readdir(filmsDir());
  } catch {
    return [];
  }
  const films = await Promise.all(
    names
      .filter((n) => n.endsWith(".json") && ID.test(n.slice(0, -5)))
      .map((n) => readFilm(n.slice(0, -5)).catch(() => null)),
  );
  return films
    .filter((f): f is Film => !!f)
    .map((f) => ({
      id: f.id,
      name: f.name,
      sections: f.sections.length,
      updatedAt: f.updatedAt,
      source: f.source,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function atomicWrite(path: string, data: string) {
  await mkdir(filmsDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

/** Create a brand-new film file (rev 1). Fails if the id exists. */
export async function createFilm(film: Omit<Film, "rev" | "createdAt" | "updatedAt">): Promise<Film> {
  const now = new Date().toISOString();
  const full: Film = { ...film, rev: 1, createdAt: now, updatedAt: now };
  const path = filmPath(full.id);
  await mkdir(filmsDir(), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(full, null, 2), { flag: "wx", mode: 0o600 });
  return full;
}

/** Replace a film whole (used by re-import). Same rev rules as mutateFilm. */
export async function replaceFilm(film: Film, expectedRev: number | null): Promise<Film> {
  return mutateFilm(film.id, expectedRev, () => film);
}

/**
 * Apply a pure change. `expectedRev` = the If-Match rev (null = agent/server write that
 * re-reads and applies to the latest). A stale rev → 409 { error, rev }.
 * Serialised per film inside this process; the rev check guards across processes.
 */
const queues = new Map<string, Promise<unknown>>();
export async function mutateFilm(
  id: string,
  expectedRev: number | null,
  change: (film: Film) => Film,
): Promise<Film> {
  const run = async () => {
    const current = await requireFilm(id);
    if (expectedRev !== null && expectedRev !== current.rev) {
      throw new HttpError(409, "The film changed. Reload and try again.", { rev: current.rev });
    }
    const next = change(structuredClone(current));
    const saved: Film = {
      ...next,
      id: current.id,
      rev: current.rev + 1,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await atomicWrite(filmPath(id), JSON.stringify(saved, null, 2));
    return saved;
  };
  const prev = queues.get(id) ?? Promise.resolve();
  const result = prev.then(run, run);
  queues.set(
    id,
    result.catch(() => undefined),
  );
  return result;
}
