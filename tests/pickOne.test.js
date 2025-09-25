const { pickOne } = require('../js/app.js');

function assertEqual(a,b,msg){
  const pass = JSON.stringify(a) === JSON.stringify(b);
  console.log((pass ? 'PASS' : 'FAIL') + ' - ' + msg);
  if(!pass){ console.log('  Expected:', b); console.log('  Received:', a); process.exitCode = 1; }
}

// Test: home underdog should be picked
const games1 = [
  { home: 'HomeU', away: 'AwayU', spreadTeam: 'AwayU', spread: 3, kickoff: new Date().toISOString(), source: { provider: 'ESPN' } },
  { home: 'OtherHome', away: 'OtherAway', spreadTeam: 'OtherHome', spread: 2, kickoff: new Date().toISOString(), source: { provider: 'ESPN' } }
];
const pick1 = pickOne(games1);
assertEqual(pick1.home, 'HomeU', 'picks the home underdog when present');

// Test: spread >= 10 should be excluded
const games2 = [
  { home: 'BigDog', away: 'FavTeam', spreadTeam: 'FavTeam', spread: 12, kickoff: new Date().toISOString(), source: { provider: 'ESPN' } }
];
const pick2 = pickOne(games2);
assertEqual(pick2, null, 'no pick when only spreads >= 10');

console.log('Done pickOne tests');
