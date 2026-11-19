# Chess companion

A local chess board with an AI companion. Play both sides on an analysis board, play against
Maia3, or go through your chess.com games, and ask the companion about any position. It checks Stockfish before making engine claims and
draws coloured arrows on the board that are linked to the moves in its answer.

Everything runs on your machine. The only network traffic is the chat itself (sent to the model
provider), optional Lichess opening-explorer lookups, and chess.com's public game archive when you
list your games.

## Requirements

- Node.js 22.12 or newer.
- A native `stockfish` executable on `PATH` (or set `STOCKFISH_PATH`).
- A Pi login that can use `openai-codex/gpt-6.1-sol`, which runs at medium reasoning effort. The
  backend uses your existing local Pi credentials; they are never sent to the browser. There is no
  fallback model.
- Optional: Maia3 for opponent play and a Lichess token for move frequencies (both below).

## Run

```sh
npm install
npm run server  # terminal 1: API on 127.0.0.1:3001
npm run dev     # terminal 2: open the URL Vite prints
```

Stockfish, Maia3 and the Lichess token are located through the environment variables below.

| Variable         | Purpose                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `PORT`           | API port (default 3001; the Vite proxy expects 3001).                    |
| `STOCKFISH_PATH` | Stockfish executable, when it is not on `PATH`.                          |
| `MAIA3_PATH`     | `maia3-uci` executable.                                                  |
| `HF_HOME`        | Hugging Face cache holding the Maia3 weights.                            |
| `LICHESS_TOKEN`  | Lichess personal access token for the opening explorer.                  |
| `REPLAY_LOG`     | Serve a recorded session instead of the live model (see **Replay**).     |
| `CHESS_MODEL`    | Another `openai-codex` model id for the companion, such as `gpt-6-luna`. |
| `CHESS_THINKING` | Its reasoning effort (`low`, `medium`, `high`); default `medium`.        |

### Shared setup on this machine

The local setup stores Stockfish, Maia3, its model cache, and the Lichess token under
`~/.local/share/chess-app/`. In any worktree on this machine, run `npm ci` once, then source
`~/.config/chess-app/env` before `npm run server`. This sets the engine paths, Hugging Face cache, and
Lichess token; the environment file and token are private. Pi credentials remain in the user's Pi
configuration. Other machines need their own setup. Do not commit credentials or print the
environment file's expanded values.

## Using it

**Board.** Drag or click to move; promotion asks for a piece. Undo, flip and **New game** are below
the board. The Left/Right arrow keys and the navigation buttons browse the game so far; the chevron in
the bottom-left corner opens the move list. Earlier positions are read-only until you return to the
live position. The strip along the bottom shows the displayed position's FEN.

**Analysis.** The bar beside the board shows Stockfish's evaluation of the displayed position from
White's perspective. The panel above the chat lists the top three engine lines, or on the
**Explorer** tab the most played Lichess moves; **Show arrows** draws them on the board as dotted
arrows. This runs for every position you look at and does not use the model.

**Companion.** Ask a question about whatever position the board is showing, live or historical.
Answers stream in under a heading naming the move they follow; click a heading to return to that
position. Moves in the answer are
links: hover, focus or tap one to emphasise its arrow. Typing anywhere on the page continues your
draft. **Stop** cancels the running turn, including any engine search.

**Automatic coaching.** With **Coach every move** on, every move played is queued for a short Stockfish-backed
review. It is on by default on the analysis board and off by default against Maia3, because each
review is a model request. Turns run one at a time; questions you ask jump ahead of queued reviews.

**Usage.** The strip along the bottom shows tokens and estimated cost for this conversation and for all time.
Lifetime totals are saved to `.data/usage.json`. The dollar figures are Pi's estimates, not charges
against a subscription, and zero can mean pricing was unavailable.

Conversations live in backend memory: restarting the backend or reloading the page starts a new one.
The backend keeps the ten most recently used.

## Reviewing your chess.com games

**My games**, in the bottom-left corner, lists a chess.com player's games. Enter a username and
press **Load games**: the 50 most recent standard games are fetched from chess.com's public archive,
which needs no login, and **Load older games** fetches the next 50. Variants and games from a custom
position are left out. The username is remembered in the browser.

Choose a game to put it on the board, oriented to the side you played. Step through it with the move
list, the navigation buttons or the Left/Right arrow keys; the evaluation bar and the analysis panel
follow along. The board is read-only: it shows the game as played.

**Move quality.** Opening a game starts a Stockfish pass over every position (depth 16 with the two
best lines, around twenty seconds for a typical game the first time; results are cached in `.data/game-eval-cache.json`). Each move is then labelled
by the winning chances it gave up for the side that played it: **Best** is the engine's own move,
**Excellent** loses at most 2 percentage points, **Good** 5, **Inaccuracy** 10, **Mistake** 20, and
anything more is a **Blunder**. A best move becomes **Great**, the blue `!`, when it was the only
good one: the engine's second choice would have cost more than 10 points, and the move was not a
recapture or the capture of a piece worth at least the one taking it. Opening moves are **Book**
while they are common among strong players in the Lichess explorer (at least 5% of games rated
2000 and up, within the first 15 moves, and not an engine error); this needs the Lichess token and
is skipped without it. The move list marks great
moves with `!`, best moves with ★ and errors with `?!`, `?` and `??`, the board pins the label to the move just played, and the table above the analysis panel
counts each label per player and gives each side's **accuracy** out of 100. Winning chances and
accuracy use Lichess's published formulas, so the labels and numbers will be close to chess.com's
game review but not identical; there are no Brilliant or Miss labels.

Ask the companion about the position on the board. With each question it also gets the players, the
ratings, the result and every move of the game, so it knows which side you had and what happened
later, and once the engine pass has finished it gets the accuracies and every inaccuracy, mistake and
blunder too. Its own engine checks start from the position shown, or from the one before the move
just played when you ask why that move was good or bad, and reach at most 20 half-moves further
into the game.

When you have a repertoire for the colour you played, a **Repertoire** line under the table says
where the game left it: by your move (with the move the repertoire plays), by your opponent's, or
at the end of a line. **Show** jumps to that move.

**Explain**, beside the verdict on the shown move, steps the board back to where that move was
chosen and asks the companion to compare it with the engine's choice, with an arrow for each. Each game has its own conversation, kept until you choose another game. **← Games** returns to
the list and **Back to game** to the review.

## Simplifying a repertoire

**Repertoire**, in the bottom-left corner, switches from the board to a screen for opening
repertoires; the game and conversation on the board are kept. **Import PGN** takes an export with
variations, such as one from Chessbook. Positions reached by different move orders are folded into
one, and the header shows how many positions you actually have to know a move in.

- **Proposals** are single-move changes that would make the repertoire smaller or more regular: a
  move that returns to positions you already know, or the move you usually play with your pieces
  arranged that way. Each shows the change in positions to know (an upper bound, marked `≤`, when
  some replies would need a new line), the engine's score against your current move, and how the
  line continues. Select one to see it on the board.
- **Your games** compares the repertoire with what you actually play. Enter your chess.com
  username and press **Check my games**: your last 300 or so games are fetched, and those you played
  as the repertoire's colour are followed through it until they leave. The summary says how often you
  left first and how often your opponent did, and each move you played instead of the repertoire's
  is listed as a proposal to adopt it, with how many games you played it in and how often you played
  the repertoire move there instead. A proposal is marked **suggested** when you played the move
  more than once, at least as often as the repertoire move, and Stockfish scores it within the
  tolerance. Reaching a known position by another move order counts as following the repertoire.
  Accepting works like any other proposal; the games are kept with the repertoire, so the list is
  recounted after each change. Only the first 30 moves of each game are compared.
- **Unsound** lists repertoire moves that lose half a pawn or more to the engine's choice.
- **Rules** groups positions by where your own pieces stand and shows what you play from each,
  with the exceptions.
- **Accepted** is the record of changes you accepted, as deviations from the imported PGN. The
  import itself is never modified, and a change can be reverted.

**Analyse** evaluates every position, and the position after every proposed move, with Stockfish at
a fixed depth, and fetches how often opponents in the chosen rating range play each move from the
Lichess explorer (blitz, rapid and classical; needs the token below). Both run in the background,
can be stopped and resumed, and are cached in `.data/`, so each position is only searched once.
Until then proposals are structural only. A proposal within the **Tolerance** of your current move
counts as sound; the others stay listed, marked as unsound. A proposal is scored at its worst
point: the position after the move, or any known position its continuation rejoins. The engine
compares scores, not plans, so a sound proposal can still leave a structure you like less.

Repertoires and accepted changes are stored in `.data/repertoires/`. There is no PGN export yet.

## Playing against Maia3

Press **New game**, choose **Play Maia3**, a side and a rating, then **Start game**. The choices are
remembered, so **New game** then **Start game** restarts with the same setup. Maia3 (the 5M model) runs on CPU in one persistent subprocess and aims to play like a human of
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

Reload the app and repeat the same moves and messages (for a reviewed game, step to the same
positions). Each request must match the recorded message,
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
  repertoire.ts     position graph of a PGN  consolidation.ts  proposals and rules
  soundness.ts      engine verdicts, move frequencies
  habits.ts         a player's games against a repertoire
  quality.ts        move labels and accuracy for a reviewed game
server/   Local HTTP API
  index.ts      startup and shutdown        app.ts         routing
  chat.ts       conversations and turns     tools.ts       the agent's three tools
  stockfish.ts  analysis engine             opponent.ts    Maia3 subprocess
  lichess.ts    opening explorer            recording.ts   session recording and replay
  chesscom.ts   a player's game archive     snapshot.ts    request validation
  game-review.ts  engine pass over a game for move quality
  repertoires.ts  imported repertoires and their analysis   evaluator.ts  fixed-depth Stockfish
src/      React frontend
  App.tsx       game state and layout       hooks/         chat queue, opponent, analysis
  Root.tsx      board / games / repertoire  components/Repertoire*.tsx  the repertoire screen
  components/Games.tsx  chess.com game list and review
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
