'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock } = require('./mock-tinyfish');

const PREFS = {
  role: 'software engineer', seniority: 'intern', locations: 'New York; Remote', country: 'US',
  visa: 'need', keywords: 'python', exclude: 'clearance', companies: 'Hooli\nPied Piper\nVandelay',
  postedWithinDays: 30, maxAgentRuns: 2,
};

test('full pipeline against mock TinyFish', async (t) => {
  const mock = await startMock();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-'));
  process.env.TINYFISH_API_KEY = 'test-key';
  process.env.TINYFISH_SEARCH_URL = `http://127.0.0.1:${mock.port}/search`;
  process.env.TINYFISH_FETCH_URL = `http://127.0.0.1:${mock.port}/fetch`;
  process.env.TINYFISH_AGENT_URL = `http://127.0.0.1:${mock.port}/agent`;
  process.env.DATA_DIR = dataDir;
  process.env.AGENT_POLL_MS = '60';
  const { TinyFish } = require('../src/tinyfish');
  const { runPipeline } = require('../src/pipeline');
  const store = require('../src/store');
  t.after(() => mock.server.close());

  const logs = [];
  const r1 = await runPipeline(PREFS, { tf: new TinyFish(), store, log: (k, m) => logs.push(`[${k}] ${m}`) });
  const titles = r1.listings.map((l) => `${l.company} | ${l.title}`);
  console.log(logs.join('\n'));
  console.log(titles.map((x, i) => `${r1.listings[i].score} ${x} ${r1.listings[i].visa.status}`).join('\n'));
  console.log('filteredOut', r1.filteredOut, 'usage', JSON.stringify(r1.usage), 'warnings', r1.warnings);

  await t.test('uses all three TinyFish APIs', () => {
    assert.ok(r1.usage.search.calls >= 4, 'search used');
    assert.ok(r1.usage.fetch.calls >= 3, 'fetch used');
    assert.equal(r1.usage.agent.runs, 3, 'umbrella lite + stealth retry, vandelay');
    for (const f of mock.st.calls.fetch) assert.ok(f.urls.length <= 10);
    for (const s of mock.st.calls.search) assert.ok(s.include_domains || s.exclude_domains, 'search is scoped');
  });

  await t.test('stealth retry happened only for the blocked site', () => {
    const profiles = mock.st.calls.agentStart.map((b) => `${new URL(b.url).hostname}:${b.browser_profile}`);
    assert.deepEqual(profiles.sort(), ['careers.vandelay.com:lite', 'umbrella.wd5.myworkdayjobs.com:lite', 'umbrella.wd5.myworkdayjobs.com:stealth']);
    const stealth = mock.st.calls.agentStart.find((b) => b.browser_profile === 'stealth');
    assert.deepEqual(stealth.proxy_config, { enabled: true, type: 'tetra', country_code: 'US' });
  });

  await t.test('returns exactly the expected matches', () => {
    const expected = [
      'Acme Robotics | Software Engineer Intern, Summer 2027',
      'Globex | Backend Software Engineer Intern',
      'Hooli | Software Engineer Intern',
      'Initech | ML Engineer Intern',
      'Pied Piper | Software Engineer Intern (Compression)',
      'Umbrella | Software Engineer Intern',
    ];
    assert.deepEqual([...titles].sort(), expected);
  });

  await t.test('filters with the right reasons', () => {
    assert.equal(r1.filteredOut.level, 3, 'senior acme, new grad initech, hooli mid');
    assert.ok(r1.filteredOut.role >= 2, 'recruiter and designer');
    assert.ok(r1.filteredOut.location >= 3, 'SF, London, Austin');
    assert.equal(r1.filteredOut.visa, 3, 'globex no-sponsor, acme clearance, vandelay 43');
    assert.equal(r1.filteredOut.fresh, 1, '60 day old posting');
    assert.equal(r1.filteredOut['closed or removed'], 1, 'vandelay 42 closed');
  });

  await t.test('dedupes the Workday posting found by Search and by Agent', () => {
    const um = r1.listings.filter((l) => l.company === 'Umbrella');
    assert.equal(um.length, 1);
    assert.deepEqual([...um[0].sources].sort(), ['agent:workday', 'fetch:page', 'search']);
    assert.equal(um[0].visa.status, 'yes');
    assert.equal(um[0].location, 'New York, NY');
  });

  await t.test('visa results carry evidence and ignore form questions', () => {
    const pp = r1.listings.find((l) => l.company === 'Pied Piper');
    assert.equal(pp.visa.status, 'opt');
    const hooli = r1.listings.find((l) => l.company === 'Hooli');
    assert.equal(hooli.visa.status, 'yes', 'filled in by Fetch enrichment');
    assert.match(hooli.visa.evidence, /sponsorship is available/);
  });

  await t.test('ranking puts strong matches first and links are http(s)', () => {
    assert.ok(r1.listings[0].score >= r1.listings[r1.listings.length - 1].score);
    assert.equal(r1.listings[r1.listings.length - 1].company, 'Initech');
    for (const l of r1.listings) assert.match(l.applyUrl, /^https:\/\//);
    assert.ok(!r1.listings.some((l) => /javascript/.test(l.applyUrl)));
    assert.equal(r1.firstRun, true);
  });

  const r2 = await runPipeline(PREFS, { tf: new TinyFish(), store });
  await t.test('second run uses the Agent cache and marks nothing new', () => {
    assert.equal(r2.usage.agent.runs, 0);
    assert.equal(r2.usage.agent.cached, 2);
    assert.equal(r2.firstRun, false);
    assert.equal(r2.counts.newSinceLastRun, 0);
    assert.equal(r2.listings.length, r1.listings.length);
  });

  mock.st.extraAcmeJob = true;
  const r3 = await runPipeline(PREFS, { tf: new TinyFish(), store, force: true });
  await t.test('a newly posted job is flagged as new', () => {
    const fresh = r3.listings.filter((l) => l.isNew);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].title, 'Software Engineer Intern, Perception');
    assert.equal(r3.usage.agent.runs, 3, 'force skips the Agent cache');
    const forcedFetch = mock.st.calls.fetch.slice(-6).some((f) => f.ttl === 0);
    assert.ok(forcedFetch, 'force sends ttl 0 to Fetch');
  });

  const r4 = await runPipeline({ ...PREFS, maxAgentRuns: 0, companies: '' }, { tf: new TinyFish(), store });
  await t.test('Agent cap of 0 runs free only and says what it skipped', () => {
    assert.equal(r4.usage.agent.runs, 0);
    assert.ok(r4.warnings.some((w) => /Skipped 1 careers site because/.test(w)));
    assert.ok(r4.listings.some((l) => l.company === 'Umbrella'), 'Search hit on Workday still read with Fetch');
  });

  const r5 = await runPipeline({ ...PREFS, role: 'data analyst', seniority: 'any', visa: 'any', locations: '', companies: '', maxAgentRuns: 0 }, { tf: new TinyFish(), store });
  await t.test('different role returns nothing from these engineering boards', () => {
    assert.equal(r5.listings.length, 0);
    assert.ok(r5.filteredOut.role > 5);
  });
});

test('HTTP API runs a search and serves results', async (t) => {
  const mock = await startMock();
  process.env.TINYFISH_SEARCH_URL = `http://127.0.0.1:${mock.port}/search`;
  process.env.TINYFISH_FETCH_URL = `http://127.0.0.1:${mock.port}/fetch`;
  process.env.TINYFISH_AGENT_URL = `http://127.0.0.1:${mock.port}/agent`;
  const { server } = require('../server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); mock.server.close(); });

  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Find jobs/);
  assert.doesNotMatch(html, /\u2014/, 'no em dashes in the UI');

  const bad = await fetch(`${base}/api/search`, { method: 'POST', body: JSON.stringify({ prefs: { role: '' } }) });
  assert.equal(bad.status, 400);

  const { taskId } = await (await fetch(`${base}/api/search`, { method: 'POST', body: JSON.stringify({ prefs: { ...PREFS, maxAgentRuns: 0 } }) })).json();
  let task;
  for (let i = 0; i < 100; i++) {
    task = await (await fetch(`${base}/api/task/${taskId}`)).json();
    if (task.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(task.status, 'done', task.error);
  assert.ok(task.result.listings.length >= 4);
  const csv = await (await fetch(`${base}/api/task/${taskId}/csv`)).text();
  assert.match(csv.split('\n')[0], /^score,title,company/);

  const save = await fetch(`${base}/api/searches`, { method: 'POST', body: JSON.stringify({ name: 'NYC intern', prefs: PREFS }) });
  assert.equal(save.status, 201);
  const list = await (await fetch(`${base}/api/searches`)).json();
  assert.equal(list.length, 1);
  const latest = await fetch(`${base}/api/searches/${list[0].id}/latest`);
  assert.equal(latest.status, 200, 'latest result exists because the same prefs already ran');
});
