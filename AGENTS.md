# Local development

On this machine, shared backend dependencies are under `~/.local/share/chess-app/`. Before running the backend or engine integration tests in any worktree, source `~/.config/chess-app/env`; run `npm ci` separately in each worktree. See the “Shared setup on this machine” section of `README.md` for details. This setup is machine-specific, not guaranteed on other machines. Never print or commit credentials.

# Git workflow

When the work is on `main`, commit to `main` and push to `origin/main` unless told otherwise. Do not create a branch first.

# Board screenshots (chat / mobile)

When the user isn't running the app in a browser and wants a board image in chat, use `scripts/board-shot.ts` (never hand-write HTML/SVG). It outputs Retina PNG paths (default `.data/shots/`) that can be embedded directly with `![alt](/abs/path.png)`.

Single board:

```bash
node scripts/board-shot.ts -m "1. d4 Nf6 2. c4 g6 3. Nc3 Bg7" -a "e4:green:4. e4" -a "Nf3:blue/dashed:4. Nf3" -t "KID — 3…Bg7" -e "+0.45"
```

- `-m/--moves` accepts PGN or space-separated SAN/UCI; `-f/--fen` sets start FEN; `--flip` views from Black.
- `-a/--arrow` accepts legal SAN or squares: `<san|from-to>[:color[/dashed|dotted][:label]]`.
- `-H/--highlight <sq[,sq...]>[:color[:label]]`, `-b/--badge <sq>:<glyph>[:color]`, `-e/--eval <score>`, `-t/--title`, `-s/--subtitle`, `--note`, `-o/--out`, `--out-dir`, `--markdown`.

Multiple boards in one fast Chrome session (`--batch` reads a JSON `BoardSpec` or `BoardSpec[]` from stdin or a file):

```bash
node scripts/board-shot.ts --batch <<'EOF'
[
  { "out": "kid", "title": "Fianchetto KID — 6…c5", "moves": "d4 Nf6 Nf3 g6 c4 Bg7 g3 d6 Bg2 O-O O-O c5", "arrows": [{ "san": "Nc3", "color": "red", "label": "Remove: 7. Nc3" }, { "san": "d5", "color": "green", "label": "Replace: 7. d5" }] }
]
EOF
```
