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
    const home = competitors.find(c=>c.homeAway==='home')?.team?.displayName;
    const away = competitors.find(c=>c.homeAway==='away')?.team?.displayName;
    if(!home||!away) continue;
    const odds = (comp.odds && comp.odds[0]) || null;
    const {spreadTeam, spread} = parseSpreadFromOdds(odds, home, away);
    out.push({home,away,spreadTeam,spread,kickoff: dateISO, source:{provider: odds?.provider?.name || 'ESPN'}});
  }
  return out;
}

function pickOne(games){
  const {seed, wk} = weeklySeed();
  if (typeof document !== 'undefined') {
    const weekLabelEl = document.getElementById('weekLabel');
    if (weekLabelEl) weekLabelEl.textContent = `WEEK ${wk} PICK`;
  }
  // New rule: select a home underdog (home team is underdog) with spread < 10 points.
  // Our normalized games use `spread` as a positive magnitude and `spreadTeam` as the favorite.
  // A home underdog means the favorite is the away team (spreadTeam === away).
  const candidates = (games || []).filter(g => {
    return g && g.home && g.away && typeof g.spread === 'number' && g.spread < 10 && g.spreadTeam && g.spreadTeam === g.away;
  });

  if (!candidates.length) return null;

  // Prefer the smallest spread (closest underdog) — sort ascending by spread.
  candidates.sort((a,b) => a.spread - b.spread);

  // If there's a tie on spread, break ties deterministically using the weekly seed RNG.
  const topSpread = candidates[0].spread;
  const tied = candidates.filter(c => c.spread === topSpread);
  if (tied.length === 1) return tied[0];

  const rng = mulberry32(seed || 12345);
  const idx = Math.floor(rng() * tied.length);
  return tied[idx];
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

}

function renderAnalysisPanel(list){
  const el = document.getElementById('analysisPanel');
  if(!el) return;
  if(!Array.isArray(list) || !list.length){ el.innerHTML = '<div class="small">No analysis available.</div>'; return; }
  el.innerHTML = '<ol>' + list.map(item=>`<li><strong>${item.home} vs ${item.away}</strong> — score ${Number(item.score).toFixed(3)} ${formatExplainForHtml(item.explain)}</li>`).join('') + '</ol>';
}

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
    const pick = pickOne(games);
    if (pick) renderGame(pick);

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
  module.exports = { parseSpreadFromOdds, analyzeGames, pickOne };
}