const { extractFavoriteAndSpread, signedLineForPick } = require('../js/app.js');

function assertEqual(a,b,msg){
  const pass = JSON.stringify(a) === JSON.stringify(b);
  console.log((pass ? 'PASS' : 'FAIL') + ' - ' + msg);
  if(!pass){ console.log('  Expected:', b); console.log('  Received:', a); process.exitCode = 1; }
}

// Case 1: per-team numeric negative indicates favorite
const comp1 = { odds: [ { homeTeamOdds: { spread: -6.5 }, awayTeamOdds: { spread: 6.5 }, provider: { name: 'ESPN' } } ] };
const r1 = extractFavoriteAndSpread(comp1, 'Home Team', 'Away Team', 'H', 'A');
assertEqual(r1, { favoriteTeamId: 'H', spreadAbs: 6.5, provider: 'ESPN' }, 'per-team negative spread identifies home favorite');

// Case 2: details string with full team name
const comp2 = { odds: [ { details: 'Notre Dame -6.5', provider: { name: 'ESPN' } } ] };
const r2 = extractFavoriteAndSpread(comp2, 'Notre Dame', 'Purdue', 'ND', 'PU');
assertEqual(r2, { favoriteTeamId: 'ND', spreadAbs: 6.5, provider: 'ESPN' }, 'details string with full team name');

// Case 3: details with abbreviation
const comp3 = { odds: [ { details: 'GT -3.5', provider: { name: 'ESPN' } , competitors: [{team:{abbreviation:'GT'},homeAway:'home'},{team:{abbreviation:'OP'},homeAway:'away'}]} ] };
const r3 = extractFavoriteAndSpread(comp3, 'Georgia Tech', 'Opponent', 'GT', 'OP');
assertEqual(r3, { favoriteTeamId: 'GT', spreadAbs: 3.5, provider: 'ESPN' }, 'details string with abbreviation maps to team id');

// signedLineForPick tests
assertEqual(signedLineForPick({ pickTeamId: 'H', favoriteTeamId: 'H', spreadAbs: 6.5 }), '-6.5', 'signed line negative when pick is favorite');
assertEqual(signedLineForPick({ pickTeamId: 'A', favoriteTeamId: 'H', spreadAbs: 6.5 }), '+6.5', 'signed line positive when pick is dog');

console.log('Done oddsParsing tests');
