// ===== Utilities
function mulberry32(seed){return function(){let t=(seed+=0x6d2b79f5);t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;} };
function seasonStartUTC(year){const d=new Date(Date.UTC(year,7,25));while(d.getUTCDay()!==4)d.setUTCDate(d.getUTCDate()+1);return d;}
function getCfbWeek(today=new Date()){const y=today.getUTCFullYear();let s=seasonStartUTC(y);if(today<s)s=seasonStartUTC(y-1);const diffDays=Math.floor((Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate())-s.getTime())/86400000);return Math.max(1,Math.min(16,Math.floor(diffDays/7)+1));}
function weeklySeed(){const now=new Date();return {seed: now.getUTCFullYear()*100+getCfbWeek(now), wk: getCfbWeek(now)};}
function yyyymmddInCT(offset=0){const now=new Date();const ct=new Date(now.toLocaleString('en-US',{timeZone:'America/Chicago'}));ct.setDate(ct.getDate()+offset);const y=ct.getFullYear();const m=String(ct.getMonth()+1).padStart(2,'0');const d=String(ct.getDate()).padStart(2,'0');return `${y}${m}${d}`;}
function fmtKick(iso){try{const d=new Date(iso);return d.toLocaleString('en-US',{timeZone:'America/Chicago',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch{return iso;}}
const norm=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
function parseSpreadFromOdds(odds, home, away){
  if(!odds) return {spreadTeam: undefined, spread: undefined};

  const details = typeof odds.details === 'string' ? odds.details.trim() : undefined;
  if(details){
    const matches = [...details.matchAll(/([+-]?\d+(?:\.\d+)?)/g)];
    if(matches.length){
      const lastNumStr = matches[matches.length-1][0];
      const num = parseFloat(lastNumStr);
      if(!Number.isNaN(num)){
        const teamStr = details.replace(lastNumStr, '').replace(/[()]/g, '').replace(/vs\.?/i, '').trim();
        const t = norm(teamStr), h = norm(home), a = norm(away);
        let spreadTeam;
        if(t && (t.includes(h) || h.includes(t))) spreadTeam = home;
        else if(t && (t.includes(a) || a.includes(t))) spreadTeam = away;
        else spreadTeam = undefined;
        return {spreadTeam, spread: Math.abs(num)};
      }
    }
  }

  const h = (odds.homeTeamOdds || {}), a = (odds.awayTeamOdds || {});
  const candidateKeys = ['spread','pointSpread','handicap','line'];
  for(const k of candidateKeys){
    const hv = h[k], av = a[k];
    if(typeof hv === 'number' && typeof av === 'number'){
      if(hv < av) return {spreadTeam: home, spread: Math.abs(hv)};
      if(av < hv) return {spreadTeam: away, spread: Math.abs(av)};
    }
    if(typeof hv === 'number' && hv < 0) return {spreadTeam: home, spread: Math.abs(hv)};
    if(typeof av === 'number' && av < 0) return {spreadTeam: away, spread: Math.abs(av)};
  }

  const topKeys = ['spread','pointSpread','line'];
  for(const k of topKeys){
    if(typeof odds[k] === 'number') return {spreadTeam: undefined, spread: Math.abs(odds[k])};
  }

  return {spreadTeam: undefined, spread: undefined};
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
      // non-OK status; fall through to proxy attempt
      console.warn('ESPN returned non-OK status', r.status, url);
    } catch (e) {
      console.warn('Direct fetch failed (possibly CORS/network):', e, url);
    }

    // Attempt local proxy (only works if user runs the optional proxy server)
    try {
      const proxyUrl = `/espn/scoreboard?dates=${encodeURIComponent(date)}`;
      const rp = await fetch(proxyUrl);
      if(rp.ok) return await rp.json();
      console.warn('Proxy returned non-OK status', rp.status, proxyUrl);
    } catch (e) {
      console.warn('Proxy fetch failed:', e);
    }

    // Both attempts failed
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
    const comp = ev?.competitions?.[0]; if(!comp) continue;
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
  document.getElementById('weekLabel').textContent = `WEEK ${wk} PICK`;
  const rng = mulberry32(seed);
  const forced = games.find(g=>{
    const n = (g.home||'') + '|' + (g.away||'');
    return /notre dame/i.test(n) && /purdue/i.test(n);
  });
  if(forced){
    forced.spreadTeam = forced.home && /notre dame/i.test(forced.home) ? forced.home : forced.spreadTeam;
    return forced;
  }
  const withSpread = games.filter(g=>g.spreadTeam && typeof g.spread==='number');
  const pool = withSpread.length ? withSpread : games;
  if(!pool.length) return null;
  const idx = Math.floor(rng()*pool.length);
  return pool[idx];
}

function renderGame(g){
  const content = document.getElementById('content');
  if(!g){
    content.innerHTML = `<div class="error">No upcoming college games found. Try again later.</div>`;
    return;
  }
  const fav = g.spreadTeam || 'Pick';
  const dog = fav === g.home ? g.away : g.home;
  const line = (g.spread!==undefined) ? (g.spread>=0?`-${g.spread}`:`+${Math.abs(g.spread)}`) : 'PK';
  content.innerHTML = `
    <div class="teams">
      <div class="teambox away">
        <div class="teamlbl">AWAY</div>
        <div class="teamname">${g.away}</div>
      </div>
      <div>
        <div class="spreadlbl">SPREAD</div>
        <div class="spreadtxt"><span class="fav">${fav}</span> <span class="num">${line}</span></div>
        <div class="kick">${fmtKick(g.kickoff)}</div>
        <div class="source">Source: ${g.source?.provider || 'ESPN'}</div>
      </div>
      <div class="teambox home">
        <div class="teamlbl">HOME</div>
        <div class="teamname">${g.home}</div>
      </div>
    </div>
    <div class="ribbon">
      <div class="pill">🏆 LOCK (FOR FUN!)</div>
      <div class="pill2">AGAINST THE SPREAD</div>
    </div>`;

  const share = () => {
    const text = `Lock of the Week: ${fav} ${line} vs ${dog} — ${fmtKick(g.kickoff)}`;
    if(navigator.share){ navigator.share({title:'Lock of the Week', text, url: location.href}).catch(()=>{}); }
    else { navigator.clipboard.writeText(text).then(()=>alert('Copied to clipboard!')).catch(()=>{}); }
  };
  document.getElementById('shareBtn').onclick = share;
}

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

// Only start automatically when running in a browser (not when required by Node for tests)
if (typeof module === 'undefined' || !module.exports) {
  start();
}

// Expose parser for test harnesses and attach to window when available
if (typeof window !== 'undefined') {
  window.parseSpreadFromOdds = parseSpreadFromOdds;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSpreadFromOdds };
}
