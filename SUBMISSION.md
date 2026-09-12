# VETTU — submission

**VETTU (வெட்டு, "the cut") — an agentic film board for any film. Demo film: SAAKSHE.**
Tagline: *Say the cut. Agents make it.*

## Build eligibility

- [x] Net-new build, created during the hackathon (Sat 12 Sep 2026, Hyderabad room, solo).
- [x] Core functionality built during the event; every event commit comes after the kit commit below.
- [x] Inherited code, prompts and design language are listed separately from event work.

**What we inherited**
- CopilotKit's `agents-everywhere-starter-kit` at commit `6443333e4b81fd6e21a4f531bdeee3a71eccd7b5` — the web app
  shell, the CopilotKit runtime route, the Slack Channels listener, the agent factory, the Ambiguous MCP adapter
  (`apps/web/src/lib/server/workplace.ts`), scripts and tests. Everything in git history up to that commit.
- A prompt and research pack written by the team before and during the event (kept outside this repo).
- The look of the SAAKSHE film board (the filmmaker's own private page): its numbers, colours and card grammar were
  re-implemented as new React + CSS. No file of it was copied.
- Services used over their public APIs: Anthropic Claude, ElevenLabs, Kling, CopilotKit Intelligence, Ambiguous AI.

**What we built during the hackathon** (everything after the kit commit — `git log 6443333..HEAD`)
- The film store and the board for any film: create a film, add / rename / reorder / park / remove sections, WORLD
  (cast · locations · props) — `apps/web/src/lib/server/film-store.ts`, `film-ops.ts`, `app/api/films/**`,
  `components/board/**`, `components/world/**`.
- A read-only importer for an existing film board (no eval), plus a media route with a path allowlist and Range
  streaming — `lib/server/import-saakshe/**`, `app/api/media/**`, `lib/server/roots.ts`.
- The chat overlay floating over the board (CopilotKit `CopilotPopup`): one tool registry, agent context from the
  board and the edit, an Approve card — `components/overlay/**`, `components/vettu-control.tsx`, `vettu-ui.tsx`,
  `lib/contracts/tools.ts`.
- The edit: a timeline per section, FFmpeg previews in ~1.5 s, trims / moves / removes / transitions / words on
  screen, a 1080p final only after Approve — `lib/server/timeline.ts`, `lib/server/ffmpeg/**`, `app/api/cut/**`.
- Approve → 1080p → Ambiguous record (read back) → review queue → the Slack thread, and reviewer replies back as change
  orders — `lib/server/render-approvals.ts`, `review-queue.ts`, `change-orders.ts`, `apps/channel/src/review.tsx`.
- Background generators: Kling image→video from an existing shot's frame, ElevenLabs sound effects placed by their
  loudness peak — `lib/server/gen/**`, `app/api/jobs/**`.
- The Director: a Claude tool loop that queues generator jobs without waiting on them — `lib/server/director/**`.
- LIVE voice: an ElevenLabs agent calling the same tools as the typed chat — `lib/live/**`, `app/api/live-token/**`.

## Title and description

**What you built**
A film board that anyone can use for their own film, with an editor that listens. The board shows every section, card,
clip and cue. You type or say the cut — "hold S3 of §04 half a second longer", "rename §02 to THE BRIDGE" — and agents
make it: the edit changes, a preview renders, the board shows what moved. Slow work (animating a shot, adding a sound)
runs in the background. Nothing publishes until you click Approve: then VETTU renders the final cut, records it in
Ambiguous and queues it for the team's Slack review thread, where replies come back as change orders.

**Who it is for**
A solo filmmaker or a small team cutting a short film, whose plan, media and decisions live on one board.

**Why the context matters**
The agent edits the film you are looking at: it knows the sections, their lengths, the shots and the current edit,
so "the third shot of THE JOURNEY" means one exact clip and one exact second on the timeline. The review thread knows
which approved version a reply is about.

**Sponsor technologies used** — each with its visible part
| technology | what it does in VETTU |
|---|---|
| Anthropic Claude (`claude-opus-5`) | the typed overlay agent, the Slack reviewer agent and the Director loop |
| ElevenLabs | LIVE voice (an ElevenLabs agent on Claude Sonnet 5 calling VETTU's tools) and sound effects |
| Kling | image→video for a new shot made from an existing frame |
| CopilotKit (React v2 + Channels) | the chat overlay over the board, frontend tools, the Approve card, the Slack thread |
| Ambiguous AI | the record of each approved cut and a task for each change order, read back after saving |

## Evidence for the judging criteria
| criterion | where a judge sees it |
|---|---|
| Core requirements & functionality | video — typed "hold S3 of §04 half a second longer" → Claude calls `trim_shot` → a 540p preview renders (13 clips in ~1.5 s) → "Propose the final render" → Approve → 1080p render → Ambiguous record read back → queued → "Post latest cut" in Slack |
| Innovation & theme alignment | video — the agent edits the film board you are looking at; voice (ElevenLabs agent) and typed chat drive the same tools |
| Technical execution & integration | loopback + same-origin + session guards on every route, `If-Match` revisions (409 on stale writes), a realpath media allowlist (403 on escapes), FFmpeg argument arrays with one render at a time, refused edits that say why, jobs that can be cancelled; `npm run verify` from a clean clone |
| Usefulness & agentic experience | nothing publishes before the Approve click · slow Kling / ElevenLabs work runs as background jobs with visible status · the Director (a Claude tool loop) queues work and never waits on it · a spend guard caps one Kling clip per Director run |

## Verified on the day (local run, 12 Sep 2026)
- Importing the demo film gives exactly `PLAN 3:27 · M 3:27 · 100% · 38/38`, §04 `1:12.1–1:55.3`; the source folders were
  byte-for-byte unchanged afterwards (mtime + size check).
- Typed edit on `claude-opus-5`: S3 5.0 → 5.5 s, preview v1, the record pills unchanged.
- Approve → v1 rendered at 1080p, the Ambiguous record saved and read back, the cut queued for Slack.
- Director on Claude: one tool call per job, a job file on disk each; an ElevenLabs sound placed by its loudness peak;
  one Kling shot from a still frame of S13.
- LIVE: the server mints an ElevenLabs conversation token (the key never reaches the browser) and the LIVE button enables.

## Live, sample, session-only
- **Live:** Claude, ElevenLabs, Kling, CopilotKit Intelligence (Slack), Ambiguous.
- **Sample:** a clean clone opens a placeholder film (MY FIRST FILM). The demo imports the filmmaker's own film from
  local folders set in `.env`; no film media is in this repo.
- **Session-only:** the Slack thread's "waiting for notes" state lives in the channel process memory; a restart forgets
  it (re-mention the bot).
- **Not used:** the kit's OpenAI Realtime voice route remains in the tree, unlinked. The `openai` package added at
  kickoff is not used by any VETTU path.

## Run it from a clean clone
See [README.md](README.md): Node 22+ → `npm ci` → `cp .env.example .env` → `npm run dev:web` → the sample film.
