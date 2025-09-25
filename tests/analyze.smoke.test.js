const fetch = require('node-fetch');

// Start a dedicated test server on a non-default port to avoid colliding with a dev server
const TEST_PORT = 3010;
process.env.PORT = String(TEST_PORT);
// Ensure the server will use local analyzer fallback
process.env.OPENAI_API_KEY = '';

// Require the server which will start listening (server/proxy.js calls app.listen on require)
require('../server/proxy.js');

function assert(cond, msg){
  if(!cond){ console.error('FAIL -', msg); process.exitCode = 1; }
  else console.log('PASS -', msg);
}

(async () => {
  // small delay to let the server bind
  await new Promise(r => setTimeout(r, 500));

  const body = {
    games: [{ home: 'Purdue', away: 'Notre Dame', spreadTeam: 'Notre Dame', spread: 6.5, kickoff: '2025-09-25T20:00:00Z' }],
    seed: 202509
  };

  try {
    const resp = await fetch(`http://localhost:${TEST_PORT}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await resp.json();
    assert(Array.isArray(json.list), 'response contains list');
    assert(json.recommendation && typeof json.recommendation.score === 'number', 'response contains recommendation with numeric score');
    console.log('Smoke test completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Smoke test failed:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  }

})();
