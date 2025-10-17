const express = require('express');
const fetch = require('node-fetch');

const app = express();
const path = require('path');
const PORT = process.env.PORT || 3000;

// Import local analyzer from the frontend module so we can fallback when OpenAI isn't configured
let analyzeGamesLocal = null;
try {
  // js/app.js exports analyzeGames when required in Node
  const appModule = require(path.join(__dirname, '..', 'js', 'app.js'));
  analyzeGamesLocal = appModule.analyzeGames;
  // also try to import pickOne for server-side deterministic pick
  var pickOneLocal = appModule.pickOne;
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

// GET /espn/teamRecent?teamId=123
// Returns { teamId, teamName, lastResults: ['W','L',...], consecutiveWins: N }
app.get('/espn/teamRecent', async (req, res) => {
  const teamId = req.query.teamId;
  if (!teamId) return res.status(400).json({ error: 'missing teamId' });

  const key = `teamRecent:${teamId}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && (now - cached.ts) < (60 * 1000)) return res.json(cached.data);

  // ESPN team schedule endpoint (public)
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${encodeURIComponent(teamId)}/schedule`;
  try {
    const upstream = await fetch(url, { timeout: 10000 });
    if (!upstream.ok) return res.status(502).json({ error: 'upstream_non_ok', status: upstream.status });
    const data = await upstream.json();

    // Extract recent results from schedule.events (most recent first) or data.events
      let events = data?.events || data?.schedule || [];
      // Ensure we iterate most-recent-first: sort by event date descending if date present
      try {
        events = Array.from(events).sort((a,b)=>{
          const da = new Date(a?.date || a?.startDate || 0).getTime();
          const db = new Date(b?.date || b?.startDate || 0).getTime();
          return db - da;
        });
      } catch (e) { /* ignore sort errors and use original order */ }
    const lastResults = [];
    for (const ev of events) {
      try {
        const comp = ev.competitions?.[0] || ev.competitions || null;
        if (!comp) continue;
        // find competitor matching this team
        const competitor = comp.competitors?.find(c => String(c?.team?.id) === String(teamId) || String(c?.team?.teamId) === String(teamId));
        if (!competitor) continue;
        const result = (competitor?.winner) ? 'W' : ((competitor?.status?.type?.name === 'STATUS_FINAL') ? 'L' : 'T');
        lastResults.push(result);
        if (lastResults.length >= 10) break;
      } catch (e) { /* ignore per-event errors */ }
    }

    // Filter to most recent (assuming ESPN returns schedule chronological; reverse if needed)
    const mostRecent = lastResults.slice(0, 10);
    let consecutiveWins = 0;
    for (const r of mostRecent) {
      if (/^W/i.test(r)) consecutiveWins++; else break;
    }

    const out = { teamId, teamName: data?.team?.displayName || data?.team?.name || null, lastResults: mostRecent, consecutiveWins };
    cache.set(key, { ts: now, data: out });
    return res.json(out);
  } catch (err) {
    console.error('teamRecent proxy error:', err && err.stack ? err.stack : String(err));
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

// GET /api/currentPick
// Computes the deterministic weekly pick server-side so clients can fetch the authoritative pick
app.get('/api/currentPick', async (req, res) => {
  try {
    if (typeof pickOneLocal !== 'function') return res.status(501).json({ error: 'server_pick_not_available' });
    // Collect next 7 days of scoreboard events
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      const ct = new Date(d.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
      ct.setDate(ct.getDate() + i);
      const y = ct.getFullYear();
      const m = String(ct.getMonth() + 1).padStart(2, '0');
      const day = String(ct.getDate()).padStart(2, '0');
      return `${y}${m}${day}`;
    });

    const games = [];
    for (const date of dates) {
      const key = `scoreboard:${date}`;
      const now = Date.now();
      let data = null;
      const cached = cache.get(key);
      if (cached && (now - cached.ts) < TTL) data = cached.data;
      else {
        const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${encodeURIComponent(date)}`;
        try {
          const upstream = await fetch(url, { timeout: 10000 });
          if (upstream.ok) {
            data = await upstream.json();
            cache.set(key, { ts: now, data });
          }
        } catch (e) { /* ignore per-day errors */ }
      }
      if (!data) continue;
      const events = data.events || [];
      for (const ev of events) {
        try {
          const comp = ev.competitions?.[0];
          if (!comp) continue;
          const dateISO = comp.date || ev.date;
          const competitors = comp.competitors || [];
          const homeComp = competitors.find(c => c.homeAway === 'home');
          const awayComp = competitors.find(c => c.homeAway === 'away');
          const home = homeComp?.team?.displayName;
          const away = awayComp?.team?.displayName;
          const homeId = homeComp?.team?.id || homeComp?.team?.teamId;
          const awayId = awayComp?.team?.id || awayComp?.team?.teamId;
          if (!home || !away) continue;
          const odds = (comp.odds && comp.odds[0]) || null;
          // Use the same parsing function as the client by asking analyzeGamesLocal module if present
          let spreadTeam = null, spread = null;
          try {
            const parsed = require(path.join(__dirname, '..', 'js', 'app.js')).parseSpreadFromOdds(odds, home, away);
            spreadTeam = parsed.spreadTeam; spread = parsed.spread;
          } catch (e) { /* ignore parsing errors */ }
          const homeScore = homeComp?.score != null ? Number(homeComp.score) : undefined;
          const awayScore = awayComp?.score != null ? Number(awayComp.score) : undefined;
          const status = comp?.status?.type?.name || ev?.status?.type?.name;
          const gid = ev?.id || comp?.id || `${home}-${away}-${dateISO}`;

          // Fetch recent results for home team (reuse teamRecent logic locally)
          let recent = { lastResults: [], consecutiveWins: 0 };
          try {
            const teamUrl = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${encodeURIComponent(homeId)}/schedule`;
            const upstream = await fetch(teamUrl, { timeout: 10000 });
            if (upstream.ok) {
              const td = await upstream.json();
              let events2 = td?.events || td?.schedule || [];
              try { events2 = Array.from(events2).sort((a,b)=> new Date(b?.date || b?.startDate || 0) - new Date(a?.date || a?.startDate || 0)); } catch(e){}
              const lastResults = [];
              for (const ev2 of events2) {
                try {
                  const comp2 = ev2.competitions?.[0] || ev2.competitions || null; if (!comp2) continue;
                  const competitor = comp2.competitors?.find(c => String(c?.team?.id) === String(homeId) || String(c?.team?.teamId) === String(homeId));
                  if (!competitor) continue;
                  if (typeof competitor.winner !== 'undefined') lastResults.push(competitor.winner ? 'W' : 'L');
                  else if (competitor.score != null && comp2.competitors){ const other = comp2.competitors.find(c=>c !== competitor); if (other && other.score != null) lastResults.push(Number(competitor.score) > Number(other.score) ? 'W' : 'L'); }
                  if (lastResults.length >= 10) break;
                } catch (e) { /* ignore */ }
              }
              const mostRecent = lastResults.slice(0,10);
              let consecutiveWins = 0; for (const r of mostRecent){ if (/^W/i.test(r)) consecutiveWins++; else break; }
              recent = { lastResults: mostRecent, consecutiveWins };
            }
          } catch (e) { /* ignore team recent fetch errors */ }

          games.push({ id: gid, home, away, homeId, awayId, spreadTeam, spread, kickoff: dateISO, status, homeScore, awayScore, homeLastResults: recent.lastResults, homeConsecutiveWins: recent.consecutiveWins, source: { provider: odds?.provider?.name || 'ESPN' } });
        } catch (e) { /* ignore per-event */ }
      }
    }

    const pick = pickOneLocal(games);
    if (!pick) return res.status(204).end();
    return res.json(pick);
  } catch (err) {
    console.error('api/currentPick failed', err && err.stack ? err.stack : String(err));
    return res.status(500).json({ error: 'current_pick_failed', detail: String(err) });
  }
});

// Fallback: serve index.html for SPA-style routes (optional)
app.get('*', (req, res) => {
  // If the request looked like an API call, let it 404 normally
  if (req.path.startsWith('/espn/')) return res.status(404).json({ error: 'not_found' });
  return res.sendFile(path.join(root, 'index.html'));
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
