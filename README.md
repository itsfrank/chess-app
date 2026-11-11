# Chess companion

Local-first chess board with on-demand Pi chat, native Stockfish analysis, and colored arrows linked to chat text.

## Run

Use a current Node.js LTS (22.12+ or 24 recommended), a native `stockfish` executable on PATH, and an existing Pi login for `openai-codex/gpt-6-luna`.

```sh
npm install
npm run server  # terminal 1: backend on 127.0.0.1:3001
npm run dev     # terminal 2: open the Vite loopback URL
```

Set `STOCKFISH_PATH` when the engine is not on PATH. Pi's SDK reads your existing local Pi credentials/catalog. The backend explicitly selects `openai-codex/gpt-6-luna`; there is no model fallback. Credentials are never sent to the frontend. Missing credentials or model errors appear in chat.

## Behavior

- Legal drag-and-drop and click-to-move, promotion, undo/reset, board flipping.
- Each legal move (including promotion) queues a brief agent review of that exact position. Undo/reset do not trigger reviews. Chat questions also start agent turns. Reviews run sequentially while you can continue playing and drafting.
- Pi has three active tools: `analyze_position`, `set_arrows`, and `lichess_moves`. No coding tools or discovered extensions, skills, templates, or context files.
- Stockfish searches for 1.5 seconds using MultiPV=3, one thread, and 32 MB hash. Results use a complete common depth, White-perspective scores, and short continuations. Fewer legal moves means fewer candidates. Mate scores remain explicit.
- Agent analysis can apply hypothetical moves without changing your board.
- Text streams to chat. Colored move links emphasize position-scoped SVG arrows on hover, focus, or tap. Responses remain attached to the submitted position while you keep playing.
- Stop cancels the frontend request and aborts the active agent/engine operation.
- Conversations are in memory; restarting the backend clears them. Idle conversations expire after an hour on subsequent requests; limit 10 conversations.
- Chat shows current-conversation and lifetime tokens/cost. Lifetime totals are atomically saved after each finalized assistant message to `.data/usage.json` and loaded after restarts. This file is ignored by git: preserve it when moving the app. USD values are Pi's reported estimates, not charges against your Codex subscription. Zero may mean model pricing was unavailable. Historical usage from before this feature cannot be recovered.

The app is local-only, not hardened for public hosting. A future hosted release needs authentication, per-user credential/session isolation, resource quotas, deployment/static serving, and a Stockfish distribution license review. Model requests send the chat and position to the configured provider.

## Play against Maia3

Choose **Play Maia3**, your side and an opponent rating, then **New game**. The default board remains a free analysis board until you start a game. Settings apply only when starting a new game; changing them does not silently replace a game in progress. Maia3 5M runs locally on CPU in one persistent subprocess, separately from Stockfish. Its subprocess sets `OMP_NUM_THREADS=1` and `MKL_NUM_THREADS=1` to limit CPU contention on shared hosts; these settings do not affect the backend or Stockfish. Rating is a human-play style target, not a calibrated competitive rating.

- You can play either color; Maia3 opens automatically when you choose Black. Flip changes orientation, not your playing side.
- **Take back** returns to your previous decision (removing the opponent reply too). Taking back Maia3's opening pauses it until **Resume Maia3**.
- **Left / Right arrow keys**, navigation buttons and clickable move history browse the game so far. Earlier positions are read-only; **Return to live game** resumes the live board. Arrow keys retain their normal behavior in text fields and selects. Browsing does not erase moves or request new opponent moves.
- Reset/new game cancel stale opponent responses. Failures show a retry action without changing the position.
- Automatic coaching is off by default against Maia3 to avoid generating model requests for every move. Enable the checkbox for automatic Stockfish-backed reviews, or ask chat about any live/historical position. Analysis-board move reviews remain automatic.
- Opponent play is disabled during offline session replay. Maia3 games themselves are not added to the chat replay format; chat/coaching turns retain existing recording behavior.

Install Maia3 into a separate Python environment and pre-cache its 5M model before use (Python 3.10+; see https://github.com/CSSLab/maia3). The backend uses `MAIA3_PATH` for the `maia3-uci` executable, otherwise the existing `.data/maia3-spike/venv/bin/maia3-uci` if present, otherwise `maia3-uci` on PATH. `HF_HOME` selects the checkpoint cache; absent that setting, the existing spike cache is reused when present. Inference uses `--local-files-only`: it will not download weights during play. Missing installation/cache errors appear beside the board. The initial local setup is already installed in `.data/maia3-spike/` on this machine.

```
MAIA3_PATH=/absolute/path/to/venv/bin/maia3-uci HF_HOME=/path/to/cache npm run server
TEST_MAIA3=1 npm test  # exercises the installed Maia3 engine too
```

Maia3 code is AGPL-3.0. Review code/weight terms before redistribution or public hosting.

Browser workflow testing used real browser clicks, keys and the live CPU engine: complete games as both colors, promotion, takebacks, side/orientation, history navigation, retry, delayed-response reset, and mobile sizing. Local harness, logs, game PGNs in JSON, and screenshots are under `.data/browser-test/` (git-ignored).

## Lichess move frequencies

`lichess_moves` queries the authenticated Lichess Opening Explorer for the submitted position or hypothetical continuations. It returns the top 12 moves with empirical frequency, sample counts, White wins/draws/Black wins, filters and source URL. Frequencies use all games at the position as denominator, not just returned moves. Defaults: all rating buckets and all time controls; the agent may filter either. Rating buckets extend to the next bucket (e.g. 1600 means 1600–1799).

Configure `LICHESS_TOKEN` in the backend environment or an owner-readable `.data/lichess-token` file. Do not paste credentials into agent chat. The official endpoint returned 401 during integration testing without a token; authenticated access has since been verified successfully. API docs: https://github.com/lichess-org/api/blob/master/doc/specs/tags/openingexplorer/lichess.yaml

Queries are serialized, spaced at least one second apart, cached for an hour (up to 200 entries), and have a 12-second timeout. HTTP 429 pauses requests for at least a minute without automatic retries. Tool inputs/results are recorded, but request headers and tokens are not. Offline session replay never queries Lichess. Database frequencies describe the selected rated sample, not the likelihood of a specific opponent's move or engine strength; missing/small samples must be treated cautiously.

## Recording and deterministic replay

Accepted live chat/move-review turns are recorded automatically in `.data/sessions/<uuid>.jsonl`, one file per conversation. The backend prints the path when a conversation starts. Records have a version, monotonic sequence number, and timestamp. They include:

- Session model/system prompt and engine settings.
- Submitted messages, FENs and move history.
- Finalized agent messages (including tool calls, reasoning when supplied, and usage), tool results, retry/lifecycle events.
- Raw UCI input/output/stderr and the complete ordered frontend event stream.
- Errors, disconnect markers and turn completion.

No HTTP headers, credential files or authorization tokens are recorded. Chat, model reasoning and board history **are private data**: recordings are local, git-ignored, owner-readable and not automatically rotated. Delete unwanted recordings or copy a reviewed fixture into your test directory. Existing sessions from before recording was enabled cannot be recovered.

To replay through the existing frontend, stop the live backend and run:

```sh
npm run replay -- .data/sessions/<uuid>.jsonl
```

Keep Vite running and refresh the app to start a fresh frontend conversation. Reproduce the same sequence of moves and messages. Each request must match the recorded message, FEN and move history exactly; a mismatch fails without consuming the expected turn. Conversation IDs in requests are ignored during replay. All recorded text chunks, arrows, analyses, errors and usage events are returned in their original order. Requests make **no model/engine calls**, and recorded usage does **not** increment lifetime totals. Restart replay to rewind.

`PORT=3002 npm run replay -- <file>` runs a separate replay API for HTTP tests without replacing the live backend. `REPLAY_LOG=<file> npm run server` is equivalent. In-process tests can use `Replay.next(input)` from `server/recording.ts`.

Scope: this is deterministic **API event playback**, not a new model run, Pi conversation resumption, a browser-action recorder, or a reproduction of original wall-clock delays. Playback emits immediately. Incomplete/disconnected recordings are rejected rather than replayed as if complete; raw records remain available for debugging. Standalone board navigation without a submitted review/question isn't logged separately.

## Checks

```sh
npm run build
npm run typecheck:server
npm test
TEST_STOCKFISH=1 npm test  # includes the installed native engine integration test
```

Browser interaction was manually checked by the user for the initial board spike. Pi + Stockfish + arrows + streamed text were checked through the HTTP API; the integrated chat has not been browser-automated.
