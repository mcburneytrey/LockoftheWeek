# Lock of the Week — Local dev & proxy

This repo is a single-page demo that fetches ESPN scoreboard JSON and picks a weekly "lock." The client attempts a direct fetch to ESPN and falls back to a proxy at `/espn/scoreboard?dates=YYYYMMDD` to avoid CORS issues.

Quick start (local)

1. Install dependencies

```bash
cd /path/to/LockoftheWeek
npm install
```

2. Start the server (serves static files and provides the ESPN proxy)

```bash
npm start
# or
node server/proxy.js
```

This starts an HTTP server on http://localhost:3000 by default. It serves `index.html` and the `js/` and `styles/` assets, and exposes `/espn/scoreboard?dates=YYYYMMDD` which proxies to ESPN's scoreboard API.

Verify the proxy

```bash
curl "http://localhost:3000/espn/scoreboard?dates=20250925" | jq '.events | length'
```

Open the app

Visit http://localhost:3000 in your browser. The client will try to fetch ESPN data; if CORS would block a direct fetch the client will call the proxy instead.

Notes
- The proxy sets permissive CORS headers for convenience. For production, lock down allowed origins.
- There's a small in-memory cache with a 30s TTL to reduce upstream calls.
- `npm test` runs the Node test harness: `node tests/parseSpread.test.js`.

If you'd like, I can:
- Expand the proxy to include more endpoints or stricter caching.
- Add a TypeScript rewrite or tests for the pick algorithm.
- Start adding AI-based analysis code to suggest picks (next step).

OpenAI integration

You can enable a server-side OpenAI integration for richer analysis by setting an environment variable:

```bash
export OPENAI_API_KEY="sk_..."
export OPENAI_MODEL="gpt-4o-mini" # optional, defaults to gpt-4o-mini
node server/proxy.js
```

Once the key is set, the server exposes `POST /api/analyze` which accepts `{ games: [...], seed?: number }` and returns a JSON `{ list: [...], recommendation: {...} }` either from OpenAI or the local heuristic as a fallback.

Example request (curl):

```bash
curl -X POST http://localhost:3000/api/analyze -H 'Content-Type: application/json' -d '{"games":[{"home":"A","away":"B","spread":3,"spreadTeam":"A","kickoff":"2025-09-25T20:00:00Z"}]}' | jq .
```

Security note: keep your OpenAI API key server-side. This server proxies OpenAI requests and does not expose keys to the browser.

Optional enrichment feeds

You can configure two optional feeds for richer analysis:

- `INJURY_FEED_URL` — The proxy will call `${INJURY_FEED_URL}?team=TEAM_NAME` and expect JSON describing injuries (simple key/value or array). Example response:

```json
{ "injuries": [ { "player": "Q. Quarterback", "status": "questionable" } ] }
```

- `MARKET_FEED_URL` — The proxy will call `${MARKET_FEED_URL}?home=HOME&away=AWAY` (or fallback to `?team=NAME`). The expected shape for matchup market data:

```json
{ "impliedHome": 0.62, "impliedAway": 0.38, "total": 55.5 }
```


## Using OpenAI to predict game outcomes

This project already exposes `POST /api/analyze` which, when `OPENAI_API_KEY` is set, will call OpenAI to score and rank matchups. Below is a short guide to using OpenAI effectively for outcome prediction, plus examples and testing tips.

What the server expects
- Request body: { games: [ { home, away, spreadTeam, spread, kickoff, ... } ], seed?: number }
- Response: { list: [ scoredGame... ], recommendation: scoredGame }

scoredGame shape (what OpenAI should return)
- home, away, spreadTeam, spread, kickoff (copied from your input)
- score: number (0..1) — higher means better value to back against the spread
- explain: short string explaining the rationale (1-2 sentences)

Prompt contract and a minimal template
- Contract: ask the model to return ONLY valid JSON with `list` and `recommendation`. Keep temperature low (0.0–0.3) for deterministic scoring.

System message (example):
```
You are an assistant that scores and ranks college football games for value versus the spread.
Return a JSON object with two keys: "list" (array of scored games) and "recommendation" (the top scored game).
Each scored game should include original fields plus numeric "score" (0..1) and a short "explain" string.
Respond ONLY with valid JSON. Do not include any extraneous commentary.
```

User message (example): supply the enriched games JSON. Keep it small — if you have many games, send them in batches.

Tip: include `enriched` fields (injuries, implied market probabilities, simple teamRatings) — the server already attaches these when `INJURY_FEED_URL` and/or `MARKET_FEED_URL` are configured.

Practical curl example (OpenAI path):
```
curl -X POST http://localhost:3000/api/analyze \
	-H 'Content-Type: application/json' \
	-d '{"games":[{"home":"Purdue","away":"Notre Dame","spreadTeam":"Notre Dame","spread":6.5,"kickoff":"2025-09-25T20:00:00Z"}]}' \
	| jq .
```

Determinism and seeds
- The server accepts an optional `seed` you can use to drive any deterministic heuristics client- or server-side. When calling OpenAI keep temperature low if you want stable outputs.

Testing locally without calling OpenAI
- Use the local fallback (no `OPENAI_API_KEY`) — the server will run `analyzeGames` heuristic and return deterministic JSON.
- For unit tests or CI, you can inject `MOCK_OPENAI_CONTENT` (a JSON string) and set `OPENAI_API_KEY` to a dummy value; the server will use the mock string as the assistant content instead of calling the network. We include a mocked test (`tests/openai.mock.test.js`) that demonstrates this.

Debugging
- Set `DEBUG_OPENAI=1` to log the raw assistant content (truncated) to server stdout. Never set this in production alongside real keys and public logs.

Practical prompt engineering tips
- Keep requests small and structured: pass a compact JSON payload rather than large prose.
- Ask for numeric scores in a fixed range and a brief explanation; this makes parsing robust.
- Reduce hallucinations by providing enriched, factual fields (injury lists, market implied probabilities).
- Lower temperature for consistent scoring; use slightly higher temperature only when you explicitly want multiple diverse suggestions.

Error handling and fallbacks
- The server falls back to the local analyzer when OpenAI fails (non-200, parse failure, or missing content). This keeps the UI functional even if the API errors or rate-limits.

Security
- Keep `OPENAI_API_KEY` server-side only. Do not check keys into git or expose them to the browser. Use environment variables or your CI secret manager.

Next steps you can try
- Wire an injury feed or market feed to improve inputs to OpenAI.
- Add a short UI panel to show `explain` text next to each scored game (we can implement this if you want).
- Create a scheduled job that polls upcoming games, calls `/api/analyze`, and stores top weekly recommendations.

Scoring breakdown (what the UI fields mean)

Scoring breakdown (what the UI fields mean)
- spreadPresence: a small boost when a structured spread exists for the matchup (we prefer having a numeric spread to reason about).
- spreadMagScore: how close the spread magnitude is to an "ideal" target (currently centered around ~6 points). Very small spreads or very large blowout spreads score lower.
- sourceScore: a tiny weight for the source of the odds; ESPN is given a slightly higher trust score in the heuristic.
- freshness: small bonus for matchups occurring soon (so we favor current games over stale ones).

New lock-of-the-week rule
 The selection process for the "lock of the week" is now a simple deterministic filter:
	1) Find a home underdog: the favorite must be the away team (so the home team is an underdog).
	2) The spread (magnitude) must be under 10 points.
	3) Prefer the smallest spread among candidates. If multiple games tie on spread, use the deterministic weekly seed to break ties.

This replaces the previous heuristic-driven pick for the published weekly lock. The local scoring heuristic and OpenAI analysis still exist for the analysis panel and additional context, but they no longer influence the primary lock selection.

These are intentionally conservative, additive heuristics meant to prioritize reasonable, non-hallucinatory picks. The OpenAI path can override or supplement these by returning its own `score` and `explain` fields.


