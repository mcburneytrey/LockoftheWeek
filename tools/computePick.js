const fetch = require('node-fetch');
global.fetch = fetch;
const { parseSpreadFromOdds, pickOne } = require('../js/app.js');

function yyyymmddInCT(offset = 0){
  const now = new Date();
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  ct.setDate(ct.getDate() + offset);
  const y = ct.getFullYear();
  const m = String(ct.getMonth() + 1).padStart(2, '0');
  const d = String(ct.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

async function getTeamRecent(teamId){
  if (!teamId) return { lastResults: [], consecutiveWins: 0 };
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/${encodeURIComponent(teamId)}/schedule`;
  try{
    const r = await fetch(url, { timeout: 10000 });
    if(!r.ok) return { lastResults: [], consecutiveWins: 0 };
    const j = await r.json();
    const events = j.events || j.schedule || [];
    const lastResults = [];
    for (const ev of events){
      try{
        const comp = ev.competitions?.[0] || ev.competitions || null;
        if (!comp) continue;
        const competitor = comp.competitors?.find(c => String(c?.team?.id) === String(teamId) || String(c?.team?.teamId) === String(teamId));
        if (!competitor) continue;
        // prefer explicit winner flag
        if (typeof competitor.winner !== 'undefined') {
          lastResults.push(competitor.winner ? 'W' : 'L');
        } else if (competitor.score != null && comp.competitors) {
          const other = comp.competitors.find(c=>c !== competitor);
          if (other && other.score != null) {
            lastResults.push(Number(competitor.score) > Number(other.score) ? 'W' : 'L');
          }
        } else {
          // unknown -> skip
        }
        if (lastResults.length >= 10) break;
      }catch(e){/*ignore*/}
    }
    const mostRecent = lastResults.slice(0,10);
    let consecutiveWins = 0; for (const r of mostRecent){ if (/^W/i.test(r)) consecutiveWins++; else break; }
    return { lastResults: mostRecent, consecutiveWins };
  }catch(e){
    return { lastResults: [], consecutiveWins: 0 };
  }
}

(async ()=>{
  try{
    const date = yyyymmddInCT(0);
    console.log('Fetching scoreboard for', date);
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${date}`;
    const r = await fetch(url);
    if (!r.ok) { console.error('Scoreboard fetch failed', r.status); process.exit(1); }
    const json = await r.json();
    const events = json.events || [];
    console.log('Events found:', events.length);
    const games = [];
    for (const ev of events){
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const dateISO = comp.date || ev.date;
      const competitors = comp.competitors || [];
      const homeComp = competitors.find(c=>c.homeAway==='home');
      const awayComp = competitors.find(c=>c.homeAway==='away');
      const home = homeComp?.team?.displayName;
      const away = awayComp?.team?.displayName;
      const homeId = homeComp?.team?.id || homeComp?.team?.teamId;
      const awayId = awayComp?.team?.id || awayComp?.team?.teamId;
      if (!home || !away) continue;
      const odds = (comp.odds && comp.odds[0]) || null;
      const { spreadTeam, spread } = parseSpreadFromOdds(odds, home, away);
      const homeScore = homeComp?.score != null ? Number(homeComp.score) : undefined;
      const awayScore = awayComp?.score != null ? Number(awayComp.score) : undefined;
      const status = comp?.status?.type?.name || ev?.status?.type?.name;
      const gid = ev?.id || comp?.id || `${home}-${away}-${dateISO}`;
      const recent = await getTeamRecent(homeId);
      games.push({ id: gid, home, away, homeId, awayId, spreadTeam, spread, kickoff: dateISO, status, homeScore, awayScore, homeLastResults: recent.lastResults, homeConsecutiveWins: recent.consecutiveWins, source: { provider: odds?.provider?.name || 'ESPN' } });
    }

    console.log('Normalized games count:', games.length);
    const candidates = games.filter(g => g.home && g.homeConsecutiveWins >=2);
    console.log('Home teams with >=2 consecutive wins:', candidates.map(c=>({home:c.home,consec:c.homeConsecutiveWins} )));
    const pick = pickOne(games);
    console.log('Computed pick:', pick || 'No qualifying pick found');
    // Print full candidate details
    if (pick) console.log('Pick details:', JSON.stringify(pick, null, 2));
  }catch(e){
    console.error('Script failed:', e && e.stack ? e.stack : String(e));
    process.exit(1);
  }
})();
