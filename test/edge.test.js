'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-tinyfish');

test('slow Agent runs are cancelled so they stop using credits', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  // The run stays RUNNING for a minute, far past the 100ms deadline, so the result
  // does not depend on timer precision (Windows timers are coarser than Linux).
  mock.st.runDelayMs = 60000;
  process.env.TINYFISH_AGENT_URL = `http://127.0.0.1:${mock.port}/agent`;
  const { TinyFish } = require('../src/tinyfish');
  const tf = new TinyFish({ apiKey: 'test-key' });
  const run = await tf.agentRun({ url: 'https://careers.vandelay.com/jobs', goal: 'x' }, { maxWaitMs: 100, pollMs: 60 });
  assert.equal(run.status, 'CANCELLED');
  assert.equal(mock.st.calls.cancel, 1);
  assert.equal(tf.stats.agent.failed, 1);
});

test('time waiting in the TinyFish queue does not count against the run limit', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  process.env.TINYFISH_AGENT_URL = `http://127.0.0.1:${mock.port}/agent`;
  mock.st.pendingMs = 300; // queued for 300ms, then runs for 150ms
  const { TinyFish } = require('../src/tinyfish');
  const tf = new TinyFish({ apiKey: 'test-key' });
  const run = await tf.agentRun({ url: 'https://careers.vandelay.com/jobs', goal: 'x' }, { maxWaitMs: 1000, pollMs: 50 });
  assert.equal(run.status, 'COMPLETED');
  process.env.AGENT_MAX_PENDING_SECONDS = '0.2';
  const stuck = await tf.agentRun({ url: 'https://careers.vandelay.com/jobs', goal: 'x' }, { maxWaitMs: 1000, pollMs: 50 });
  delete process.env.AGENT_MAX_PENDING_SECONDS;
  assert.equal(stuck.status, 'CANCELLED');
  assert.match(stuck.error.message, /Still queued/);
});

test('Agent stops starting runs after repeated failures', async (t) => {
  const mock = await startMock();
  t.after(() => mock.server.close());
  process.env.TINYFISH_AGENT_URL = `http://127.0.0.1:${mock.port}/agent`;
  process.env.AGENT_POLL_MS = '30';
  process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'jf-edge-'));
  const { TinyFish } = require('../src/tinyfish');
  const { runAgents } = require('../src/agent');
  const { normalizePrefs } = require('../src/match');
  const store = require('../src/store');
  const tf = new TinyFish({ apiKey: 'test-key' });
  const targets = [1, 2, 3, 4].map((i) => ({ ats: 'custom', token: `failco${i}`, url: `https://failco${i}.test/jobs`, company: `Failco ${i}` }));
  const warnings = [];
  const out = await runAgents(targets, normalizePrefs({ role: 'software engineer' }), tf, () => {}, warnings, true, store);
  assert.ok(tf.stats.agent.runs >= 2 && tf.stats.agent.runs <= 3, `runs: ${tf.stats.agent.runs}`);
  assert.ok(out.agentReport.some((r) => r.status === 'skipped'));
  assert.ok(warnings.some((w) => /none succeeded/.test(w)));
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
