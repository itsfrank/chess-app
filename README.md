# Chess companion

A local chess board with an AI companion. Play both sides on an analysis board or play against
Maia3, and ask the companion about any position. It checks Stockfish before making engine claims and
draws coloured arrows on the board that are linked to the moves in its answer.

Everything runs on your machine. The only network traffic is the chat itself (sent to the model
provider) and optional Lichess opening-explorer lookups.

## Requirements

- Node.js 22.12 or newer.
- A native `stockfish` executable on `PATH` (or set `STOCKFISH_PATH`).
- A Pi login that can use `openai-codex/gpt-6-luna`. The backend uses your existing local Pi
  credentials; they are never sent to the browser. There is no fallback model.
- Optional: Maia3 for opponent play and a Lichess token for move frequencies (both below).

## Run

```sh
npm install
npm run server  # terminal 1: API on 127.0.0.1:3001
npm run dev     # terminal 2: open the URL Vite prints
```

Stockfish, Maia3 and the Lichess token are located through the environment variables below.

| Variable         | Purpose                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `PORT`           | API port (default 3001; the Vite proxy expects 3001).                |
| `STOCKFISH_PATH` | Stockfish executable, when it is not on `PATH`.                      |
| `MAIA3_PATH`     | `maia3-uci` executable.                                              |
| `HF_HOME`        | Hugging Face cache holding the Maia3 weights.                        |
| `LICHESS_TOKEN`  | Lichess personal access token for the opening explorer.              |
| `REPLAY_LOG`     | Serve a recorded session instead of the live model (see **Replay**). |

### Shared setup on this machine

The local setup stores Stockfish, Maia3, its model cache, and the Lichess token under
`~/.local/share/chess-app/`. In any worktree on this machine, run `npm ci` once, then source
`~/.config/chess-app/env` before `npm run server`. This sets the engine paths, Hugging Face cache, and
Lichess token; the environment file and token are private. Pi credentials remain in the user's Pi
configuration. Other machines need their own setup. Do not commit credentials or print the
environment file's expanded values.

## Using it

**Board.** Drag or click to move; promotion asks for a piece. Undo, reset and flip are below the
board. The Left/Right arrow keys, the navigation buttons and the move list browse the game so far;
earlier positions are read-only until you return to the live position.

**Analysis.** The bar beside the board shows Stockfish's evaluation of the displayed position from
White's perspective. The panel above the chat lists the top three engine lines, or on the
**Explorer** tab the most played Lichess moves; **Show arrows** draws them on the board as dotted
arrows. This runs for every position you look at and does not use the model.

**Companion.** Ask a question about whatever position the board is showing, live or historical.
Answers stream in and stay attached to the position they were asked about. Moves in the answer are
links: hover, focus or tap one to emphasise its arrow. Typing anywhere on the page continues your
draft. **Stop** cancels the running turn, including any engine search.

**Automatic coaching.** With the checkbox on, every move played is queued for a short Stockfish-backed
review. It is on by default on the analysis board and off by default against Maia3, because each
review is a model request. Turns run one at a time; questions you ask jump ahead of queued reviews.

**Usage.** The chat header shows tokens and estimated cost for this conversation and for all time.
Lifetime totals are saved to `.data/usage.json`. The dollar figures are Pi's estimates, not charges
against a subscription, and zero can mean pricing was unavailable.

Conversations live in backend memory: restarting the backend or reloading the page starts a new one.
The backend keeps the ten most recently used.

## Playing against Maia3

Choose **Play Maia3**, a side and a rating, then **New game**. Settings only apply when a new game
starts. Maia3 (the 5M model) runs on CPU in one persistent subprocess and aims to play like a human of
the chosen rating; the rating is a style target, not a calibrated strength. Its subprocess is limited
to one thread (`OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`) to avoid CPU contention; this does not affect
the backend or Stockfish.

- Maia3 moves first when you choose Black. Flipping the board does not change your side.
- **Take back** returns to your previous decision, removing Maia3's reply as well. Taking back its
  opening move pauses it until you press **Resume Maia3**.
- If Maia3 fails or times out, the position is unchanged and you can retry or pause.

Install Maia3 in its own Python environment (3.10+) and download the 5M model beforehand; see
<https://github.com/CSSLab/maia3>. The backend runs it with `--local-files-only`, so it never
downloads weights during play. It looks for the executable in `MAIA3_PATH`, then
`.data/maia3-spike/venv/bin/maia3-uci`, then `PATH`, and uses `.data/maia3-spike/huggingface` as the
weights cache unless `HF_HOME` is set.

## Lichess move frequencies

When asked how popular or likely a move is, the companion can query the Lichess opening explorer. It
gets the top 12 moves with game counts and results, filtered by rating bucket and time control (all
of them by default). Frequencies are proportions of every rated game at that position in the sample,
not predictions for a particular opponent and not engine evaluations.

The explorer requires a personal access token: set `LICHESS_TOKEN` or put the token in
`.data/lichess-token`. Never paste it into the chat. Requests are made one at a time, at least a
second apart, with a 12-second timeout, and results are cached for an hour. After an HTTP 429 the
backend stops querying for at least a minute.

## Recording and replay

Every live chat turn is recorded to `.data/sessions/<uuid>.jsonl`, one file per conversation; the
backend prints the path when a conversation starts. A recording contains the model, system prompt and
engine settings, each submitted message and position, the agent's finalised messages and tool calls,
raw engine input/output, and the exact events sent to the browser. It contains no credentials or HTTP
headers, but it does contain your chat, so treat the files as private. They are not rotated.

To replay a recording through the real frontend without calling the model:

```sh
npm run replay -- .data/sessions/<uuid>.jsonl
```

Reload the app and repeat the same moves and messages. Each request must match the recorded message,
position and move history exactly; a mismatch is reported and does not consume the turn. Events come
back in their original order, immediately rather than with the original timing. Replayed usage is not
added to lifetime totals, and opponent play is unavailable; the analysis panel still works. Restart the replay server to rewind.
Recordings with an interrupted turn are rejected.

## Development

```sh
npm run check        # type-check, lint, format check and unit tests
npm run format       # apply Prettier
npm run build        # production build of the frontend
TEST_STOCKFISH=1 TEST_MAIA3=1 npm test   # also exercise the installed engines
```

```
shared/   Used by both sides: the wire protocol, SAN recognition and the arrow palette
server/   Local HTTP API
  index.ts      startup and shutdown        app.ts         routing
  chat.ts       conversations and turns     tools.ts       the agent's three tools
  stockfish.ts  analysis engine             opponent.ts    Maia3 subprocess
  lichess.ts    opening explorer            recording.ts   session recording and replay
src/      React frontend
  App.tsx       game state and layout       hooks/         chat queue, opponent, analysis
  components/   board, chat, analysis panel annotations.ts move links in rendered Markdown
  style.css     appearance                  layout.css     sizing and breakpoints
docs/design/  Redesign screenshots and a script that generates a synthetic replay fixture
```

The agent can only use `analyze_position`, `set_arrows` and `lichess_moves`; the backend refuses to
run a session with any other tool active. The model's move links are never trusted: the backend asks
it to correct a link that points at the wrong arrow (at most twice, then hides the arrows), and the
frontend re-points or unlinks anything that still does not match.

## Limits and licences

The API binds to loopback and rejects requests from non-local web origins, but it is not hardened for
hosting: there is no authentication, per-user isolation or quota. Maia3 is AGPL-3.0 and Stockfish is
GPL-3.0; review both, and the Maia3 weight terms, before redistributing or hosting this.
