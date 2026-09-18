# VETTU

வெட்டு, "the cut". A film board with an editor that listens. The board shows your film's sections, cards, clips and
cues. You type or say the cut ("hold S3 of §04 half a second longer") and agents make it: the edit changes, a preview
renders, the board shows what moved. Nothing publishes until you click Approve. Built in one day at AI Tinkerers
*Agents, Everywhere*, Hyderabad, 12 Sep 2026, on the
[CopilotKit agents-everywhere starter kit](https://github.com/CopilotKit/agents-everywhere-starter-kit).
See [SUBMISSION.md](SUBMISSION.md) for what was inherited and what was built.

## Run it

Node.js 22+ and FFmpeg at `/opt/homebrew/bin/ffmpeg` (macOS Homebrew). Python 3 with Pillow draws words on screen.

```bash
git clone https://github.com/Bashocodes/vettu.git
cd vettu
npm ci
cp .env.example .env
```

Fill in `.env` (never commit it):

```dotenv
MODEL_PROVIDER=anthropic
MODEL=anthropic:claude-opus-5
ANTHROPIC_API_KEY=your-key
```

Then:

```bash
npm run dev:web
```

Open http://127.0.0.1:3100. VETTU opens a placeholder film. Open the chat bottom right and say the cut.

```bash
npm run verify
```

Typechecks and offline tests. Needs no keys.

The Slack review thread, LIVE voice and film import are optional. See the full README.

## The two pages

| page | what it shows |
|---|---|
| `/?film=<id>` — **BOARD** | film bar (VETTU · film name menu · BOARD/WORLD · § chips), the header maths (PLAN · M · % · clips · seconds left), the running cut, one slab per section with its cards, the YOUR EDIT strip and the VETTU preview |
| `/world?film=<id>` — **WORLD** | cast · locations · props, with member rows, tabs and slot cards |

The chat overlay (CopilotKit `CopilotPopup`) floats over both pages without moving the board. Typed chat, LIVE voice
and the Director call the **same tool registry** (`apps/web/src/lib/contracts/tools.ts`) and the same guarded routes.

## Environment

| name | needed for |
|---|---|
| `MODEL_PROVIDER` · `MODEL` · `ANTHROPIC_API_KEY` | the overlay agent, the Slack reviewer and the Director |
| `VETTU_DATA_DIR` | VETTU's store: films, timelines, versions, jobs, review queue (default `.data/vettu`, git-ignored) |
| `VETTU_WORK` | the only folder FFmpeg and uploads write to (absolute path) |
| `AMBIGUOUS_API_KEY` | records of approved cuts and change-order tasks |
| `KLING_API_KEY` | animate a new shot from an existing frame |
| `ELEVENLABS_API_KEY` · `ELEVENLABS_AGENT_ID` | sound effects · LIVE voice |
| `INTELLIGENCE_API_KEY` · `CHANNEL_CODE` · `PORT` · `VETTU_WEB_URL` | the Slack review thread (channel process) |
| `FILM_REPORTS_DIR` · `FILM_ROOT` · `LABS_OUT` · `FILM_RUNNING_CUT` | optional: import an existing film board (read-only) |

Both processes read `.env` only at start: restart them after every change.

## Optional: import an existing film board

Set the four `FILM_*` paths and restart. The film menu then offers **Import**. The importer reads the board's state and
index files as text (never executed), and media is served only through `/api/media` from those roots after a realpath
allowlist check. VETTU never writes into those folders.

## The Slack review thread (second process)

1. In CopilotKit Intelligence, create a Channel with the Slack adapter and install the Slack app it generates.
2. Put its code in `CHANNEL_CODE` and a project key in `INTELLIGENCE_API_KEY`; keep `VETTU_WEB_URL=http://127.0.0.1:3100`.
3. `npm run channel:status`, then start the listener — **not** `dev:slack` (its `--watch` restart silently kills posted buttons):

```bash
npm run start --workspace channel
```

4. `/invite` the bot to the review channel and mention it by picking the autocomplete. It posts a card with
   **Post latest cut**: approved cuts arrive as an MP4 plus a review card (Approve / Request changes). A reply after
   "Request changes" becomes a change order in VETTU and a task in Ambiguous.

Slack cannot be pushed to from the web app; the channel pulls the queue on the next Slack event.

## LIVE voice (ElevenLabs)

Create an ElevenLabs agent (LLM Claude Sonnet 5, authentication on) with client tools named exactly as in
`apps/web/src/lib/contracts/tools.ts`, each with **Wait for response**. Put its id in `ELEVENLABS_AGENT_ID`. The server
mints a short-lived conversation token at `/api/live-token`; the API key never reaches the browser.

## Safety rails

- **Nothing publishes by itself.** `propose_render` only prepares; the Approve click renders 1080p, writes Ambiguous
  and queues Slack.
- Every route is loopback-only; browser writes need a same-origin JSON request with a session cookie; the film store
  uses `If-Match` revisions (409 on a stale write).
- FFmpeg runs with argument arrays, one preview at a time, inputs only from allowed roots, outputs only in `VETTU_WORK`.
- Words on screen are drawn by Pillow, never by a model.

## License

MIT. Starter kit © 2026 CopilotKit; VETTU additions © 2026 Sharan Ramakrishna. See [LICENSE](LICENSE).

Film media is never part of this repository.

Made by cyberyogi (Sharan Ramakrishna). Everything I make: https://inkoji.com/cyberyogi
