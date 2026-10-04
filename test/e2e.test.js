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
  const links = [];
  const r1 = await runPipeline(PREFS, { tf: new TinyFish(), store, log: (k, m, x) => { logs.push(`[${k}] ${m}`); if (x && x.link) links.push(x.link); } });
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
    const wd = mock.st.calls.agentStart.find((b) => b.url.includes('umbrella'));
    assert.equal(wd.url, 'https://umbrella.wd5.myworkdayjobs.com/en-US/External?q=intern%20software%20engineer', 'Workday run starts on filtered results');
    assert.match(wd.goal, /^Goal: read the job search results already shown/);
    const stealth = mock.st.calls.agentStart.find((b) => b.browser_profile === 'stealth');
    assert.deepEqual(stealth.proxy_config, { enabled: true, country_code: 'US' });
  });

  await t.test('reports a live browser link for each Agent run', () => {
    assert.equal(links.length, 3, 'two first runs plus the stealth retry');
    assert.ok(links.every((u) => u.startsWith('https://live.example.test/run_')));
  });

  await t.test('returns exactly the expected matches', () => {
    const expected = [
      'Acme Robotics | Software Engineer Intern, Summer 2027',
      'Globex | Backend Software Engineer Intern',
      'Hooli | Software Engineer Intern',
      'Pied Piper | Software Engineer Intern (Compression)',
      'Umbrella | Software Engineer Intern',
    ];
    assert.deepEqual([...titles].sort(), expected);
  });

  await t.test('a feed that breaks as markdown is read again as HTML', () => {
    const row = r1.boards.find((b) => b.ats === 'lever' && /globex/i.test(b.url));
    assert.equal(row.via, 'feed (html)');
    assert.equal(row.jobs, 3);
    assert.ok(r1.listings.some((l) => l.title === 'Backend Software Engineer Intern'));
  });

  await t.test('filters with the right reasons', () => {
    assert.equal(r1.filteredOut.level, 3, 'senior acme, new grad initech, hooli mid');
    assert.equal(r1.filteredOut.role, 3, 'recruiter, designer, and ML engineer (shares only "engineer")');
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
    assert.equal(r1.listings.length, 5);
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

  process.env.AGENT_RUNS_LIMIT = '1';
  const r6 = await runPipeline(PREFS, { tf: new TinyFish(), store, force: true });
  delete process.env.AGENT_RUNS_LIMIT;
  await t.test('AGENT_RUNS_LIMIT caps Agent runs whatever the user asks for', () => {
    assert.equal(r6.agentSites.length, 1);
    assert.ok(r6.warnings.some((w) => /at most 1 Agent run per search/.test(w)));
  });

  mock.st.workdayPage = true;
  const r7 = await runPipeline(PREFS, { tf: new TinyFish(), store, force: true });
  mock.st.workdayPage = false;
  await t.test('Workday is read by Fetch first, so the Agent only runs where Fetch failed', () => {
    assert.equal(r7.usage.agent.runs, 1, 'only Vandelay (custom site) needs the Agent');
    const um = r7.listings.find((l) => l.company === 'Umbrella');
    assert.ok(um.sources.includes('fetch:workday'));
    const row = r7.boards.find((b) => b.ats === 'workday');
    assert.equal(row.jobs, 2, 'same 2 jobs on both query pages, counted once');
    assert.equal(row.via, 'search page');
    assert.ok(!r7.listings.some((l) => /Infrastructure/.test(l.title)), 'Austin job filtered by location');
  });

  mock.st.workdayLinksOnly = true;
  const r8 = await runPipeline(PREFS, { tf: new TinyFish(), store, force: true });
  mock.st.workdayLinksOnly = false;
  await t.test('Workday jobs come from Fetch links list when the page text has no links', () => {
    assert.equal(r8.usage.agent.runs, 1, 'only Vandelay needs the Agent');
    const um = r8.listings.find((l) => l.company === 'Umbrella');
    assert.equal(um.title, 'Software Engineer Intern (C++)', 'real title from the page text, not the slug');
    assert.ok(um.postedAt, 'posted date read from the line under the title');
    assert.equal(r8.listings.filter((l) => l.company === 'Umbrella').length, 1, 'same job ID from Search and Fetch merged');
    assert.ok(um.sources.includes('fetch:workday'));
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
