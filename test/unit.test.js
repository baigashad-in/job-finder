'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectAts, parseJsonText, htmlToText, companyFromTitle, workdayJobsFromMarkdown, prettyName } = require('../src/ats');
const { parseAgentResult } = require('../src/agent');
const { cleanSearchTitle, buildQueries } = require('../src/discover');
const { workdayJobsFromLinks, workdayLocationFromUrl, parseJsonFromHtml } = require('../src/ats');
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

test('dedupes Workday jobs by job ID across URL forms', () => {
  assert.equal(
    canonicalUrl('https://cisco.wd5.myworkdayjobs.com/en-US/C/job/Bangalore-India/Software-Engineer_2001234'),
    canonicalUrl('https://cisco.wd5.myworkdayjobs.com/C/job/Bangalore/Software-Engineer-Java_2001234/apply'));
});

test('reads JSON from an HTML Fetch result', () => {
  const json = JSON.stringify([{ description: '<div>Say &quot;hi&quot;</div>' }]);
  const esc = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  assert.equal(parseJsonFromHtml(`<html><body><pre>${esc}</pre></body></html>`)[0].description, '<div>Say &quot;hi&quot;</div>');
  assert.deepEqual(parseJsonFromHtml('{"a":1}'), { a: 1 });
  assert.equal(parseJsonFromHtml('<html><body>Access denied</body></html>'), null);
});

test('prefs are validated and capped', () => {
  assert.throws(() => normalizePrefs({ role: '' }), /Add a role/);
  const p = normalizePrefs({ role: 'x', maxAgentRuns: 99, postedWithinDays: -5, seniority: 'wizard', locations: 'Remote' });
  assert.equal(p.maxAgentRuns, 6);
  assert.equal(p.postedWithinDays, 0);
  assert.equal(p.seniority, 'any');
  assert.equal(p.remoteOk, true);
  assert.deepEqual(p.places, []);
});
