const express = require('express');
const fetch = require('node-fetch');

const app = express();
const path = require('path');
const PORT = process.env.PORT || 3000;

// Import local analyzer from the frontend module so we can fallback when OpenAI isn't configured
let analyzeGamesLocal = null;
try {
  // js/app.js exports analyzeGames when required in Node
  analyzeGamesLocal = require(path.join(__dirname, '..', 'js', 'app.js')).analyzeGames;
} catch (e) {
  console.warn('Local analyzeGames not available as module:', e && e.message ? e.message : e);
}

// Helper: safe fetch JSON with timeout
async function fetchJsonSafe(url, opts = {}){
  try {
    const r = await fetch(url, Object.assign({ timeout: 8000 }, opts));
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// Enrich games with optional injury and market feeds, and compute simple team ratings
async function enrichGames(games){
  const injuryBase = process.env.INJURY_FEED_URL || null;
  const marketBase = process.env.MARKET_FEED_URL || null;
  const out = [];
  for (const g of games){
    const ng = Object.assign({}, g);
    ng.enriched = {};

    // Attach injury data if configured (expecting JSON per team at ?team=NAME)
    if (injuryBase) {
      try {
        const homeInj = await fetchJsonSafe(`${injuryBase}?team=${encodeURIComponent(g.home)}`);
        const awayInj = await fetchJsonSafe(`${injuryBase}?team=${encodeURIComponent(g.away)}`);
        if (homeInj) ng.enriched.homeInjuries = homeInj;
        if (awayInj) ng.enriched.awayInjuries = awayInj;
      } catch (e) { /* ignore */ }
    }

    // Attach market data if configured (expecting JSON for matchup or team)
    if (marketBase) {
      try {
        // Try matchup first: ?home=...&away=...
        const m1 = await fetchJsonSafe(`${marketBase}?home=${encodeURIComponent(g.home)}&away=${encodeURIComponent(g.away)}`);
        if (m1) ng.enriched.market = m1;
        else {
          const mh = await fetchJsonSafe(`${marketBase}?team=${encodeURIComponent(g.home)}`);
          const ma = await fetchJsonSafe(`${marketBase}?team=${encodeURIComponent(g.away)}`);
          if (mh) ng.enriched.homeMarket = mh;
          if (ma) ng.enriched.awayMarket = ma;
        }
      } catch (e) { /* ignore */ }
    }

    // Simple team rating heuristic: base 1500, adjust by spread if present
    try {
      const base = 1500;
      let homeR = base, awayR = base;
      if (typeof g.spread === 'number'){
        // If spreadTeam is home, home is favored by spread points
        const s = Number(g.spread) || 0;
        if (g.spreadTeam === g.home) { homeR += Math.round(s * 10); awayR -= Math.round(s * 5); }
        else if (g.spreadTeam === g.away) { awayR += Math.round(s * 10); homeR -= Math.round(s * 5); }
      }
      // If market attached with impliedProbability, use it to tweak rating
      const mkt = ng.enriched.market || ng.enriched.homeMarket || null;
      if (mkt && typeof mkt.impliedHome === 'number' && typeof mkt.impliedAway === 'number'){
        // Scale 0..1 to rating offsets
        homeR = Math.round(1400 + mkt.impliedHome * 400);
        awayR = Math.round(1400 + mkt.impliedAway * 400);
      }
      ng.enriched.teamRatings = { home: homeR, away: awayR };
    } catch (e) { /* ignore */ }

    out.push(ng);
  }
  return out;
}

// Simple in-memory cache to reduce repeated upstream calls (TTL in ms)
const cache = new Map();
const TTL = 30 * 1000; // 30 seconds

// Basic CORS for convenience (if static assets are served from a different origin)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve static files (index.html, js/, styles/) from project root so a single server can host the app + proxy
const root = path.join(__dirname, '..');
app.use(express.static(root, { index: 'index.html' }));

app.get('/espn/scoreboard', async (req, res) => {
  const dates = req.query.dates;
  if (!dates) return res.status(400).json({ error: 'missing dates query param' });

  const key = String(dates);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && (now - cached.ts) < TTL) {
    return res.json(cached.data);
  }

  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${encodeURIComponent(dates)}`;
  try {
    const upstream = await fetch(url, { timeout: 10000 });
    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('Upstream non-OK', upstream.status, text.slice(0, 300));
      return res.status(502).json({ error: 'upstream_non_ok', status: upstream.status });
    }
    const data = await upstream.json();
    cache.set(key, { ts: now, data });
    return res.json(data);
  } catch (err) {
    console.error('Proxy error fetching ESPN:', err && err.stack ? err.stack : String(err));
    return res.status(502).json({ error: 'upstream_error', detail: String(err) });
  }
});

// POST /api/analyze
// Body: { games: [ ... ], seed?: number }
// If OPENAI_API_KEY is set, call the OpenAI Chat Completions API to request a JSON scoring response.
// Otherwise fall back to the local heuristic (analyzeGamesLocal) if available.
app.post('/api/analyze', express.json(), async (req, res) => {
  const games = req.body?.games;
  const seed = req.body?.seed || null;
  if (!Array.isArray(games)) return res.status(400).json({ error: 'missing games array in request body' });

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    if (typeof analyzeGamesLocal === 'function') {
      try {
        const out = analyzeGamesLocal(games, { seed });
        return res.json(out);
      } catch (e) {
        console.error('Local analyzeGames failed:', e && e.stack ? e.stack : String(e));
        return res.status(500).json({ error: 'local_analyze_failed', detail: String(e) });
      }
    }
    return res.status(501).json({ error: 'no_openai_key_and_no_local_analyzer' });
  }

  // Build a concise prompt asking for JSON output. Keep requests small.
  const systemPrompt = `You are an assistant that scores and ranks college football games for value versus the spread.
Return a JSON object with two keys: "list" (array of scored games) and "recommendation" (the top scored game).
Each scored game should include the original fields (home, away, spreadTeam, spread, kickoff) plus numeric "score" (0..1) and a short "explain" string.
Respond ONLY with valid JSON. Do not include any extraneous commentary.`;

  const userPayload = {
    games: games.map(g => ({ home: g.home, away: g.away, spreadTeam: g.spreadTeam, spread: g.spread, kickoff: g.kickoff }))
  };

  try {
    // Enrich games (injuries, market, ratings) before asking OpenAI
    const enriched = await enrichGames(games);
    const enrichedPayload = { games: enriched.map(g => ({ home: g.home, away: g.away, spreadTeam: g.spreadTeam, spread: g.spread, kickoff: g.kickoff, enriched: g.enriched })) };

    // For tests, allow injecting mock assistant content via MOCK_OPENAI_CONTENT env var
    let data = null;
    let content = null;
    if (process.env.MOCK_OPENAI_CONTENT) {
      // The test provides the assistant "content" string directly
      data = { choices: [ { message: { content: process.env.MOCK_OPENAI_CONTENT } } ] };
      content = process.env.MOCK_OPENAI_CONTENT;
    } else {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(enrichedPayload) }
          ],
          temperature: 0.2,
          max_tokens: 800,
          n: 1
        })
      });

      if (!resp.ok) {
        const txt = await resp.text();
        console.error('OpenAI non-OK', resp.status, txt.slice(0, 300));
        // Fallback to local analyzer if available
        if (typeof analyzeGamesLocal === 'function') return res.json(analyzeGamesLocal(games, { seed }));
        return res.status(502).json({ error: 'openai_error', status: resp.status, detail: txt });
      }

      data = await resp.json();
      content = data?.choices?.[0]?.message?.content;
    }
    // Dev-only: optionally print the raw assistant content for debugging
    if (process.env.DEBUG_OPENAI === '1') {
      try {
        const preview = typeof content === 'string' ? content.slice(0, 20000) : String(content);
        console.log('\n===== RAW OPENAI ASSISTANT CONTENT (truncated) =====\n', preview, '\n===== END RAW CONTENT =====\n');
      } catch (e) { console.warn('Failed to log raw OpenAI content', e); }
    }
    if (!content) {
      console.warn('OpenAI response missing content, falling back');
      if (typeof analyzeGamesLocal === 'function') return res.json(analyzeGamesLocal(games, { seed }));
      return res.status(502).json({ error: 'openai_no_content', raw: data });
    }

    // Try to parse JSON from the assistant content. Many times the model will return clean JSON.
    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      // Heuristic: try to extract a JSON substring
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; }
      }
    }

    if (parsed && parsed.list && parsed.recommendation) {
      return res.json(parsed);
    }

    // If parsing failed, fallback to local analyzer if available
    if (typeof analyzeGamesLocal === 'function') return res.json(analyzeGamesLocal(games, { seed }));

    return res.status(502).json({ error: 'openai_parse_failed', raw: content });
  } catch (err) {
    console.error('OpenAI call failed:', err && err.stack ? err.stack : String(err));
    if (typeof analyzeGamesLocal === 'function') return res.json(analyzeGamesLocal(games, { seed }));
    return res.status(502).json({ error: 'openai_call_failed', detail: String(err) });
  }
});

// Fallback: serve index.html for SPA-style routes (optional)
app.get('*', (req, res) => {
  // If the request looked like an API call, let it 404 normally
  if (req.path.startsWith('/espn/')) return res.status(404).json({ error: 'not_found' });
  return res.sendFile(path.join(root, 'index.html'));
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
