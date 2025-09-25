# Copilot instructions for Lock of the Week

This repo is a small, single-file front-end demo with a tiny Node test harness and an optional proxy server. The guidance below highlights the project's architecture, important conventions, and concrete examples an AI agent should use before making edits.

Essentials (big picture)
- Single-page, no-build front end: `index.html` + `js/app.js` + `styles/styles.css`. Changes to `js/app.js` are shipped directly to the browser; there is no bundler/transpiler.
- `js/app.js` contains both browser UI code and the core parsing logic exported for Node tests. It uses a runtime-detection pattern: when `module.exports` exists the module will not auto-run the browser `start()`.
- Data flow: `loadUpcomingGames()` fetches ESPN scoreboard JSON (per-day URLs). `normalizeGames()` converts ESPN events into compact game objects. `parseSpreadFromOdds()` extracts spread and favorite from per-game odds objects. `pickOne()` picks a deterministic weekly 'lock' using `weeklySeed()` + `mulberry32()` PRNG.

Developer workflows / commands
- Tests: `npm test` runs the Node harness: it executes `node tests/parseSpread.test.js`. That file requires `../js/app.js` and calls the exported `parseSpreadFromOdds` function.
- Start: `npm start` references `node server/proxy.js`. There is no `server/` folder in this repository — treat `start` as conditional: only run if a proxy is added. For local browser testing, serve the working dir (e.g., `python -m http.server` or `npx serve`) and open `index.html`.

Project-specific conventions and gotchas
- UMD-like exports: `js/app.js` attaches core functions to both `window` (browser) and `module.exports` (Node). Keep that pattern if you split code into modules so tests and the browser both continue to work.
- No build step: keep ES2019+ syntax friendly to modern browsers; avoid adding features that require transpilation unless you add a build tool and update README/package.json.
- CORS / proxy behavior: `loadUpcomingGames()` first tries direct fetch to ESPN endpoints then falls back to a proxy at `/espn/scoreboard?dates=YYYYMMDD`. Any server/proxy added should expose that path and return ESPN's JSON shape.
- Parsing policy: `parseSpreadFromOdds(odds, home, away)` is conservative by design. If the parser cannot confidently match a team name in `odds.details`, it returns { spreadTeam: undefined, spread: undefined } rather than guessing. Preserve this conservative behavior in fixes/enhancements.

Concrete examples to reference
- parseSpread implementation: `js/app.js` — used by `normalizeGames()` and exported for tests. Tests are in `tests/parseSpread.test.js` which expects these behaviors:
  - details string like `"Notre Dame -6.5"` -> match full name and return favorite and magnitude.
  - abbreviated token (e.g. `ND`) should not spuriously match full names — test expects ambiguous abbreviations to return undefined for spreadTeam.
  - numeric per-team spreads (homeTeamOdds.spread / awayTeamOdds.spread) use sign to identify favorite.
- Deterministic picking: weekly seed uses Central Time week start logic (`weeklySeed()` and `seasonStartUTC`) and a Mulberry32 PRNG — keep the seed calculation intact if deterministic behavior is required.

When editing files
- If you move parsing logic into a new module, re-export with the same shape and keep the runtime guard (do not call `start()` when `module.exports` is present).
- If you add or change tests, update `package.json` scripts accordingly. Keep the simple Node test harness style (no test runner dependency) unless you also add a dependency and update package.json.

Integration points & external dependencies
- ESPN scoreboard API (site.api.espn.com) — callers expect the ESPN events/competitions JSON shape. Prefer defensive access (optional chaining) as already present.
- `package.json` lists server-side deps `express` and `node-fetch` — these are likely for a proxy (not included). If you implement `server/proxy.js`, use those packages and expose `/espn/scoreboard` so `js/app.js` can fall back when direct fetch fails.

Contract (mini)
- Function: parseSpreadFromOdds(odds, home, away)
- Input: odds (object or null), home (string), away (string)
- Output: { spreadTeam: string|undefined, spread: number|undefined }
- Error modes: returns undefined fields rather than throwing when parsing is ambiguous or missing.

Edge cases to preserve
- Do not default a missing favorite to the home team.
- When `odds.details` contains a numeric but the textual team fragment doesn't confidently match home/away, return undefined spreadTeam.

Files worth reading first
- `js/app.js` (single source of truth for parsing, fetching, UI)
- `tests/parseSpread.test.js` (reveals expected parser behavior)
- `index.html` (shows runtime assumptions: fonts, DOM ids, script loading)

If anything above looks wrong or you want added examples (API responses, more test cases, or a suggested `server/proxy.js` implementation), tell me which part to expand and I'll iterate.
