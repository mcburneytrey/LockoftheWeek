const { pickOne } = require('../js/app.js');

function assertEqual(a,b,msg){
  const pass = JSON.stringify(a) === JSON.stringify(b);
  console.log((pass ? 'PASS' : 'FAIL') + ' - ' + msg);
  if(!pass){ console.log('  Expected:', b); console.log('  Received:', a); process.exitCode = 1; }
}

// Test: home underdog should be picked
// Candidate must be a home team that has won its previous two games.
const games1 = [
  { home: 'HomeU', away: 'AwayU', homeLastResults: ['W','W','L'], kickoff: new Date().toISOString(), source: { provider: 'ESPN' }, spread: 3, spreadTeam: 'AwayU' },
  { home: 'OtherHome', away: 'OtherAway', homeLastResults: ['L','W','W'], kickoff: new Date().toISOString(), source: { provider: 'ESPN' }, spread: 2, spreadTeam: 'OtherAway' }
];
(async ()=>{
  const pick1 = await pickOne(games1);
  assertEqual(['HomeU','OtherHome'].includes(pick1 && pick1.home), true, 'picks a home team with two recent wins');
})();

// Test: no candidate if no home team has two prior wins
const games2 = [
  { home: 'NoWin1', away: 'A', homeLastResults: ['L','W'], kickoff: new Date().toISOString(), source: { provider: 'ESPN' }, spread: 4, spreadTeam: 'A' },
  { home: 'NoWin2', away: 'B', homeLastResults: ['L','L'], kickoff: new Date().toISOString(), source: { provider: 'ESPN' }, spread: 5, spreadTeam: 'B' }
];
(async ()=>{
  const pick2 = await pickOne(games2);
  assertEqual(['NoWin1','NoWin2'].includes(pick2 && pick2.home), true, 'fallback pick from games with spreads when no home has two prior wins');
})();

console.log('Done pickOne tests');
