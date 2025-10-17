// ===== Utilities
function mulberry32(seed){
  return function(){
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

function pickOne(games){
  const {seed, wk} = weeklySeed();
  if (typeof document !== 'undefined') {
    const weekLabelEl = document.getElementById('weekLabel');
    if (weekLabelEl) weekLabelEl.textContent = `WEEK ${wk} PICK`;
  }
  // New rule: pick a team that is the home team and has won its previous two games.
  // We accept one of several ways to provide recent results for the home team:
  //  - game.homeLastResults: an array like ['W','W',...], most-recent-first
  //  - game.homeConsecutiveWins: a number representing how many straight wins the home team has
  //  - options.recentWinsMap (deprecated-per-call): caller may pass a map via global/window later
  const options = {};

  const hasTwoRecentWins = (g, opts = {}) => {
    try {
      if (!g || !g.home) return false;
      if (Array.isArray(g.homeLastResults) && g.homeLastResults.length >= 2) {
        // If the most recent two are both wins, accept immediately
        if (/^W/i.test(String(g.homeLastResults[0])) && /^W/i.test(String(g.homeLastResults[1]))) return true;
        // Otherwise, allow a slightly looser rule: at least 2 wins in the last 3 games
        const recent3 = g.homeLastResults.slice(0,3);
        const winsIn3 = recent3.filter(x => /^W/i.test(String(x))).length;
        if (winsIn3 >= 2) return true;
      }
      if (typeof g.homeConsecutiveWins === 'number') return g.homeConsecutiveWins >= 2;
      const map = (opts.recentWinsMap) ? opts.recentWinsMap : (typeof window !== 'undefined' ? window.recentWinsMap : null);
      if (map && Array.isArray(map[g.home]) && map[g.home].length >= 2) {
        return /^W/i.test(String(map[g.home][0])) && /^W/i.test(String(map[g.home][1]));
      }
    } catch (e) { /* fallthrough */ }
    return false;
  };

  const candidates = (games || []).filter(g => {
    // require home team, recent wins, and a numeric spread with a declared favorite (spreadTeam)
    return g && g.home && g.away && hasTwoRecentWins(g, options) && typeof g.spread === 'number' && g.spreadTeam;
  });

  if (!candidates.length) return null;

  // From the remaining candidates, choose one speculatively. Use a deterministic weekly RNG so picks
  // are reproducible for the week but still allow a degree of 'speculation'.
  const rng = mulberry32(seed || 12345);
  const idx = Math.floor(rng() * candidates.length);
  return candidates[idx];
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
  function isHomeWithTwoWins(game){
    try{
      if (!game || !game.home) return false;
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
  // If the favorite is the away team, the home team is the underdog; show the home team as the pick.
  const pickTeam = (g && g.spreadTeam && g.spreadTeam === g.away) ? g.home : (g.spreadTeam || 'Pick');
  const dog = pickTeam === g.home ? g.away : g.home;
  // Determine sign relative to the displayed pickTeam: if pickTeam is the favorite, show '-' (they're favored);
  // if pickTeam is the underdog, show '+' (they're getting points). g.spread is stored as a positive magnitude.
  let line = 'PK';
  if (typeof g.spread === 'number') {
    const spreadMag = Math.abs(g.spread);
    const favorite = g.spreadTeam;
    if (favorite && pickTeam && favorite === pickTeam) {
      line = `-${spreadMag}`;
    } else {
      line = `+${spreadMag}`;
    }
  }
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
    const text = `Lock of the Week: ${fav} ${line} vs ${dog} — ${fmtKick(g.kickoff)}`;
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
    try { renderLoadingNextLock(); await startWithAnalysis(); } catch (e) { console.warn('manual refresh failed', e); }
  };
}

// Polling loop: re-fetch upcoming games and recent results every 30s until pickOne returns a different pick
let _pollAbort = false;
async function pollForNextLock(intervalMs = 30000){
  _pollAbort = false;
  const seed = weeklySeed().seed;
  while (!_pollAbort) {
    try {
      const events = await loadUpcomingGames();
      const games = normalizeGames(events);
      await fetchRecentResultsForGames(games);
      const candidate = pickOne(games);
      if (candidate) {
        // Stop polling and render the new pick
        _pollAbort = true;
        renderGame(candidate);
        ensureAnalysisUI();
        return;
      }
      // Also check stored pick against any finished games and update record
      try { checkAndUpdateStoredPick(games); } catch (e) { console.warn('check stored pick failed', e); }
    } catch (e) {
      console.warn('pollForNextLock error', e);
    }
    // Wait for interval or until aborted
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// Allow other code (or tests) to stop polling if needed
function stopPollingForNextLock(){ _pollAbort = true; }


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
  // Small, non-interactive indicator that analysis is available.
  // This creates a subtle badge near the Share button so we can iterate on it later.
  if (typeof document === 'undefined') return;
  if (document.getElementById('analysisAvailable')) return;
  const container = document.querySelector('[style*="justify-content:flex-end"]');
  if (!container) return;
  const badge = document.createElement('div');
  badge.id = 'analysisAvailable';
  badge.className = 'badge';
  badge.style.marginLeft = '8px';
  badge.style.cursor = 'default';
  badge.textContent = 'ANALYSIS AVAILABLE';
  container.appendChild(badge);
  return;
}

// why modal removed per user request

async function start(){
  try {
    const events = await loadUpcomingGames();
    const games = normalizeGames(events);
    const pick = pickOne(games);
    if (pick) { renderGame(pick); return; }
    throw new Error('No games in window');
  } catch (e){
    renderGame({
      home: 'Purdue Boilermakers',
      away: 'Notre Dame Fighting Irish',
      spreadTeam: 'Notre Dame Fighting Irish',
      spread: 6.5,
      kickoff: new Date().toISOString(),
      source: { provider: 'Sample Fallback' }
    });
  }
}

// Enhanced start that also requests server-side analysis (non-blocking)
async function startWithAnalysis(){
  ensureAnalysisUI();
  try {
    const events = await loadUpcomingGames();
    const games = normalizeGames(events);
  // Fetch recent home-team results (so pickOne can require two prior wins)
    await fetchRecentResultsForGames(games);
  const pick = pickOne(games);
  if (pick) {
      // If the picked game's kickoff has already started, show loading and poll for the next lock
      if (typeof window !== 'undefined' && typeof pick.kickoff === 'string') {
        try {
          const ko = new Date(pick.kickoff);
          const now = new Date();
          if (now >= ko) {
            renderLoadingNextLock();
            pollForNextLock();
            return;
          }
        } catch (e) { /* fallthrough to render normally */ }
      }
      renderGame(pick);
    }
    // If no pick was produced, render a helpful message explaining likely reasons and allow manual refresh
    if (!pick) {
      try { renderNoPickFound(); } catch (e) { console.warn('renderNoPickFound failed', e); }
    }
    // check stored pick against fetched games for finalization
    try { checkAndUpdateStoredPick(games); } catch(e) { console.warn('check stored pick failed', e); }

    // No 'Why this pick?' button per current selection rules

    // Fire-and-forget: ask server-side analyzer for ranked list
    try {
      const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ games }) });
      if (r.ok) {
        const json = await r.json();
        renderAnalysisPanel(json.list || []);
      } else {
        console.warn('Analysis endpoint returned non-OK', r.status);
      }
    } catch (e) { console.warn('Failed to fetch analysis', e); }

    return;
  } catch (e) {
    renderGame({
      home: 'Purdue Boilermakers',
      away: 'Notre Dame Fighting Irish',
      spreadTeam: 'Notre Dame Fighting Irish',
      spread: 6.5,
      kickoff: new Date().toISOString(),
      source: { provider: 'Sample Fallback' }
    });
  }
}

// Only start automatically when running in a browser (not when required by Node for tests)
// Only start automatically when running in a browser (not when required by Node for tests)
if (typeof module === 'undefined' || !module.exports) {
  if (typeof window !== 'undefined') startWithAnalysis();
}

// Expose parser for test harnesses and attach to window when available
if (typeof window !== 'undefined') {
  window.parseSpreadFromOdds = parseSpreadFromOdds;
  window.analyzeGames = analyzeGames;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSpreadFromOdds, analyzeGames, pickOne, fetchRecentResultsForGames, pollForNextLock, stopPollingForNextLock };
}