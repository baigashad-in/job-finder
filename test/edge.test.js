'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-tinyfish');

test('slow Agent runs are cancelled so they stop using credits', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  process.env.TINYFISH_AGENT_URL = `http://127.0.0.1:${mock.port}/agent`;
  const { TinyFish } = require('../src/tinyfish');
  const tf = new TinyFish({ apiKey: 'test-key' });
  const run = await tf.agentRun({ url: 'https://careers.vandelay.com/jobs', goal: 'x' }, { maxWaitMs: 100, pollMs: 60 });
  assert.equal(run.status, 'CANCELLED');
  assert.equal(mock.st.calls.cancel, 1);
  assert.equal(tf.stats.agent.failed, 1);
});

test('a bad API key gives a clear error', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  process.env.TINYFISH_SEARCH_URL = `http://127.0.0.1:${mock.port}/search`;
  const { TinyFish } = require('../src/tinyfish');
  const tf = new TinyFish({ apiKey: 'wrong' });
  await assert.rejects(tf.search({ query: 'x' }), /returned 401: bad key/);
});

test('server refuses to search without an API key', async (t) => {
  const saved = process.env.TINYFISH_API_KEY;
  delete process.env.TINYFISH_API_KEY;
  const { server } = require('../server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); if (saved) process.env.TINYFISH_API_KEY = saved; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.hasKey, false);
  const res = await fetch(`${base}/api/search`, { method: 'POST', body: JSON.stringify({ prefs: { role: 'x' } }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /TINYFISH_API_KEY/);
});
