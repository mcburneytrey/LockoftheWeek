const { analyzeGames } = require('../js/app.js');

function assert(cond, msg){
  if(!cond){ console.error('FAIL -', msg); process.exitCode = 1; }
  else console.log('PASS -', msg);
}

const sample = [
  { home: 'A', away: 'B', spreadTeam: 'A', spread: 3, kickoff: new Date().toISOString(), source: { provider: 'ESPN' } },
  { home: 'C', away: 'D', spreadTeam: 'D', spread: 7, kickoff: new Date().toISOString(), source: { provider: 'Other' } },
  { home: 'E', away: 'F', spreadTeam: undefined, spread: undefined, kickoff: new Date().toISOString(), source: { provider: 'ESPN' } }
];

const res = analyzeGames(sample, { seed: 202501 });
assert(res && Array.isArray(res.list), 'returns list');
assert(res.recommendation && res.recommendation.score !== undefined, 'returns recommendation with score');
console.log('Top recommendation:', res.recommendation);
console.log('Done');
