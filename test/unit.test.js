'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectAts, parseJsonText, htmlToText, companyFromTitle, workdayJobsFromMarkdown, prettyName } = require('../src/ats');
const { parseAgentResult } = require('../src/agent');
const { cleanSearchTitle, buildQueries } = require('../src/discover');
const { workdayJobsFromLinks, workdayLocationFromUrl, parseJsonFromHtml, workdayBlocksFromText } = require('../src/ats');
const { detectLevel, detectVisa, scoreLocation, normalizePrefs, dedupe, canonicalUrl, evaluate } = require('../src/match');
const { parsePostedText } = require('../src/util');
const { OUTPUT_SCHEMA } = require('../src/agent');
const { validateSchema } = require('./mock-tinyfish');

test('detects ATS boards and feed URLs', () => {
  const gh = detectAts('https://job-boards.greenhouse.io/acme/jobs/123?gh_src=x');
  assert.equal(gh.ats, 'greenhouse');
  assert.equal(gh.token, 'acme');
  assert.equal(gh.jobId, '123');
  assert.equal(gh.feedUrl, 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
  assert.equal(detectAts('https://boards.greenhouse.io/embed/job_board?for=acme').token, 'acme');
  assert.equal(detectAts('https://jobs.lever.co/globex/abc').feedUrl, 'https://api.lever.co/v0/postings/globex?mode=json');
  assert.equal(detectAts('https://jobs.eu.lever.co/globex/abc').feedUrl, 'https://api.eu.lever.co/v0/postings/globex?mode=json');
  assert.equal(detectAts('https://jobs.ashbyhq.com/initech/i1').ats, 'ashby');
  const wd = detectAts('https://umbrella.wd5.myworkdayjobs.com/en-US/External/job/New-York/SWE_R1');
  assert.equal(wd.kind, 'agent');
  assert.equal(wd.boardUrl, 'https://umbrella.wd5.myworkdayjobs.com/en-US/External');
  assert.equal(detectAts('https://www.linkedin.com/jobs/view/1'), null);
  assert.equal(detectAts('javascript:alert(1)'), null);
});

test('parses JSON that Fetch may wrap or escape', () => {
  assert.deepEqual(parseJsonText('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonText('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(parseJsonText('{"first\\_published":"x"}'), { first_published: 'x' });
  assert.deepEqual(parseJsonText('Here you go: {"a":"b\\nc"} done'), { a: 'b\nc' });
  assert.equal(parseJsonText('<html>nope</html>'), null);
});

test('cleans escaped Greenhouse HTML', () => {
  assert.equal(htmlToText('&lt;p&gt;Hello &amp;amp; &lt;b&gt;bye&lt;/b&gt;&lt;/p&gt;'), 'Hello & bye');
  assert.equal(companyFromTitle('Job Application for Software Engineer at Acme Robotics'), 'Acme Robotics');
});

test('detects seniority from titles', () => {
  assert.equal(detectLevel('Software Engineer Intern, Summer 2027'), 'intern');
  assert.equal(detectLevel('Software Engineer (Summer 2027)'), 'intern');
  assert.equal(detectLevel('Internal Tools Engineer'), 'unspecified');
  assert.equal(detectLevel('Software Engineer, New Grad'), 'entry');
  assert.equal(detectLevel('Software Engineer I'), 'entry');
  assert.equal(detectLevel('Software Engineer II'), 'mid');
  assert.equal(detectLevel('Senior Software Engineer'), 'senior');
  assert.equal(detectLevel('Staff Engineer'), 'staff');
  assert.equal(detectLevel('Engineering Manager, Payments'), 'manager');
  assert.equal(detectLevel('Intermediate Backend Engineer - Database Change Management'), 'mid');
  assert.equal(detectLevel('Software Engineer, Password Manager (PWM) - India'), 'unspecified');
  assert.equal(detectLevel('Manager II, Software Engineering'), 'manager');
  assert.equal(detectLevel('Senior Manager Software Engineering'), 'manager');
  assert.equal(detectLevel('Associate Product Manager', null, 'product manager'), 'entry');
  assert.equal(detectLevel('Product Manager', null, 'product manager'), 'unspecified');
});

test('detects visa policy and ignores application questions', () => {
  assert.equal(detectVisa('We are unable to sponsor visas for this role.').status, 'no');
  assert.equal(detectVisa('Candidates must be authorized to work without the need for current or future visa sponsorship.').status, 'no');
  assert.equal(detectVisa('We are unable to sponsor at this time.').status, 'no');
  assert.equal(detectVisa('Requires an active Secret clearance.').status, 'no');
  assert.equal(detectVisa('Visa sponsorship is available.').status, 'yes');
  assert.equal(detectVisa('We will provide visa sponsorship for eligible candidates.').status, 'yes');
  assert.equal(detectVisa('Are you authorized to work in the US without sponsorship? We support OPT.').status, 'opt');
  assert.equal(detectVisa('Will you now or in the future require sponsorship?').status, 'unknown');
  assert.equal(detectVisa('We do not discriminate based on immigration status.').status, 'unknown');
  assert.match(detectVisa('Great team. We are unable to sponsor visas. Apply now.').evidence, /unable to sponsor/);
});

test('matches locations, aliases, countries and remote', () => {
  const p = normalizePrefs({ role: 'swe', locations: 'NYC; Remote', country: 'US' });
  assert.equal(scoreLocation({ location: 'New York, NY' }, p).score, 20);
  assert.equal(scoreLocation({ location: 'Remote' }, p).score, 18);
  assert.match(scoreLocation({ location: 'Remote - Canada' }, p).reason, /limited to CA/);
  assert.ok(scoreLocation({ location: 'Austin, TX' }, p).drop);
  const us = normalizePrefs({ role: 'swe', locations: 'United States' });
  assert.ok(scoreLocation({ location: 'Austin, TX' }, us).score > 0);
  assert.ok(scoreLocation({ location: 'Toronto, ON' }, us).drop);
  const city = normalizePrefs({ role: 'swe', locations: 'New York, NY' });
  assert.equal(scoreLocation({ location: 'Brooklyn' }, city).score, 20);
});

test('role matching drops recruiters and unrelated titles', () => {
  const p = normalizePrefs({ role: 'software engineer', seniority: 'intern' });
  const base = { company: 'X', location: null, description: '', postedAt: null };
  assert.equal(evaluate({ ...base, title: 'Software Engineer Intern' }, p).dropped, null);
  assert.equal(evaluate({ ...base, title: 'Backend Engineer Intern' }, p).dropped, null);
  assert.match(evaluate({ ...base, title: 'Technical Recruiter, Software Engineering Interns' }, p).dropped, /^role/);
  assert.match(evaluate({ ...base, title: 'Product Design Intern' }, p).dropped, /^role/);
  assert.match(evaluate({ ...base, title: 'Senior Software Engineer' }, p).dropped, /^level/);
  const any = normalizePrefs({ role: 'software engineer' });
  for (const t of ['Engineering Manager', 'Senior Support Engineer', 'Prompt Engineer', 'Staff Engineer - Databricks']) {
    assert.match(evaluate({ ...base, title: t }, any).dropped, /^role/, t);
  }
  assert.equal(evaluate({ ...base, title: 'Software Development Engineer in Test' }, any).dropped, null);
  assert.equal(evaluate({ ...base, title: 'Engineering Manager' }, normalizePrefs({ role: 'engineering manager' })).dropped, null);
});

test('Agent results are only "blocked" when they say so', () => {
  assert.equal(parseAgentResult({ status: 'COMPLETED', result: { blocked: false, jobs: [] } }).blocked, false);
  assert.equal(parseAgentResult({ status: 'COMPLETED', result: { blocked: true, jobs: [] } }).blocked, true);
  assert.equal(parseAgentResult({ status: 'COMPLETED', result: 'Stopped: captcha on page' }).blocked, true);
  assert.equal(parseAgentResult({ status: 'FAILED', result: null, error: { code: 'SITE_BLOCKED' } }).blocked, true);
});

test('reads Workday search results pages', () => {
  const md = '3 JOBS FOUND\n[**Software Engineer**](/en-US/Site/job/Bangalore-India/SWE_R1)\n2 Locations\nPosted 3 Days Ago\n' +
    '[SWE](/en-US/Site/job/Bangalore-India/SWE_R1)\n[Senior SWE](https://acme.wd5.myworkdayjobs.com/en-US/Site/job/Remote-USA/Senior_R2)\n' +
    '[Privacy](https://www.acme.com/privacy)\n[Search](/en-US/Site?q=x)';
  const jobs = workdayJobsFromMarkdown(md, { boardUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/Site', token: 'acme', company: 'Acme' });
  assert.equal(jobs.length, 2, 'duplicates and non-job links skipped');
  assert.equal(jobs[0].title, 'Software Engineer');
  assert.equal(jobs[0].location, 'Bangalore India (+1 more)');
  assert.ok(jobs[0].postedAt);
  assert.equal(jobs[1].remote, true);
  assert.equal(jobs[0].url, 'https://acme.wd5.myworkdayjobs.com/en-US/Site/job/Bangalore-India/SWE_R1');
});

test('cleans search titles and company codes', () => {
  assert.equal(cleanSearchTitle('Software Engineer-Salesforce - PTC Careers'), 'Software Engineer-Salesforce');
  assert.equal(cleanSearchTitle('Principal Software Engineer - Logo - Myworkdayjobs.com'), 'Principal Software Engineer - Logo');
  assert.equal(cleanSearchTitle('Software Engineer - Careers Platform'), 'Software Engineer - Careers Platform');
  assert.equal(prettyName('cba'), 'CBA');
  assert.equal(prettyName('scale-ai'), 'Scale Ai');
});

test('dedupes by URL and by company + title + location', () => {
  const a = { title: 'SWE Intern', company: 'Acme', location: 'NYC', url: 'https://jobs.lever.co/acme/1', sources: ['fetch:lever'], description: 'long '.repeat(60) };
  const b = { title: 'SWE Intern', company: 'Acme', location: 'NYC', url: 'https://jobs.lever.co/acme/1/apply?src=x', sources: ['search'] };
  const c = { title: 'SWE  intern', company: 'ACME', location: 'NYC', url: 'https://acme.com/careers/1', sources: ['agent:custom'] };
  const d = { title: 'SWE Intern', company: 'Acme', location: 'Boston', url: 'https://jobs.lever.co/acme/2', sources: ['fetch:lever'] };
  const { listings, removed } = dedupe([a, b, c, d]);
  assert.equal(listings.length, 2);
  assert.equal(removed, 2);
  assert.deepEqual(listings[0].sources.sort(), ['agent:custom', 'fetch:lever', 'search']);
  assert.ok(listings[0].description.length > 200, 'keeps the richest copy');
  assert.equal(canonicalUrl('https://acme.com/careers?gh_jid=55&utm=1'), 'acme.com/careers?gh_jid=55');
});

test('parses posted date text', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  assert.equal(parsePostedText('Posted 3 Days Ago', now).slice(0, 10), '2026-09-30');
  assert.equal(parsePostedText('Posted Yesterday', now).slice(0, 10), '2026-10-02');
  assert.equal(parsePostedText('Posted 30+ Days Ago', now).slice(0, 10), '2026-09-03');
  assert.equal(parsePostedText('2026-09-28', now).slice(0, 10), '2026-09-28');
  assert.equal(parsePostedText('whenever', now), null);
});

test('Agent output schema only uses keywords TinyFish accepts', () => {
  assert.doesNotThrow(() => validateSchema(OUTPUT_SCHEMA));
});

test('search country follows the typed city', () => {
  assert.equal(normalizePrefs({ role: 'x', locations: 'Bangalore', country: 'US' }).country, 'IN');
  assert.equal(normalizePrefs({ role: 'x', locations: 'Bangalore', country: 'US' }).countryFrom, 'Bangalore');
  assert.equal(normalizePrefs({ role: 'x', locations: 'London; Remote' }).country, 'GB');
  assert.equal(normalizePrefs({ role: 'x', locations: 'New York', country: 'US' }).countryFrom, null);
  assert.equal(normalizePrefs({ role: 'x', locations: 'Kochi', country: 'IN' }).country, 'IN', 'unknown city keeps the dropdown');
});

test('Search asks each job system separately', () => {
  const qs = buildQueries(normalizePrefs({ role: 'software engineer', locations: 'Bangalore' }));
  const single = qs.filter((q) => q.domains.length <= 2).map((q) => q.label);
  assert.deepEqual(single, ['Greenhouse', 'Lever', 'Ashby', 'Workday', 'SmartRecruiters and Workable']);
  assert.ok(qs.length <= 8);
});

test('builds Workday jobs from a plain links list', () => {
  const jobs = workdayJobsFromLinks([
    'https://acme.wd5.myworkdayjobs.com/en-US/Site/job/Bangalore-India/Software-Engineer--Java-_2001234',
    '/en-US/Site/job/Remote-USA/Senior-SWE_R2',
    'https://www.acme.com/privacy',
  ], { boardUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/Site', company: 'Acme' });
  assert.deepEqual(jobs.map((j) => j.title), ['Software Engineer Java', 'Senior SWE']);
  assert.equal(jobs[0].location, 'Bangalore India');
});

test('recovers real Workday titles and dates from page text', () => {
  const text = 'Jobs\nSoftware Engineer (Embedded C++) 4-10 years\nPosted 5 Days Ago\nLead Software Engineer\nPosted Yesterday\nLead Software Engineer\nPosted 30+ Days Ago';
  const jobs = workdayJobsFromLinks([
    'https://cisco.wd5.myworkdayjobs.com/C/job/Bangalore-India/Software-Engineer--Embedded-C--4-10-years_2001',
    'https://cisco.wd5.myworkdayjobs.com/C/job/Bangalore-India/Lead-Software-Engineer_R1',
    'https://cisco.wd5.myworkdayjobs.com/C/job/Bangalore-India/Lead-Software-Engineer_R2',
  ], { boardUrl: 'https://cisco.wd5.myworkdayjobs.com/C', company: 'Cisco' }, text);
  assert.equal(jobs[0].title, 'Software Engineer (Embedded C++) 4-10 years');
  assert.ok(jobs[0].postedAt);
  assert.notEqual(jobs[1].postedAt, jobs[2].postedAt, 'same title, each gets its own date');
  assert.equal(workdayLocationFromUrl('https://visa.wd5.myworkdayjobs.com/en-US/V/job/IN-Bengaluru-India/X_R1'), 'IN Bengaluru India');
});

test('matches Workday links to page text by job ID (format from a live page)', () => {
  const text = [
    '18 JOBS FOUND',
    '* **locations**:   Bangalore, India', '', '  **time type**:   Full time', '', '  **posted on**:   Posted 2 Days Ago', '', '  + 2025101',
    '* ### Capital Program Manager', '', '  **locations**:   Bangalore, India', '', '  **posted on**:   Posted 5 Days Ago', '', '  + 2023058',
    '* **locations**:   2 Locations', '', '  **posted on**:   Posted 30+ Days Ago', '', '  + 2021478',
  ].join('\n');
  assert.equal(workdayBlocksFromText(text).size, 3);
  const base = 'https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers/job/Bangalore-India/';
  const jobs = workdayJobsFromLinks([
    `${base}Software-Engineer--Embedded-C--forwarding-protocols--4-10-years--Bangalore-_2025101-1?q=x`,
    `${base}Capital-Program-Manager_2023058-1?q=x`,
    `${base}Software-Engineer-II_2021478?q=x`,
  ], { boardUrl: 'https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers', company: 'Cisco' }, text);
  assert.equal(jobs[0].location, 'Bangalore, India');
  assert.ok(jobs[0].postedAt, 'date found through ID 2025101 despite the -1 suffix');
  assert.equal(jobs[0].titleFromUrl, true, 'no title on the page, so enrichment may replace it');
  assert.equal(jobs[1].title, 'Capital Program Manager');
  assert.equal(jobs[1].titleFromUrl, false);
  assert.equal(jobs[2].location, 'Bangalore India (+1 more)', '"2 Locations" keeps the URL city');
});

test('takes real titles from posting pages, never generic ones', () => {
  const { realTitle } = require('../src/read');
  const slug = 'Software Engineer Embedded C forwarding protocols 4 10 years Bangalore';
  const real = 'Software Engineer (Embedded C++, forwarding protocols) - 4-10 years - Bangalore';
  assert.equal(realTitle({ title: real }, '', slug), real);
  assert.equal(realTitle({ title: 'Careers' }, `Skip\n## ${real}\nApply`, slug), real);
  assert.equal(realTitle({ title: 'Careers' }, '## Capital Program Manager', slug), null);
  // Live Cisco page: Fetch's title field still held an HTML entity.
  assert.equal(
    realTitle({ title: 'Sr Software Engineer--Routing Platform &amp; Infrastructure' }, '', 'Sr Software Engineer Routing Platform Infrastructure'),
    'Sr Software Engineer--Routing Platform & Infrastructure');
});

test('reads the work style from Workday posting pages', () => {
  const { workdayRemoteType } = require('../src/read');
  const page = '## Sr Software Engineer\n\nApply\n\n**remote type**:   Hybrid\n\n**locations**:   Milpitas, California, US';
  assert.equal(workdayRemoteType(page), 'Hybrid');
  assert.equal(workdayRemoteType('no such field'), null);
});

test('dedupes Workday jobs by job ID across URL forms', () => {
  assert.equal(
    canonicalUrl('https://cisco.wd5.myworkdayjobs.com/en-US/C/job/B/X_2025101-1?q=a'),
    canonicalUrl('https://cisco.wd5.myworkdayjobs.com/C/job/B/Y_2025101'));
  assert.equal(
    canonicalUrl('https://cisco.wd5.myworkdayjobs.com/en-US/C/job/Bangalore-India/Software-Engineer_2001234'),
    canonicalUrl('https://cisco.wd5.myworkdayjobs.com/C/job/Bangalore/Software-Engineer-Java_2001234/apply'));
  assert.equal(
    canonicalUrl('https://cba.wd3.myworkdayjobs.com/en-US/Private/details/Staff-Software-Engineer--Logo_REQ1'),
    canonicalUrl('https://cba.wd3.myworkdayjobs.com/Private/job/Bangalore/Staff-Software-Engineer_REQ1'));
});

test('reads JSON from an HTML Fetch result', () => {
  const json = JSON.stringify([{ description: '<div>Say &quot;hi&quot;</div>' }]);
  const esc = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  assert.equal(parseJsonFromHtml(`<html><body><pre>${esc}</pre></body></html>`)[0].description, '<div>Say &quot;hi&quot;</div>');
  assert.deepEqual(parseJsonFromHtml('{"a":1}'), { a: 1 });
  assert.equal(parseJsonFromHtml('<html><body>Access denied</body></html>'), null);
});

test('jobs seen live are not removed because their page cannot be read', async () => {
  const { enrich } = require('../src/read');
  // A live run removed every Agent-found Ashby job after reading its page failed.
  const pages = {
    'https://jobs.ashbyhq.com/acme/a1': { error: 'page_not_found' },
    'https://jobs.ashbyhq.com/acme/a2': { text: 'Sorry, this job is no longer available.' },
    'https://jobs.ashbyhq.com/acme/a3': { text: 'Job not found' },
    'https://example.com/jobs/s1': { error: 'page_not_found' },
    'https://example.com/jobs/s2': { text: 'The page you are looking for does not exist.' },
  };
  const tf = { fetchUrls: async (urls) => ({
    results: urls.filter((u) => pages[u].text).map((u) => ({ url: u, text: pages[u].text, title: null })),
    errors: urls.filter((u) => pages[u].error).map((u) => ({ url: u, error: pages[u].error })),
  }) };
  const mk = (url, sources) => ({ title: 'SWE Intern', company: 'Acme', url, sources, description: '' });
  const ls = [
    mk('https://jobs.ashbyhq.com/acme/a1', ['agent:ashby']),
    mk('https://jobs.ashbyhq.com/acme/a2', ['agent:ashby']),
    mk('https://jobs.ashbyhq.com/acme/a3', ['agent:ashby']),
    mk('https://example.com/jobs/s1', ['search']),
    mk('https://example.com/jobs/s2', ['search']),
  ];
  const out = await enrich(ls, normalizePrefs({ role: 'software engineer' }), tf, () => {}, 10, false);
  assert.deepEqual(ls.map((l) => !!l.closed), [false, true, false, true, true]);
  assert.equal(out.closed, 3);
  assert.equal(out.closedList[0].url, 'https://jobs.ashbyhq.com/acme/a2');
  assert.match(out.closedList[0].why, /closed/);
});

test('cleans board-style company names', () => {
  assert.equal(prettyName('shopback-2'), 'Shopback');
  assert.equal(prettyName('g2'), 'G2');
  const { PARSERS } = require('../src/ats');
  const jobs = PARSERS.greenhouse({ jobs: [{ title: 'SWE', absolute_url: 'https://x.y/1', company_name: 'Rubrik Job Board', location: { name: 'X' } }] }, { token: 'rubrik' });
  assert.equal(jobs[0].company, 'Rubrik');
});

test('corrects typos in the role only against real title words', () => {
  const { correctRole } = require('../src/match');
  const titles = ['Software Engineer', 'Senior Software Engineer', 'Software Engineer II', 'Staff Software Engineer', 'Backend Engineer',
    'Frontend Developer', 'React Developer', 'Data Scientist', 'Product Manager', 'Engineering Manager', 'Data Analyst', 'Security Engineer'];
  // Typo from a live run.
  assert.equal(correctRole('sofatware engineer', titles).role, 'software engineer');
  assert.deepEqual(correctRole('softwre enginer', titles).changes, [['softwre', 'software'], ['enginer', 'engineer']]);
  assert.equal(correctRole('software engineer', titles), null, 'nothing to fix');
  assert.equal(correctRole('bioinformatics scientist', titles), null, 'no close title word');
  assert.equal(correctRole('sofatware engineer', ['Software Engineer']), null, 'too few titles to judge');
});

test('prefs are validated and capped', () => {
  assert.throws(() => normalizePrefs({ role: '' }), /Add a role/);
  const p = normalizePrefs({ role: 'x', maxAgentRuns: 99, postedWithinDays: -5, seniority: 'wizard', locations: 'Remote' });
  assert.equal(p.maxAgentRuns, 20);
  assert.equal(p.postedWithinDays, 0);
  assert.equal(p.seniority, 'any');
  assert.equal(p.remoteOk, true);
  assert.deepEqual(p.places, []);
});
