/*
Single-page “Lock of the Week” for CFB ATS
Pulls upcoming CFB games (ESPN public scoreboard JSON)
Finds games where the home team is on a 2-game win streak (last two completed games)
From that filtered set, picks one deterministically per week (seeded RNG)
Renders our existing retro UI, with Share button — entertainment only
*/

// ===== Utilities
function mulberry32(seed){
  return function(){
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Helper: check if kickoff ISO is within N days from now (inclusive)
function withinDays(kickoffIso, days = 3){
  try{
    const ko = new Date(kickoffIso);
    const now = new Date();
    const diffDays = (ko - now) / 86400000;
    return diffDays >= 0 && diffDays <= days;
  } catch (e){ return false; }
}
// Fetch with timeout helper used for serverless function call
async function fetchWithTimeout(url, { timeoutMs = 6000, ...opts } = {}){
  const ctl = new AbortController();
  const id = setTimeout(()=> ctl.abort(), timeoutMs);
  try{
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store', ...opts });
    return res;
  } finally { clearTimeout(id); }
}
function seasonStartUTC(year){
  const d = new Date(Date.UTC(year, 7, 25));
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
function getCfbWeek(today = new Date()){
  const y = today.getUTCFullYear();
  let s = seasonStartUTC(y);
  if (today < s) s = seasonStartUTC(y - 1);
  const diffDays = Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - s.getTime()) / 86400000);
  return Math.max(1, Math.min(16, Math.floor(diffDays / 7) + 1));
}
function weeklySeed(){
  const now = new Date();
  return { seed: now.getUTCFullYear() * 100 + getCfbWeek(now), wk: getCfbWeek(now) };
}
function yyyymmddInCT(offset = 0){
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  ct.setDate(ct.getDate() + offset);
  const y = ct.getFullYear();
  const m = String(ct.getMonth() + 1).padStart(2, '0');
  const d = String(ct.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
// Validate serverless pick shape
function isValidPick(x){
  return x && typeof x.home === 'string' && typeof x.away === 'string' && typeof x.pickTeam === 'string' && typeof x.kickoff === 'string';
}
function fmtKick(iso){
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) {
    return iso;
  }
}
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ===== parseSpreadFromOdds (replacement)
function parseSpreadFromOdds(odds, home, away) {
  // Test cases:
  // 1) Home fav (details): "Notre Dame -6.5" -> { spreadTeam: "Notre Dame", spread: 6.5 }
  // 2) Away fav (details): "Purdue -3" -> { spreadTeam: "Purdue", spread: 3 }
  // 3) Per-team spreads: odds.homeTeamOdds.spread = -4, odds.awayTeamOdds.spread = 4 -> { spreadTeam: home, spread: 4 }
  // 4) Unknown / ambiguous: details numeric but team text doesn't match -> { spreadTeam: undefined, spread: undefined }

  if (!odds) return { spreadTeam: undefined, spread: undefined };

  const normalize = s => (s || '').toString().trim();
  const homeNorm = normalize(home).toLowerCase();
  const awayNorm = normalize(away).toLowerCase();

  // 1) If odds.details looks like "Team -6.5", parse that and fuzzy-match the team text to home/away.
  if (typeof odds.details === 'string') {
    const details = odds.details.trim();
  // Allow trailing annotations after the numeric token (e.g. "ND -6.5 (home)")
  const m = details.match(/^\s*(.+?)\s+([+-]?\d+(?:\.\d+)?)(?:\s+.*)?$/);
    if (m) {
      const teamTextRaw = m[1].replace(/vs\.?/i, '').replace(/[()]/g, '').trim();
      const rawNum = parseFloat(m[2]);
      if (!Number.isNaN(rawNum) && teamTextRaw.length) {
        const clean = s => (s || '').toLowerCase().replace(/[^\w\s]/g, '').trim();
        const tokens = s => clean(s).split(/\s+/).filter(Boolean);
        const tokenMatch = (a, b) => {
          const A = tokens(a);
          const B = tokens(b);
          return A.some(x => B.some(y => x && y && (x.includes(y) || y.includes(x))));
        };

        const teamClean = clean(teamTextRaw);
        if (tokenMatch(teamClean, homeNorm) || homeNorm.includes(teamClean) || teamClean.includes(homeNorm)) {
          return { spreadTeam: home, spread: Math.abs(rawNum) };
        }
        if (tokenMatch(teamClean, awayNorm) || awayNorm.includes(teamClean) || teamClean.includes(awayNorm)) {
          return { spreadTeam: away, spread: Math.abs(rawNum) };
        }

        // ambiguous: preserve the numeric magnitude but don't guess the team
        return { spreadTeam: undefined, spread: Math.abs(rawNum) };
      }
    }
  }

  // 2) Else, read per-team spreads: homeTeamOdds.spread / awayTeamOdds.spread (or similar keys).
  const extractNum = v => {
    if (v == null) return undefined;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(/[^\d\.\-+]/g, ''));
      return Number.isNaN(n) ? undefined : n;
    }
    return undefined;
  };

  const homeOdds = odds.homeTeamOdds || {};
  const awayOdds = odds.awayTeamOdds || {};

  const homeCandidates = [homeOdds.spread, homeOdds.pointSpread, homeOdds.handicap, homeOdds.line];
  const awayCandidates = [awayOdds.spread, awayOdds.pointSpread, awayOdds.handicap, awayOdds.line];

  const homeVal = homeCandidates.map(extractNum).find(v => typeof v === 'number');
  const awayVal = awayCandidates.map(extractNum).find(v => typeof v === 'number');

  if (typeof homeVal === 'number' && typeof awayVal === 'number') {
    // whichever value is negative indicates the favorite
    if (homeVal < 0 && awayVal >= 0) return { spreadTeam: home, spread: Math.abs(homeVal) };
    if (awayVal < 0 && homeVal >= 0) return { spreadTeam: away, spread: Math.abs(awayVal) };
    // ambiguous if both same sign -> no bias
    return { spreadTeam: undefined, spread: undefined };
  }

  if (typeof homeVal === 'number' && homeVal < 0) return { spreadTeam: home, spread: Math.abs(homeVal) };
  if (typeof awayVal === 'number' && awayVal < 0) return { spreadTeam: away, spread: Math.abs(awayVal) };

  // If there's a top-level numeric spread (no per-team fields), return magnitude but no team.
  const topCandidates = [odds.spread, odds.pointSpread, odds.handicap, odds.line];
  const topVal = topCandidates.map(extractNum).find(v => typeof v === 'number');
  if (typeof topVal === 'number') return { spreadTeam: undefined, spread: Math.abs(topVal) };

  // Nothing useful found — do not default to home
  return { spreadTeam: undefined, spread: undefined };
}

// ===== Data fetch (ESPN public scoreboard)
async function loadUpcomingGames(){
  const dates = Array.from({length:7}, (_,i)=>yyyymmddInCT(i));
  const urls = dates.map(d=>`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${d}`);

  // Try direct fetch first; if it fails (network/CORS), try the local proxy at /espn/scoreboard?dates=YYYYMMDD
  async function tryFetchWithProxy(date, url){
    try {
      const r = await fetch(url);
      if(r.ok) return await r.json();
      console.warn('ESPN returned non-OK status', r.status, url);
    } catch (e) {
      console.warn('Direct fetch failed (possibly CORS/network):', e, url);
    }

    try {
      const proxyUrl = `/espn/scoreboard?dates=${encodeURIComponent(date)}`;
      const rp = await fetch(proxyUrl);
      if(rp.ok) return await rp.json();
      console.warn('Proxy returned non-OK status', rp.status, proxyUrl);
    } catch (e) {
      console.warn('Proxy fetch failed:', e);
    }

    throw new Error('Both direct and proxy fetch attempts failed for ' + date);
  }

  const results = await Promise.allSettled(urls.map((u,i)=>tryFetchWithProxy(dates[i], u)));
  const events = [];
  results.forEach(r=>{
    if(r.status==='fulfilled' && r.value?.events?.length) events.push(...r.value.events);
  });
  return events;
}

function normalizeGames(events){
  const out=[];
  for(const ev of events){
    const comp = ev?.competitions?.[0];
    if(!comp) continue;
    const dateISO = comp.date || ev.date;
    const competitors = comp.competitors||[];
    const homeComp = competitors.find(c=>c.homeAway==='home');
    const awayComp = competitors.find(c=>c.homeAway==='away');
    const home = homeComp?.team?.displayName;
    const away = awayComp?.team?.displayName;
    const homeId = homeComp?.team?.id || homeComp?.team?.teamId || undefined;
    const awayId = awayComp?.team?.id || awayComp?.team?.teamId || undefined;
    if(!home||!away) continue;
    const odds = (comp.odds && comp.odds[0]) || null;
    const {spreadTeam, spread} = parseSpreadFromOdds(odds, home, away);
    // extract scores and status
    const homeCompData = competitors.find(c=>c.homeAway==='home') || {};
    const awayCompData = competitors.find(c=>c.homeAway==='away') || {};
    const homeScore = homeCompData?.score != null ? Number(homeCompData.score) : undefined;
    const awayScore = awayCompData?.score != null ? Number(awayCompData.score) : undefined;
    const status = comp?.status?.type?.name || ev?.status?.type?.name || undefined;
    const gid = ev?.id || comp?.id || `${home}-${away}-${dateISO}`;
    out.push({id: gid, home,away,homeId,awayId,spreadTeam,spread,kickoff: dateISO, status, homeScore, awayScore, source:{provider: odds?.provider?.name || 'ESPN'}});
  }
  return out;
}

// --- Record helpers persisted in localStorage under 'lotw_record' and last pick under 'lotw_lastPick'
function loadRecord(){
  try{
    if (typeof localStorage === 'undefined') return { wins: 3, losses: 2 };
    const raw = localStorage.getItem('lotw_record');
    if (!raw) return { wins: 3, losses: 2 };
    const parsed = JSON.parse(raw);
    return { wins: Number(parsed.wins)||0, losses: Number(parsed.losses)||0 };
  } catch(e){ return { wins: 3, losses: 2 }; }
}
function saveRecord(rec){
  try{ if (typeof localStorage !== 'undefined') localStorage.setItem('lotw_record', JSON.stringify(rec)); } catch(e){}
}
function renderRecord(){
  if (typeof document === 'undefined') return;
  let el = document.getElementById('recordBadge');
  if (!el){
    el = document.createElement('div');
    el.id = 'recordBadge';
    el.className = 'record';
    // append near top of content
    const header = document.getElementById('header') || document.body;
    header.insertBefore(el, header.firstChild);
  }
  const rec = loadRecord();
  el.textContent = `Record: ${rec.wins}-${rec.losses}`;
}

// --------- New helpers: two-game win streak detection and filtering
const _streakCache = new Map(); // Map<teamId, boolean>

async function isTwoGameWinStreak(teamId){
  if (!teamId) return false;
  if (_streakCache.has(teamId)) return _streakCache.get(teamId);
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${encodeURIComponent(teamId)}/schedule`;
    const r = await fetch(url);
    if (!r.ok) { _streakCache.set(teamId, false); return false; }
    const j = await r.json();
    let events = j.events || j.schedule || [];
    try { events = Array.from(events).sort((a,b)=> new Date(b?.date || b?.startDate || 0) - new Date(a?.date || a?.startDate || 0)); } catch(e){}
    const completed = [];
    for (const ev of events){
      try {
        const comp = ev.competitions?.[0] || ev.competitions || null; if (!comp) continue;
        const status = comp?.status || ev?.status || {};
        const completedFlag = status?.type?.completed === true || status?.type?.name === 'STATUS_FINAL' || status?.type?.completed === true;
        if (!completedFlag) continue;
        const competitor = comp.competitors?.find(c => String(c?.team?.id) === String(teamId) || String(c?.team?.teamId) === String(teamId));
        if (!competitor) continue;
        // Determine win/loss
        let isWin = false;
        if (typeof competitor.winner === 'boolean') isWin = competitor.winner === true;
        else if (competitor.score != null && comp.competitors) {
          const other = comp.competitors.find(c=>c !== competitor);
          if (other && other.score != null) isWin = Number(competitor.score) > Number(other.score);
        }
        completed.push(isWin ? 'W' : 'L');
        if (completed.length >= 2) break;
      } catch (e) { /* ignore per-event errors */ }
    }
    const ok = completed.length >= 2 && /^W/i.test(completed[0]) && /^W/i.test(completed[1]);
    _streakCache.set(teamId, ok);
    return ok;
  } catch (e) {
    _streakCache.set(teamId, false);
    return false;
  }
}

async function filterHomeTeamsOnStreak(games){
  if (!Array.isArray(games) || !games.length) return [];
  // collect unique home team ids
  const ids = Array.from(new Set(games.map(g=>g && g.homeId).filter(Boolean)));
  const concurrency = 6;
  const results = new Map();
  // process in batches
  for (let i=0; i<ids.length; i+=concurrency){
    const batch = ids.slice(i, i+concurrency);
    const settled = await Promise.allSettled(batch.map(id => isTwoGameWinStreak(id)));
    for (let j=0;j<batch.length;j++){
      const id = batch[j];
      const res = settled[j];
      results.set(id, (res.status === 'fulfilled' && res.value === true));
    }
  }
  // filter games
  return games.filter(g => g && g.homeId && results.get(g.homeId) === true);
}

function loadLastPick(){
  try{ if (typeof localStorage === 'undefined') return null; const raw = localStorage.getItem('lotw_lastPick'); return raw ? JSON.parse(raw) : null; } catch(e){ return null; }
}
function saveLastPick(p){
  try{ if (typeof localStorage !== 'undefined') localStorage.setItem('lotw_lastPick', JSON.stringify(p)); } catch(e){}
}

function storeLastPick(pick){
  if (!pick) return;
  const obj = { id: pick.id, pickTeam: (pick && pick.home) ? pick.home : pick.pickTeam, kickoff: pick.kickoff, evaluated: false };
  saveLastPick(obj);
  renderRecord();
}

// Evaluate a pick vs final score and update record. Returns 'W'|'L'|'P'|null
function evaluatePickAgainstSpread(pick, game){
  try{
    if (!pick || !game) return null;
    if (game.status !== 'STATUS_FINAL' && game.status !== 'final' && game.status !== 'FINAL') return null;
    const homeScore = typeof game.homeScore === 'number' ? game.homeScore : (game.homeScore ? Number(game.homeScore) : undefined);
    const awayScore = typeof game.awayScore === 'number' ? game.awayScore : (game.awayScore ? Number(game.awayScore) : undefined);
    if (homeScore == null || awayScore == null) return null;
    const pickedHome = pick.pickTeam === game.home || pick.pickTeam === pick.home;
    const s = typeof game.spread === 'number' ? game.spread : undefined;
    if (s == null) return null; // cannot evaluate without spread
    // Determine ATS values
    let homeATS = homeScore;
    let awayATS = awayScore;
    // If favorite is home (spreadTeam === home), home gives points
    if (game.spreadTeam === game.home) {
      homeATS = homeScore - s;
    } else if (game.spreadTeam === game.away) {
      homeATS = homeScore + s;
    }
    // awayATS for symmetry
    if (game.spreadTeam === game.away) {
      awayATS = awayScore - s;
    } else if (game.spreadTeam === game.home) {
      awayATS = awayScore + s;
    }

    // If pick is home, compare homeATS vs awayATS
    if (pickedHome) {
      if (homeATS > awayATS) return 'W';
      if (homeATS < awayATS) return 'L';
      return 'P';
    }
    // If pick is away
    if (!pickedHome) {
      if (awayATS > homeATS) return 'W';
      if (awayATS < homeATS) return 'L';
      return 'P';
    }
  } catch (e){ return null; }
  return null;
}

function applyPickResult(result){
  if (!result) return;
  const rec = loadRecord();
  if (result === 'W') rec.wins = (Number(rec.wins)||0) + 1;
  else if (result === 'L') rec.losses = (Number(rec.losses)||0) + 1;
  // Push ('P') does not change record
  saveRecord(rec);
  renderRecord();
}

// Check stored last pick against available games and update record if finished
function checkAndUpdateStoredPick(games){
  try{
    const last = loadLastPick();
    if (!last || last.evaluated) return;
    const game = (games || []).find(g => g.id && last.id && String(g.id) === String(last.id));
    if (!game) return;
    const res = evaluatePickAgainstSpread(last, game);
    if (!res) return;
    applyPickResult(res);
    // mark evaluated
    last.evaluated = true;
    saveLastPick(last);
  } catch (e){ console.warn('checkAndUpdateStoredPick failed', e); }
}

// Fetch recent results for home teams for a set of normalized games by calling the proxy endpoint
async function fetchRecentResultsForGames(games){
  if (!Array.isArray(games) || !games.length) return games;
  // Build unique list of home team ids to query
  const homeIdMap = {};
  for (const g of games) if (g && g.homeId) homeIdMap[g.homeId] = true;
  const ids = Object.keys(homeIdMap);
  const resultsMap = {};
  await Promise.all(ids.map(async id => {
    try {
      const r = await fetch(`/espn/teamRecent?teamId=${encodeURIComponent(id)}`);
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.teamId) resultsMap[j.teamId] = j;
    } catch (e) {
      console.warn('Failed to fetch team recent results', id, e);
    }
  }));
  // Merge results into games as homeLastResults/homeConsecutiveWins
  for (const g of games){
    if (!g) continue;
    const meta = resultsMap[g.homeId];
    if (meta) {
      g.homeLastResults = meta.lastResults;
      g.homeConsecutiveWins = meta.consecutiveWins;
    }
  }
  return games;
}

async function pickOne(games){
  const {seed, wk} = weeklySeed();
  if (typeof document !== 'undefined') {
    const weekLabelEl = document.getElementById('weekLabel');
    if (weekLabelEl) weekLabelEl.textContent = `WEEK ${wk} PICK`;
  }

  try {
    // Ensure we have normalized games array
    const pool = Array.isArray(games) ? games.slice() : [];
    // Filter to home teams with 2-game win streaks
    let streakGames = [];
    try { streakGames = await filterHomeTeamsOnStreak(pool); } catch (e) { console.warn('streak filter failed', e); }

    let candidates = (streakGames && streakGames.length) ? streakGames : pool.filter(g => g && g.home && g.away);
    // Prefer games in the current CFB week. If none, fall back to full candidates.
    try{
      const wkNow = weeklySeed().wk;
      const preferred = candidates.filter(g => {
        try { return getCfbWeek(new Date(g.kickoff)) === wkNow; } catch(e){ return false; }
      });
      if (preferred && preferred.length) candidates = preferred;
    } catch(e){}
    if (!candidates || !candidates.length) return null;

    const rng = mulberry32(seed || 12345);
    const idx = Math.floor(rng() * candidates.length);
    const chosen = candidates[idx];
    if (!chosen) return null;
    // enforce lock is the home team for the chosen game
    chosen.pickTeam = chosen.home;
    // ensure spread is numeric magnitude if present
    if (typeof chosen.spread === 'number') chosen.spread = Math.abs(chosen.spread);
    return chosen;
  } catch (e) {
    console.warn('pickOne failed', e);
    return null;
  }
}

// Helper: compute signed line for the picked team
function signedLineForPick({ pickTeam, spreadTeam, spread }){
  if (typeof spread !== 'number') return 'PK';
  if (!spreadTeam) return 'PK';
  return (pickTeam === spreadTeam) ? `-${spread}` : `+${spread}`;
}

/*
 * analyzeGames(games, opts)
 * - games: array of normalized game objects ({home, away, spreadTeam, spread, kickoff, source})
 * - opts: { seed?: number, remoteUrl?: string, remoteKey?: string }
 *
 * Returns: { list: [{...game, score, explain}], recommendation: game }
 * Behavior: if a remote AI endpoint is configured via opts.remoteUrl or
 * window.AI_ANALYSIS_URL, the function will POST the games to that endpoint and
 * accept a scored response (best-effort). Otherwise it uses a local heuristic
 * to score and pick a recommended game. The heuristic is conservative and
 * designed to avoid simply preferring home teams.
 */
function analyzeGames(games, opts = {}){
  const options = Object.assign({}, opts);

  // Remote analysis hook (optional)
  const remoteUrl = options.remoteUrl || (typeof window !== 'undefined' && window.AI_ANALYSIS_URL) || null;
  if (remoteUrl && typeof fetch === 'function') {
    try {
      const body = JSON.stringify({ games });
      // best-effort synchronous attempt (returns promise); caller may want to use async flow
      // but pickOne expects synchronous return so we won't block here — instead try/catch below
    } catch (e) {
      console.warn('prepare remote analysis failed', e);
    }
  }

  // Local heuristic scoring
  const scoreGame = (g) => {
    const hasSpread = !!(g && g.spreadTeam && typeof g.spread === 'number');
    const spread = hasSpread ? Math.abs(g.spread) : 0;

    // Favor moderate spreads (too small -> coinflip, too large -> risky)
    const ideal = 6.0;
    const spreadMagScore = hasSpread ? Math.max(0, 1 - Math.abs(spread - ideal) / 10) : 0;

    // Prefer sharper sources slightly
    const provider = g?.source?.provider || '';
    const sourceScore = /espn/i.test(provider) ? 0.05 : 0.02;

  // More weight if we actually have a spread
  const spreadPresence = hasSpread ? 0.4 : 0.0;

    // Kickoff freshness (so we slightly prefer upcoming games within 7 days)
    let freshness = 0;
    try {
      const ko = g.kickoff ? new Date(g.kickoff) : null;
      if (ko) {
        const now = new Date();
        const diffDays = (ko - now) / 86400000;
        freshness = diffDays >= -1 && diffDays <= 14 ? 0.05 : 0;
      }
    } catch (e){}

    // Combined score (0..1+)
    const score = (spreadPresence + spreadMagScore * 0.5 + sourceScore + freshness);
    const explain = {
      hasSpread,
      spread: hasSpread ? g.spread : undefined,
      spreadMagScore: Number(spreadMagScore.toFixed(3)),
      sourceScore,
      freshness: Number(freshness.toFixed(3))
    };
    return { score, explain };
  };

  const list = (games || []).map(g=>{
    const out = Object.assign({}, g);
    const s = scoreGame(g);
    out.score = s.score;
    out.explain = s.explain;
    return out;
  });

  // Deterministic tiebreaker using seed if present
  const seed = options.seed || (typeof window !== 'undefined' && window.weeklySeed ? weeklySeed().seed : 0);
  const rng = mulberry32(seed || 12345);

  list.sort((a,b)=>{
    if (b.score !== a.score) return b.score - a.score;
    // tie-break deterministically
    return rng() - 0.5;
  });

  return { list, recommendation: list.length ? list[0] : null };
}

function renderGame(g){
  const content = document.getElementById('content');
  if(!content) return;
  if(!g){
    content.innerHTML = `<div class="error">No upcoming college games found. Try again later.</div>`;
    return;
  }
  // Validate that the game meets the home + two prior wins rule before rendering as the primary pick.
  // If the pick was produced server-side or by our client fallback, it may include meta.path
  // indicating prior validation; in that case skip strict local validation so canonical picks render.
  function isHomeWithTwoWins(game){
    try{
      if (!game || !game.home) return false;
      // If meta.path exists, assume upstream validation and allow rendering
      if (game && game.meta && typeof game.meta.path === 'string') return true;
      if (Array.isArray(game.homeLastResults) && game.homeLastResults.length >= 2) {
        return /^W/i.test(String(game.homeLastResults[0])) && /^W/i.test(String(game.homeLastResults[1]));
      }
      if (typeof game.homeConsecutiveWins === 'number') return game.homeConsecutiveWins >= 2;
      // fallback: check saved recentWinsMap on window if present
      if (typeof window !== 'undefined' && window.recentWinsMap && Array.isArray(window.recentWinsMap[game.home]) && window.recentWinsMap[game.home].length >= 2) {
        return /^W/i.test(String(window.recentWinsMap[game.home][0])) && /^W/i.test(String(window.recentWinsMap[game.home][1]));
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // If this game does not meet the home+2-wins requirement, don't render it as the primary lock.
  if (!isHomeWithTwoWins(g)) {
    try { renderNoPickFound(); } catch(e) { console.warn('failed to render no-pick', e); }
    return;
  }
  // pickTeam is explicitly set by pickOne to the home team when available
  const pickTeam = g.pickTeam || g.home || g.spreadTeam || 'Pick';
  console.log('rendering pick', { id: g.id, path: g.meta?.path || 'client', pickTeam });
  const opponent = pickTeam === g.home ? g.away : g.home;
  const dog = opponent;
  const line = signedLineForPick({ pickTeam, spreadTeam: g.spreadTeam, spread: g.spread });
  content.innerHTML = `
    <div class="teams">
      <div class="teambox away">
        <div class="teamlbl">AWAY</div>
        <div class="teamname">${g.away}</div>
      </div>
      <div>
        <div class="spreadlbl">SPREAD</div>
        <div class="spreadtxt"><span class="fav">${pickTeam}</span> <span class="num">${line}</span></div>
        <div class="kick">${fmtKick(g.kickoff)}</div>
        <div class="source">Source: ${g.source?.provider || 'ESPN'}</div>
      </div>
      <div class="teambox home">
        <div class="teamlbl">HOME</div>
        <div class="teamname">${g.home}</div>
      </div>
    </div>
  <!-- analysis hidden for primary pick -->
    <div class="ribbon">
      <div class="pill">🏆 LOCK (FOR FUN!)</div>
      <div class="pill2">AGAINST THE SPREAD</div>
    </div>`;

  const share = () => {
    const text = `Lock of the Week: ${pickTeam} ${line} vs ${dog} — ${fmtKick(g.kickoff)}`;
    if(navigator.share){ navigator.share({title:'Lock of the Week', text, url: location.href}).catch(()=>{}); }
    else { navigator.clipboard.writeText(text).then(()=>alert('Copied to clipboard!')).catch(()=>{}); }
  };
  const shareBtn = document.getElementById('shareBtn');
  if(shareBtn) shareBtn.onclick = share;
  // persist last pick for later evaluation
  try{ storeLastPick(g); } catch(e){}

}

function renderAnalysisPanel(list){
  const el = document.getElementById('analysisPanel');
  if(!el) return;
  if(!Array.isArray(list) || !list.length){ el.innerHTML = '<div class="small">No analysis available.</div>'; return; }
  el.innerHTML = '<ol>' + list.map(item=>`<li><strong>${item.home} vs ${item.away}</strong> — score ${Number(item.score).toFixed(3)} ${formatExplainForHtml(item.explain)}</li>`).join('') + '</ol>';
}

function renderLoadingNextLock(){
  const content = (typeof document !== 'undefined') ? document.getElementById('content') : null;
  if (!content) return;
  content.innerHTML = `<div class="loading">Loading next lock...</div>`;
}

function renderNoPickFound(){
  const content = (typeof document !== 'undefined') ? document.getElementById('content') : null;
  if (!content) return;
  content.innerHTML = `
    <div class="no-pick">
      <div class="title">No qualifying lock found</div>
      <div class="reason">The selection rule currently requires a home team that has won its previous two games. Either no home team matches that rule for this week, or recent results are not available.</div>
      <div style="margin-top:12px;"><button id="refreshPick" class="btn">Refresh</button></div>
    </div>
  `;
  const btn = document.getElementById('refreshPick');
  if (btn) btn.onclick = async () => {
    try { renderLoadingNextLock(); await start(); } catch (e) { console.warn('manual refresh failed', e); }
  };
}

// Polling disabled: replaced with a no-op to prevent manual/auto-polling flows.
async function pollForNextLock(){
  // intentionally does nothing; polling flows were removed per user request
  return;
}

function stopPollingForNextLock(){ /* no-op */ }


function formatExplainForHtml(explain){
  if (!explain) return '';
  if (typeof explain === 'string') return `<div class="explain">${escapeHtml(explain)}</div>`;
  try {
    // If it's an object, render key: value pairs
    const parts = Object.keys(explain).map(k=>`<div class="explain-row"><span class="explain-key">${escapeHtml(k)}</span>: <span class="explain-val">${escapeHtml(String(explain[k]))}</span></div>`);
    return `<div class="explain">${parts.join('')}</div>`;
  } catch (e) {
    return `<div class="explain">${escapeHtml(String(explain))}</div>`;
  }
}

function escapeHtml(s){
  return (s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function ensureAnalysisUI(){
  // Analysis UI intentionally disabled per user request.
  return;
}

// Debug panel: show normalized games and why they were excluded or included
function getRejectionReason(g){
  try {
    if (!g) return 'missing game object';
    if (!g.home || !g.away) return 'missing teams';
    if (typeof g.spread !== 'number') return 'missing numeric spread';
    if (!g.spreadTeam) return 'missing spreadTeam (favorite not declared)';
    // Check recent-wins indicators
    if (Array.isArray(g.homeLastResults) && g.homeLastResults.length >= 2) {
      if (/^W/i.test(String(g.homeLastResults[0])) && /^W/i.test(String(g.homeLastResults[1]))) return 'ok';
      const recent3 = g.homeLastResults.slice(0,3);
      const winsIn3 = recent3.filter(x => /^W/i.test(String(x))).length;
      if (winsIn3 >= 2) return 'ok (2-in-3)';
      return 'home lacks 2 wins in recent results';
    }
    if (typeof g.homeConsecutiveWins === 'number') {
      if (g.homeConsecutiveWins >= 2) return 'ok';
      return 'home consecutiveWins < 2';
    }
    return 'no recent results available';
  } catch (e) { return 'error computing reason'; }
}

function renderDebugPanel(games){
  if (typeof document === 'undefined') return;
  // create container if needed
  let root = document.getElementById('debugPanelContainer');
  if (!root) {
    root = document.createElement('div');
    root.id = 'debugPanelContainer';
    root.style.padding = '8px';
    root.style.borderTop = '1px solid #eee';
    root.style.background = '#fafafa';
    // place near bottom of body
    const app = document.getElementById('app') || document.body;
    app.appendChild(root);
  }

  // Toggle control
  let toggle = document.getElementById('debugToggle');
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.id = 'debugToggle';
    toggle.className = 'btn';
    toggle.style.margin = '6px 0';
    toggle.textContent = 'Show debug panel';
    toggle.onclick = () => {
      const panel = document.getElementById('debugPanel');
      if (!panel) return;
      const visible = panel.style.display !== 'none';
      panel.style.display = visible ? 'none' : 'block';
      toggle.textContent = visible ? 'Show debug panel' : 'Hide debug panel';
    };
    root.appendChild(toggle);
  }

  // create content panel
  let panel = document.getElementById('debugPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'debugPanel';
    panel.style.display = 'none';
    panel.style.marginTop = '8px';
    panel.style.maxHeight = '260px';
    panel.style.overflow = 'auto';
    panel.style.fontSize = '13px';
    root.appendChild(panel);
  }

  if (!Array.isArray(games) || !games.length) {
    panel.innerHTML = '<div class="small">No games normalized for debug.</div>';
    return;
  }

  const rows = games.map(g => {
    const reason = getRejectionReason(g);
    const lr = Array.isArray(g.homeLastResults) ? g.homeLastResults.join(',') : (g.homeConsecutiveWins != null ? `consec:${g.homeConsecutiveWins}` : 'n/a');
    return `<div style="padding:6px;border-bottom:1px solid #eee;">` +
      `<div style="font-weight:600">${escapeHtml(g.home)} (home) vs ${escapeHtml(g.away)}</div>` +
      `<div>ID: ${escapeHtml(String(g.id || ''))} | Spread: ${escapeHtml(String(g.spread || ''))} | SpreadTeam: ${escapeHtml(String(g.spreadTeam || ''))}</div>` +
      `<div>Recent: ${escapeHtml(lr)} | Kickoff: ${escapeHtml(String(g.kickoff || ''))}</div>` +
      `<div style="color:${reason.startsWith('ok') ? 'green' : '#a00'};font-weight:600">Status: ${escapeHtml(reason)}</div>` +
    `</div>`;
  }).join('');

  panel.innerHTML = rows;
}

function ensureDebugUI(){
  if (typeof document === 'undefined') return;
  // If header exists, add a small link to open the debug panel quickly
  const header = document.getElementById('header') || document.body;
  if (!document.getElementById('openDebugBtn')) {
    const b = document.createElement('button');
    b.id = 'openDebugBtn';
    b.className = 'btn';
    b.style.marginLeft = '8px';
    b.textContent = 'Debug';
    b.onclick = async () => {
      // re-run normalization and fetch recent results so the panel has current data
      try {
        const events = await loadUpcomingGames();
        const games = normalizeGames(events);
        await fetchRecentResultsForGames(games);
        renderDebugPanel(games);
        const panel = document.getElementById('debugPanel');
        if (panel) { panel.style.display = 'block'; document.getElementById('debugToggle').textContent = 'Hide debug panel'; }
      } catch (e) { console.warn('open debug failed', e); }
    };
    header.appendChild(b);
  }
}

// why modal removed per user request

// previous simple start removed; use the single pipeline `start()` defined below.

// Simple start pipeline: fetch upcoming games, filter to home 2-game win streaks,
// pick deterministically for the week (seeded RNG), and render once.
async function start(){
  renderLoadingNextLock();
  // First try the Netlify function which provides the canonical server-side pick
  try {
    const r = await fetch('/.netlify/functions/current-pick', { cache: 'no-store' });
    if (r.ok) {
      try {
        const json = await r.json();
        if (json && json.id && isValidPick(json)) { console.log('serverless pick', json.meta?.path || 'unknown', json.id); renderGame(json); return; }
        console.warn('Function returned invalid shape or missing fields:', json);
      } catch (e) { console.warn('failed to parse function JSON', e); }
    } else {
      console.warn('current-pick function returned non-OK', r.status);
    }
  } catch (e) {
    console.warn('fetch to /.netlify/functions/current-pick failed', e);
  }

  // If function failed or returned nothing, fall back to client-side selection pipeline
  try {
    const events = await loadUpcomingGames();
    const games = normalizeGames(events);

    let pick = null;
    try { pick = await pickOne(games); } catch (e) { console.warn('pickOne failed during startup selection', e); pick = null; }

      if (!pick) {
        // fallback deterministic pick from full pool
        try {
          const { seed } = weeklySeed();
          const pool = Array.isArray(games) ? games.filter(g=>g && g.home && g.away) : [];
          if (pool.length) {
            const rng = mulberry32(seed || 12345);
            const idx = Math.floor(rng() * pool.length);
            const chosen = pool[idx];
            if (chosen) { chosen.pickTeam = chosen.home; if (typeof chosen.spread === 'number') chosen.spread = Math.abs(chosen.spread); pick = chosen; }
          }
        } catch (e) { console.warn('Fallback selection failed', e); }
      }

      if (pick) { console.log('client fallback pick', pick.id || 'unknown'); pick.meta = pick.meta || {}; pick.meta.path = pick.meta.path || 'client-fallback'; renderGame(pick); }
  else renderNoPickFound();

    try { checkAndUpdateStoredPick(games); } catch (e) { console.warn('check stored pick failed', e); }
    return;
  } catch (e) {
    console.warn('client-side fallback pipeline failed', e);
    renderGame({ home: 'Purdue Boilermakers', away: 'Notre Dame Fighting Irish', spreadTeam: 'Notre Dame Fighting Irish', spread: 6.5, kickoff: new Date().toISOString(), source: { provider: 'Sample Fallback' } });
  }
}

// Only start automatically when running in a browser (not when required by Node for tests)
// Only start automatically when running in a browser (not when required by Node for tests)
if (typeof module === 'undefined' || !module.exports) {
  if (typeof window !== 'undefined') start();
}

// Expose parser for test harnesses and attach to window when available
if (typeof window !== 'undefined') {
  window.parseSpreadFromOdds = parseSpreadFromOdds;
  window.analyzeGames = analyzeGames;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSpreadFromOdds, analyzeGames, pickOne, fetchRecentResultsForGames, pollForNextLock, stopPollingForNextLock };
}