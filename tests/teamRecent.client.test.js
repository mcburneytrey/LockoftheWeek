const { fetchRecentResultsForGames } = require('../js/app.js');
const fetch = require('node-fetch');

function assertEqual(a,b,msg){
  const pass = JSON.stringify(a) === JSON.stringify(b);
  console.log((pass ? 'PASS' : 'FAIL') + ' - ' + msg);
  if(!pass){ console.log('  Expected:', b); console.log('  Received:', a); process.exitCode = 1; }
}

// Mock global.fetch by calling the local server endpoint (we'll stub responses using a small in-memory map)
// But since fetchRecentResultsForGames uses window.fetch in browser and global fetch in Node via node-fetch
// we'll monkeypatch global.fetch to intercept calls to /espn/teamRecent
const realFetch = global.fetch || fetch;

global.fetch = async function(url, opts){
  if (typeof url === 'string' && url.startsWith('/espn/teamRecent')){
    const u = new URL('http://localhost' + url);
    const teamId = u.searchParams.get('teamId');
    if (teamId === '100') return { ok: true, json: async()=>({ teamId:'100', teamName:'TestHome', lastResults:['W','W','L'], consecutiveWins:2 }) };
    if (teamId === '200') return { ok: true, json: async()=>({ teamId:'200', teamName:'OtherHome', lastResults:['L','W'], consecutiveWins:0 }) };
    return { ok: false, status: 404, json: async()=>({}) };
  }
  return realFetch(url, opts);
};

(async ()=>{
  const games = [ { home: 'TestHome', homeId: '100', away: 'A'}, { home: 'OtherHome', homeId: '200', away: 'B' } ];
  const out = await fetchRecentResultsForGames(games);
  assertEqual(out[0].homeLastResults, ['W','W','L'], 'merged lastResults for team 100');
  assertEqual(out[0].homeConsecutiveWins, 2, 'merged consecutiveWins for team 100');
  assertEqual(out[1].homeLastResults, ['L','W'], 'merged lastResults for team 200');
  console.log('Done teamRecent.client test');
  process.exit(0);
})();
