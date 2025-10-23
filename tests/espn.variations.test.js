const { parseSpreadFromOdds, pickOne } = require('../js/app.js');

function assertEqual(a,b,msg){
  const pass = JSON.stringify(a) === JSON.stringify(b);
  console.log((pass ? 'PASS' : 'FAIL') + ' - ' + msg);
  if(!pass){ console.log('  Expected:', b); console.log('  Received:', a); process.exitCode = 1; }
}

// Variation 1: details string full name
const odds1 = { details: 'Notre Dame -6.5' };
assertEqual(parseSpreadFromOdds(odds1, 'Notre Dame Fighting Irish', 'Purdue Boilermakers'), { spreadTeam: 'Notre Dame Fighting Irish', spread: 6.5 }, 'details matches full name');

// Variation 2: abbreviation should be ambiguous
const odds2 = { details: 'ND -6.5' };
assertEqual(parseSpreadFromOdds(odds2, 'Notre Dame Fighting Irish', 'Purdue Boilermakers'), { spreadTeam: undefined, spread: 6.5 }, 'abbrev ambiguous');

// Variation 3: per-team numeric spreads
const odds3 = { homeTeamOdds: { spread: 3 }, awayTeamOdds: { spread: -3 } };
assertEqual(parseSpreadFromOdds(odds3, 'Home', 'Away'), { spreadTeam: 'Away', spread: 3 }, 'per-team negative indicates favorite');

// Variation 4: top-level spread only
const odds4 = { spread: -7 };
assertEqual(parseSpreadFromOdds(odds4, 'A', 'B'), { spreadTeam: undefined, spread: 7 }, 'top-level negative spread returns magnitude only');

// pickOne pick logic: ensure home underdog selection
const games = [
  { home: 'H1', away: 'A1', spreadTeam: 'A1', spread: 4, kickoff: new Date().toISOString(), source: { provider: 'ESPN' } },
  { home: 'H2', away: 'A2', spreadTeam: 'H2', spread: 2, kickoff: new Date().toISOString(), source: { provider: 'ESPN' } }
];
(async ()=>{
  const p = await pickOne(games);
  assertEqual(p && p.home, 'H1', 'pickOne prefers home underdog H1');
})();

console.log('Done ESPN variations tests');
