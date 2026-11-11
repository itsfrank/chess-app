# Local development

On this machine, shared backend dependencies are under `~/.local/share/chess-app/`. Before running the backend or engine integration tests in any worktree, source `~/.config/chess-app/env`; run `npm ci` separately in each worktree. See the “Shared setup on this machine” section of `README.md` for details. This setup is machine-specific, not guaranteed on other machines. Never print or commit credentials.
