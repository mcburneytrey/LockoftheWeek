const fetch = require('node-fetch');

// Provide a MOCK_OPENAI_CONTENT string so the server uses it instead of calling real OpenAI
const assistantJson = JSON.stringify({
  list: [
    { home: 'Purdue', away: 'Notre Dame', spreadTeam: 'Notre Dame', spread: 6.5, score: 0.75, explain: 'Mocked OpenAI rationale' }
  ],
  recommendation: { home: 'Purdue', away: 'Notre Dame', score: 0.75 }
});

process.env.MOCK_OPENAI_CONTENT = assistantJson;
process.env.OPENAI_API_KEY = 'test-mocked-key';
process.env.PORT = '3011';

// Now require the server (it will use MOCK_OPENAI_CONTENT)
require('../server/proxy.js');

const realFetch = require('node-fetch');

function assert(cond, msg){
  if(!cond){ console.error('FAIL -', msg); process.exitCode = 1; }
  else console.log('PASS -', msg);
}

(async () => {
  // brief delay for server to start
  await new Promise(r => setTimeout(r, 500));

  const body = { games: [{ home: 'Purdue', away: 'Notre Dame', spreadTeam: 'Notre Dame', spread: 6.5, kickoff: '2025-09-25T20:00:00Z' }], seed: 202509 };

  try {
    const resp = await realFetch('http://localhost:3011/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await resp.json();
    assert(Array.isArray(json.list), 'response contains list');
    assert(json.recommendation && typeof json.recommendation.score === 'number', 'response contains recommendation with numeric score');
    console.log('Mocked OpenAI test completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Mocked OpenAI test failed:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  }

})();
