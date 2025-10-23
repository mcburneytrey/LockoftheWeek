// Netlify Function: current-pick
// Returns a deterministic weekly pick for upcoming CFB games.
// Uses the same seeded RNG logic as the client. If anything fails, returns a reasonable fallback pick (HTTP 200).

// Note: relies on global fetch (Node 18+). Keep implementation defensive.

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

function extractNum(v){
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'string'){
    const n = parseFloat(v.replace(/[^\d\.\-+]/g, ''));
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function parseSpreadFromOdds(odds, home, away){
  if (!odds) return { spreadTeam: undefined, spread: undefined };
  if (typeof odds.details === 'string'){
    const details = odds.details.trim();
    const m = details.match(/^\s*(.+?)\s+([+-]?\d+(?:\.\d+)?)(?:\s+.*)?$/);
    if (m){
      const teamTextRaw = m[1].replace(/vs\.?/i, '').replace(/[()]/g, '').trim();
      const rawNum = parseFloat(m[2]);
      if (!Number.isNaN(rawNum) && teamTextRaw.length){
        const clean = s => (s||'').toLowerCase().replace(/[^\w\s]/g,'').trim();
        const tokens = s => clean(s).split(/\s+/).filter(Boolean);
        const tokenMatch = (a,b)=>{ const A = tokens(a); const B = tokens(b); return A.some(x=>B.some(y=>x && y && (x.includes(y)||y.includes(x)))); };
        const homeNorm = (home||'').toLowerCase();
        const awayNorm = (away||'').toLowerCase();
        const teamClean = clean(teamTextRaw);
        if (tokenMatch(teamClean, homeNorm) || homeNorm.includes(teamClean) || teamClean.includes(homeNorm)) return { spreadTeam: home, spread: Math.abs(rawNum) };
        if (tokenMatch(teamClean, awayNorm) || awayNorm.includes(teamClean) || teamClean.includes(awayNorm)) return { spreadTeam: away, spread: Math.abs(rawNum) };
        return { spreadTeam: undefined, spread: Math.abs(rawNum) };
      }
    }
  }
  const homeOdds = odds.homeTeamOdds || {};
  const awayOdds = odds.awayTeamOdds || {};
  const homeCandidates = [homeOdds.spread, homeOdds.pointSpread, homeOdds.handicap, homeOdds.line];
  const awayCandidates = [awayOdds.spread, awayOdds.pointSpread, awayOdds.handicap, awayOdds.line];
  const homeVal = homeCandidates.map(extractNum).find(v=>typeof v==='number');
  const awayVal = awayCandidates.map(extractNum).find(v=>typeof v==='number');
  if (typeof homeVal === 'number' && typeof awayVal === 'number'){
    if (homeVal < 0 && awayVal >= 0) return { spreadTeam: home, spread: Math.abs(homeVal) };
    if (awayVal < 0 && homeVal >= 0) return { spreadTeam: away, spread: Math.abs(awayVal) };
    return { spreadTeam: undefined, spread: undefined };
  }
  if (typeof homeVal === 'number' && homeVal < 0) return { spreadTeam: home, spread: Math.abs(homeVal) };
  if (typeof awayVal === 'number' && awayVal < 0) return { spreadTeam: away, spread: Math.abs(awayVal) };
  const topCandidates = [odds.spread, odds.pointSpread, odds.handicap, odds.line];
  const topVal = topCandidates.map(extractNum).find(v=>typeof v==='number');
  if (typeof topVal === 'number') return { spreadTeam: undefined, spread: Math.abs(topVal) };
  return { spreadTeam: undefined, spread: undefined };
}

async function fetchScoreboards(){
  const dates = Array.from({length:7}, (_,i)=>yyyymmddInCT(i));
  const urls = dates.map(d=>`https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${d}`);
  const events = [];
  await Promise.all(urls.map(async u=>{
    try { const r = await fetch(u); if (r.ok){ const j = await r.json(); if (j?.events?.length) events.push(...j.events); } } catch(e) { /* ignore individual fetch errors */ }
  }));
  return events;
}

function normalizeGames(events){
  const out = [];
  for (const ev of events){
    const comp = ev?.competitions?.[0]; if (!comp) continue;
    const dateISO = comp.date || ev.date;
    const competitors = comp.competitors || [];
    const homeComp = competitors.find(c=>c.homeAway==='home');
    const awayComp = competitors.find(c=>c.homeAway==='away');
    const home = homeComp?.team?.displayName; const away = awayComp?.team?.displayName;
    const homeId = homeComp?.team?.id || homeComp?.team?.teamId; const awayId = awayComp?.team?.id || awayComp?.team?.teamId;
    if (!home || !away) continue;
    const odds = (comp.odds && comp.odds[0]) || null;
    const { spreadTeam, spread } = parseSpreadFromOdds(odds, home, away);
    const gid = ev?.id || comp?.id || `${home}-${away}-${dateISO}`;
    out.push({ id: gid, home, away, homeId, awayId, spreadTeam, spread, kickoff: dateISO, source: { provider: odds?.provider?.name || 'ESPN' } });
  }
  return out;
}

async function isTwoGameWinStreak(teamId){
  if (!teamId) return false;
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${encodeURIComponent(teamId)}/schedule`;
    const r = await fetch(url);
    if (!r.ok) return false;
    const j = await r.json();
    let events = j.events || j.schedule || [];
    try { events = Array.from(events).sort((a,b)=> new Date(b?.date || b?.startDate || 0) - new Date(a?.date || a?.startDate || 0)); } catch(e){}
    const completed = [];
    for (const ev of events){
      try {
        const comp = ev.competitions?.[0] || null; if (!comp) continue;
        const status = comp?.status || ev?.status || {};
        const completedFlag = status?.type?.completed === true || status?.type?.name === 'STATUS_FINAL' || status?.type?.name === 'FINAL';
        if (!completedFlag) continue;
        const competitor = comp.competitors?.find(c => String(c?.team?.id) === String(teamId) || String(c?.team?.teamId) === String(teamId));
        if (!competitor) continue;
        let isWin = false;
        if (typeof competitor.winner === 'boolean') isWin = competitor.winner === true;
        else if (competitor.score != null && comp.competitors){
          const other = comp.competitors.find(c=>c !== competitor);
          if (other && other.score != null) isWin = Number(competitor.score) > Number(other.score);
        }
        completed.push(isWin ? 'W' : 'L');
        if (completed.length >= 2) break;
      } catch(e){}
    }
    return completed.length >= 2 && /^W/i.test(completed[0]) && /^W/i.test(completed[1]);
  } catch (e){ return false; }
}

exports.handler = async function handler(event, context){
  try {
    const events = await fetchScoreboards();
    const games = normalizeGames(events);
    if (!Array.isArray(games) || !games.length){
      const fb = { id: 'fallback-no-games', home: 'Purdue Boilermakers', away: 'Notre Dame Fighting Irish', homeId: null, awayId: null, spread: 6.5, spreadTeam: 'Notre Dame Fighting Irish', kickoff: new Date().toISOString(), source: { provider: 'fallback' }, pickTeam: 'Purdue Boilermakers', meta: { path: 'fallback' } };
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fb) };
    }

    // build unique home ids
    const homeIds = Array.from(new Set(games.map(g=>g.homeId).filter(Boolean)));
    const streakMap = new Map();
    await Promise.all(homeIds.map(async id => {
      try { const ok = await isTwoGameWinStreak(id); streakMap.set(id, ok); } catch(e){ console.error('team schedule fetch failed for', id, e?.message || e); streakMap.set(id, false); }
    }));

    const streakGames = games.filter(g => g && g.homeId && streakMap.get(g.homeId) === true);
    const pool = (streakGames && streakGames.length) ? streakGames : games.filter(g=>g && g.home && g.away);
    const { seed } = weeklySeed();
    const rng = mulberry32(seed || 12345);
    let chosen = null;
    if (pool && pool.length){
      chosen = pool[Math.floor(rng() * pool.length)];
      if (chosen) {
        chosen.pickTeam = chosen.home;
        if (typeof chosen.spread === 'number') chosen.spread = Math.abs(chosen.spread);
      }
    }

    if (!chosen){
      // fallback pick
      const fb = { id: 'fallback', home: 'Purdue Boilermakers', away: 'Notre Dame Fighting Irish', homeId: null, awayId: null, spread: 6.5, spreadTeam: 'Notre Dame Fighting Irish', kickoff: new Date().toISOString(), source: { provider: 'fallback' }, pickTeam: 'Purdue Boilermakers', meta: { path: 'fallback' } };
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fb) };
    }

    // return the chosen pick
    const resp = { id: chosen.id, home: chosen.home, away: chosen.away, homeId: chosen.homeId, awayId: chosen.awayId, spread: chosen.spread, spreadTeam: chosen.spreadTeam, kickoff: chosen.kickoff, source: chosen.source, pickTeam: chosen.pickTeam, meta: { path: (streakGames && streakGames.length) ? 'streak' : 'fallback' } };
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(resp) };
  } catch (e) {
    console.error('current-pick function failed', e?.message || e);
    // On total failure, return a fallback but still 200 so clients can render
    const fb = { id: 'fallback-exception', home: 'Purdue Boilermakers', away: 'Notre Dame Fighting Irish', homeId: null, awayId: null, spread: 6.5, spreadTeam: 'Notre Dame Fighting Irish', kickoff: new Date().toISOString(), source: { provider: 'fallback' }, pickTeam: 'Purdue Boilermakers', meta: { path: 'fallback' } };
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fb) };
  }
};
