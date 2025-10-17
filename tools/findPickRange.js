const fetch = require('node-fetch');
global.fetch = fetch;
const { parseSpreadFromOdds } = require('../js/app.js');

function yyyymmddInCT(offset = 0){
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  ct.setDate(ct.getDate() + offset);
  const y = ct.getFullYear();
  const m = String(ct.getMonth() + 1).padStart(2, '0');
  const d = String(ct.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

async function getScoreboard(date){
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${date}`;
  try{ const r = await fetch(url); if(!r.ok) return null; return await r.json(); }catch(e){ return null; }
}

async function getTeamRecent(teamId){
  if (!teamId) return { lastResults: [], consecutiveWins: 0 };
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${encodeURIComponent(teamId)}/schedule`;
  try{
    const r = await fetch(url, { timeout: 10000 });
    if(!r.ok) return { lastResults: [], consecutiveWins: 0 };
    const j = await r.json();
    let events = j.events || j.schedule || [];
    try { events = Array.from(events).sort((a,b)=> new Date(b?.date || b?.startDate || 0) - new Date(a?.date || a?.startDate || 0)); } catch(e){}
    const lastResults = [];
    for (const ev of events){
      try{
        const comp = ev.competitions?.[0] || ev.competitions || null; if(!comp) continue;
        const competitor = comp.competitors?.find(c => String(c?.team?.id) === String(teamId) || String(c?.team?.teamId) === String(teamId));
        if (!competitor) continue;
        if (typeof competitor.winner !== 'undefined') lastResults.push(competitor.winner ? 'W' : 'L');
        else if (competitor.score != null && comp.competitors){
          const other = comp.competitors.find(c=>c !== competitor);
          if (other && other.score != null) lastResults.push(Number(competitor.score) > Number(other.score) ? 'W' : 'L');
        }
        if (lastResults.length >= 10) break;
      }catch(e){}
    }
    const mostRecent = lastResults.slice(0,10);
    const cw = mostRecent.reduce((acc,r)=> acc + (/^W/i.test(r) ? 1 : 0), 0);
    let consecutiveWins = 0; for (const r of mostRecent){ if (/^W/i.test(r)) consecutiveWins++; else break; }
    return { lastResults: mostRecent, consecutiveWins };
  }catch(e){ return { lastResults: [], consecutiveWins: 0 }; }
}

function qualifiesRecent(g){
  if (!g || !g.homeLastResults) return false;
  if (g.homeLastResults.length >= 2 && /^W/i.test(String(g.homeLastResults[0])) && /^W/i.test(String(g.homeLastResults[1]))) return true;
  const recent3 = (g.homeLastResults || []).slice(0,3);
  const wins3 = recent3.filter(x=>/^W/i.test(String(x))).length;
  return wins3 >= 2;
}

(async ()=>{
  const matches = [];
  // scan past 7 days and next 2 days
  for (let off = -7; off <= 2; off++){
    const date = yyyymmddInCT(off);
    process.stdout.write(`Scanning ${date}... `);
    const sb = await getScoreboard(date);
    if (!sb || !sb.events) { console.log('no events'); continue; }
    console.log(`${sb.events.length} events`);
    for (const ev of sb.events){
      const comp = ev.competitions?.[0]; if(!comp) continue;
      const competitors = comp.competitors || [];
      const homeComp = competitors.find(c=>c.homeAway==='home');
      const awayComp = competitors.find(c=>c.homeAway==='away');
      const home = homeComp?.team?.displayName; const away = awayComp?.team?.displayName;
      const homeId = homeComp?.team?.id || homeComp?.team?.teamId; const awayId = awayComp?.team?.id || awayComp?.team?.teamId;
      if (!home || !away) continue;
      const odds = (comp.odds && comp.odds[0]) || null;
      const { spreadTeam, spread } = parseSpreadFromOdds(odds, home, away);
      const homeScore = homeComp?.score != null ? Number(homeComp.score) : undefined;
      const awayScore = awayComp?.score != null ? Number(awayComp.score) : undefined;
      const status = comp?.status?.type?.name || ev?.status?.type?.name;
      const gid = ev?.id || comp?.id || `${home}-${away}-${comp.date}`;
      const recent = await getTeamRecent(homeId);
      const g = { id: gid, home, away, homeId, awayId, spreadTeam, spread, kickoff: comp.date, status, homeScore, awayScore, homeLastResults: recent.lastResults, homeConsecutiveWins: recent.consecutiveWins };
      if (qualifiesRecent(g) && typeof g.spread === 'number' && g.spreadTeam) {
        matches.push({ date, game: g });
      }
    }
  }
  if (!matches.length) console.log('\nNo qualifying games with numeric spread found in scanned range.');
  else {
    console.log('\nFound qualifying games:');
    for (const m of matches) console.log(JSON.stringify({ date: m.date, home: m.game.home, away: m.game.away, spreadTeam: m.game.spreadTeam, spread: m.game.spread, recent: m.game.homeLastResults.slice(0,5) }, null, 2));
  }
})();
