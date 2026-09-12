/** Acceptance check 3: the /api/films handlers called directly against a temp store. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import type { Film, FilmsList } from "@/lib/contracts/film";
import type { BoardView } from "@/lib/contracts/board-view";
import type { WorldView } from "@/lib/contracts/world-view";

let films: typeof import("./route");
let filmRoute: typeof import("./[id]/route");
let sectionsRoute: typeof import("./[id]/sections/route");
let sectionRoute: typeof import("./[id]/sections/[sid]/route");
let moveRoute: typeof import("./[id]/sections/[sid]/move/route");
let boardRoute: typeof import("./[id]/board/route");
let worldRoute: typeof import("./[id]/world/route");
let importRoute: typeof import("./import/saakshe/route");

before(async () => {
  process.env.VETTU_DATA_DIR = await mkdtemp(join(tmpdir(), "vettu-films-"));
  delete process.env.FILM_REPORTS_DIR;
  delete process.env.FILM_ROOT;
  delete process.env.LABS_OUT;
  delete process.env.FILM_RUNNING_CUT;
  films = await import("./route");
  filmRoute = await import("./[id]/route");
  sectionsRoute = await import("./[id]/sections/route");
  sectionRoute = await import("./[id]/sections/[sid]/route");
  moveRoute = await import("./[id]/sections/[sid]/move/route");
  boardRoute = await import("./[id]/board/route");
  worldRoute = await import("./[id]/world/route");
  importRoute = await import("./import/saakshe/route");
});

const HOST = "127.0.0.1:3100";
const ORIGIN = `http://${HOST}`;
const COOKIE = `vettu-session=${"a".repeat(64)}`;

function request(
  method: string,
  path: string,
  opts: { body?: unknown; ifMatch?: number; session?: boolean; origin?: boolean } = {},
): Request {
  const headers: Record<string, string> = { host: HOST };
  if (opts.origin !== false) headers.origin = ORIGIN;
  if (opts.session !== false) headers.cookie = COOKIE;
  if (method !== "GET") headers["content-type"] = "application/json";
  if (opts.ifMatch !== undefined) headers["if-match"] = String(opts.ifMatch);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(opts.body ?? {}),
  });
}
const params = <T>(p: T) => ({ params: Promise.resolve(p) });

async function createFilm(name: string): Promise<Film> {
  const res = await films.POST(request("POST", "/api/films", { body: { name } }), undefined);
  assert.equal(res.status, 201);
  return (await res.json()) as Film;
}

test("GET /api/films seeds the sample film once; its board and WORLD read", async () => {
  const res = await films.GET(request("GET", "/api/films"), undefined);
  assert.equal(res.status, 200);
  const list = (await res.json()) as FilmsList;
  assert.equal(list.importAvailable, false);
  assert.equal(list.films.length, 1);
  assert.equal(list.films[0].source.kind, "sample");
  assert.equal(list.films[0].name, "MY FIRST FILM");
  const again = (await (await films.GET(request("GET", "/api/films"), undefined)).json()) as FilmsList;
  assert.equal(again.films.length, 1);

  const id = list.films[0].id;
  const board = await boardRoute.GET(request("GET", `/api/films/${id}/board`), params({ id }));
  assert.equal(board.status, 200);
  const view = (await board.json()) as BoardView;
  assert.equal(view.filmId, id);
  assert.deepEqual(
    [view.stats.plan.text, view.stats.master.text, view.stats.pct.text, view.stats.clips.text, view.stats.toCreate.text],
    ["PLAN 1:30", "M 0:00", "0%", "0/3", "X 1"],
  );
  assert.equal(view.sections[2].out, true);
  const world = (await (await worldRoute.GET(request("GET", `/api/films/${id}/world`), params({ id }))).json()) as WorldView;
  assert.deepEqual([world.cast.length, world.locations.length, world.props.length], [2, 1, 1]);
});

test("acceptance: create → rename → add → rename → move → park → remove → reload", async () => {
  let film = await createFilm("test film");
  assert.equal(film.name, "TEST FILM");
  assert.equal(film.rev, 1);
  assert.equal(film.source.kind, "new");
  assert.equal(film.sections.length, 0);
  assert.equal(film.activeSection, null);
  const id = film.id;
  const revs = [film.rev];
  const step = async (res: Response, status = 200) => {
    assert.equal(res.status, status, await res.clone().text());
    film = (await res.json()) as Film;
    revs.push(film.rev);
  };

  await step(await filmRoute.PATCH(request("PATCH", `/api/films/${id}`, { body: { name: "my film" }, ifMatch: film.rev }), params({ id })));
  assert.equal(film.name, "MY FILM");

  await step(
    await sectionsRoute.POST(request("POST", `/api/films/${id}/sections`, { body: { name: "the other", targetSecs: 20 }, ifMatch: film.rev }), params({ id })),
    201,
  );
  await step(
    await sectionsRoute.POST(request("POST", `/api/films/${id}/sections`, { body: { name: "the start", targetSecs: 30 }, ifMatch: film.rev }), params({ id })),
    201,
  );
  const sid = film.sections[1].id;
  assert.deepEqual([film.sections[1].code, film.sections[1].name], ["§02", "THE START"]);

  await step(
    await sectionRoute.PATCH(request("PATCH", `/api/films/${id}/sections/${sid}`, { body: { name: "the beginning" }, ifMatch: film.rev }), params({ id, sid })),
  );
  assert.equal(film.sections[1].name, "THE BEGINNING");

  await step(
    await moveRoute.POST(request("POST", `/api/films/${id}/sections/${sid}/move`, { body: { index: 0 }, ifMatch: film.rev }), params({ id, sid })),
  );
  assert.deepEqual(
    film.sections.map((s) => [s.code, s.name]),
    [
      ["§01", "THE BEGINNING"],
      ["§02", "THE OTHER"],
    ],
  );
  assert.equal(film.sections[0].id, sid);

  // refs by code work too
  await step(
    await sectionRoute.PATCH(request("PATCH", `/api/films/${id}/sections/§01`, { body: { parked: true }, ifMatch: film.rev }), params({ id, sid: "§01" })),
  );
  assert.equal(film.sections[0].parked, true);
  const board = (await (await boardRoute.GET(request("GET", `/api/films/${id}/board`), params({ id }))).json()) as BoardView;
  assert.deepEqual([board.sections[0].out, board.sections[0].range.text, board.stats.plan.text], [true, "—", "PLAN 0:20"]);

  await step(
    await sectionRoute.DELETE(request("DELETE", `/api/films/${id}/sections/${sid}`, { body: {}, ifMatch: film.rev }), params({ id, sid })),
  );
  assert.deepEqual(
    film.sections.map((s) => [s.code, s.name]),
    [["§01", "THE OTHER"]],
  );

  for (let i = 1; i < revs.length; i++) assert.equal(revs[i], revs[i - 1] + 1, `rev rose at step ${i}`);

  const reloaded = (await (await filmRoute.GET(request("GET", `/api/films/${id}`), params({ id }))).json()) as Film;
  assert.deepEqual(reloaded, film);
  const listed = (await (await films.GET(request("GET", "/api/films"), undefined)).json()) as FilmsList;
  assert.equal(listed.films.find((f) => f.id === id)?.name, "MY FILM");
});

test("writes: 428 without If-Match · 409 stale · 403 without session or origin · 400 · 404", async () => {
  const film = await createFilm("guard film");
  const id = film.id;
  const patch = (opts: Parameters<typeof request>[2]) =>
    filmRoute.PATCH(request("PATCH", `/api/films/${id}`, { body: { name: "renamed" }, ...opts }), params({ id }));

  let res = await patch({});
  assert.equal(res.status, 428);
  assert.equal(((await res.json()) as { error: string }).error, "If-Match required");

  res = await patch({ ifMatch: film.rev + 5 });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { rev: number }).rev, film.rev);

  res = await patch({ ifMatch: film.rev, session: false });
  assert.equal(res.status, 403);
  res = await patch({ ifMatch: film.rev, origin: false });
  assert.equal(res.status, 403);

  res = await filmRoute.PATCH(request("PATCH", `/api/films/${id}`, { body: { name: "   " }, ifMatch: film.rev }), params({ id }));
  assert.equal(res.status, 400);
  res = await filmRoute.PATCH(request("PATCH", `/api/films/${id}`, { body: { bogus: 1 }, ifMatch: film.rev }), params({ id }));
  assert.equal(res.status, 400);
  res = await sectionRoute.PATCH(
    request("PATCH", `/api/films/${id}/sections/§09`, { body: { parked: true }, ifMatch: film.rev }),
    params({ id, sid: "§09" }),
  );
  assert.equal(res.status, 404);

  const unchanged = (await (await filmRoute.GET(request("GET", `/api/films/${id}`), params({ id }))).json()) as Film;
  assert.equal(unchanged.rev, film.rev);
  assert.equal(unchanged.name, "GUARD FILM");

  res = await filmRoute.GET(request("GET", "/api/films/f_nothere0000"), params({ id: "f_nothere0000" }));
  assert.equal(res.status, 404);
  res = await films.POST(request("POST", "/api/films", { body: { name: "x" }, session: false }), undefined);
  assert.equal(res.status, 403);

  res = await importRoute.POST(request("POST", "/api/films/import/saakshe", { body: {} }), undefined);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "film_env_unset" });
});
