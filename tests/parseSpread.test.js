const { parseSpreadFromOdds } = require('../js/app.js');

function assertEqual(a, b, msg) {
  const pass = JSON.stringify(a) === JSON.stringify(b);
  console.log((pass ? 'PASS' : 'FAIL') + ' - ' + msg);
  if(!pass) {
    console.log('  Expected:', b);
    console.log('  Received:', a);
    process.exitCode = 1;
  }
}

// Test 1: details string with team name before number
const odds1 = { details: 'Notre Dame -6.5' };
assertEqual(parseSpreadFromOdds(odds1, 'Notre Dame Fighting Irish', 'Purdue Boilermakers'), { spreadTeam: 'Notre Dame Fighting Irish', spread: 6.5 }, 'details string with full team name');

// Test 2: details string with abbreviation and parentheses
const odds2 = { details: 'ND -6.5 (home)'};
assertEqual(parseSpreadFromOdds(odds2, 'Notre Dame Fighting Irish', 'Purdue Boilermakers'), { spreadTeam: undefined, spread: 6.5 }, 'details string with abbreviation (no match)');

// Test 3: nested homeTeamOdds/awayTeamOdds numeric negative indicates favorite
const odds3 = { homeTeamOdds: { spread: -3 }, awayTeamOdds: { spread: 3 } };
assertEqual(parseSpreadFromOdds(odds3, 'HomeTeam', 'AwayTeam'), { spreadTeam: 'HomeTeam', spread: 3 }, 'nested numeric negative identifies favorite');

// Test 4: top-level spread field
const odds4 = { spread: -7 };
assertEqual(parseSpreadFromOdds(odds4, 'A', 'B'), { spreadTeam: undefined, spread: 7 }, 'top-level numeric spread');

// Test 5: missing odds
assertEqual(parseSpreadFromOdds(null, 'A', 'B'), { spreadTeam: undefined, spread: undefined }, 'null odds returns undefineds');

console.log('Done tests');
