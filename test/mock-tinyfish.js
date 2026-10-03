'use strict';
// TEST ONLY. A fake TinyFish server that mimics the documented request and
// response shapes of Search, Fetch and Agent, so the pipeline can be tested
// without network access or credits. The app itself never loads this file.
// Fixture companies are fictional.

const http = require('http');

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

// Allowlist from docs.tinyfish.ai/key-concepts/structured-output
const SCHEMA_KEYWORDS = new Set(['anyOf', 'enum', 'format', 'items', 'maxItems', 'maximum', 'minItems', 'minimum', 'nullable', 'properties', 'propertyOrdering', 'required', 'type']);
function validateSchema(node, path = '#') {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) throw new Error(`schema node at ${path} must be an object`);
  for (const k of Object.keys(node)) {
    if (!SCHEMA_KEYWORDS.has(k)) throw new Error(`output_schema field "${k}" is not supported at ${path}`);
  }
  if (Array.isArray(node.type)) throw new Error(`type arrays are not supported at ${path}`);
  if (node.properties) for (const [k, v] of Object.entries(node.properties)) validateSchema(v, `${path}/properties/${k}`);
  if (node.items) validateSchema(node.items, `${path}/items`);
  if (node.required) for (const r of node.required) if (!node.properties || !(r in node.properties)) throw new Error(`required "${r}" missing at ${path}`);
}

function state() {
  return { extraAcmeJob: false, runDelayMs: 150, calls: { search: [], fetch: [], agentStart: [], agentPoll: 0, cancel: 0 }, runs: new Map(), umbrellaLiteRuns: 0 };
}

function greenhouseFeed(st) {
  const jobs = [
    { id: 101, title: 'Software Engineer Intern, Summer 2027', location: { name: 'New York, NY' }, first_published: ago(2), updated_at: ago(1),
      absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/101', company_name: 'Acme Robotics', departments: [{ name: 'Engineering' }], offices: [],
      content: '&lt;p&gt;Build robot fleet software in &lt;strong&gt;Python&lt;/strong&gt; and C++.&lt;/p&gt;&lt;p&gt;We sponsor visas for interns, including H-1B transfers.&lt;/p&gt;' },
    { id: 102, title: 'Senior Software Engineer', location: { name: 'New York, NY' }, first_published: ago(3), absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/102', company_name: 'Acme Robotics', content: '&lt;p&gt;Lead projects.&lt;/p&gt;' },
    { id: 103, title: 'Software Engineer Intern', location: { name: 'San Francisco, CA' }, first_published: ago(2), absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/103', company_name: 'Acme Robotics', content: '&lt;p&gt;Python.&lt;/p&gt;' },
    { id: 104, title: 'Technical Recruiter, Software Engineering Interns', location: { name: 'New York, NY' }, first_published: ago(2), absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/104', company_name: 'Acme Robotics', content: '' },
    { id: 105, title: 'Software Engineering Intern, Defense', location: { name: 'Remote - US' }, first_published: ago(2), absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/105', company_name: 'Acme Robotics', content: '&lt;p&gt;Requires an active Secret clearance.&lt;/p&gt;' },
    { id: 106, title: 'Software Engineer Intern', location: { name: 'New York, NY' }, first_published: ago(60), absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/106', company_name: 'Acme Robotics', content: '&lt;p&gt;Old posting.&lt;/p&gt;' },
  ];
  if (st.extraAcmeJob) {
    jobs.push({ id: 107, title: 'Software Engineer Intern, Perception', location: { name: 'Brooklyn, NY' }, first_published: ago(0), absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/107', company_name: 'Acme Robotics', content: '&lt;p&gt;Python, vision. Visa sponsorship is available.&lt;/p&gt;' });
  }
  // Escape underscores like a markdown converter might, to test the parser fallback.
  return JSON.stringify({ jobs, meta: { total: jobs.length } }).replace(/_/g, '\\_');
}

const leverFeed = () => '```json\n' + JSON.stringify([
  { id: 'aaa-1', text: 'Software Engineer Intern', categories: { location: 'New York, NY', commitment: 'Internship', team: 'Platform' }, createdAt: Date.now() - 5 * DAY,
    hostedUrl: 'https://jobs.lever.co/globex/aaa-1', applyUrl: 'https://jobs.lever.co/globex/aaa-1/apply', workplaceType: 'onsite',
    descriptionPlain: 'Work on our platform. We are unable to sponsor visas for this role.', lists: [], additionalPlain: '' },
  { id: 'aaa-2', text: 'Backend Software Engineer Intern', categories: { location: 'Remote', commitment: 'Internship', allLocations: ['Remote', 'New York, NY'] }, createdAt: Date.now() - 1 * DAY,
    hostedUrl: 'https://jobs.lever.co/globex/aaa-2', applyUrl: 'https://jobs.lever.co/globex/aaa-2/apply', workplaceType: 'remote',
    descriptionPlain: 'Python and Go services.', lists: [{ text: 'Benefits', content: '<li>Visa sponsorship is available.</li>' }], additionalPlain: '',
    salaryRange: { currency: 'USD', interval: 'per-hour-wage', min: 45, max: 55 } },
  { id: 'aaa-3', text: 'Product Design Intern', categories: { location: 'New York, NY' }, createdAt: Date.now() - 2 * DAY, hostedUrl: 'https://jobs.lever.co/globex/aaa-3', descriptionPlain: 'Figma.' },
]) + '\n```';

const ashbyInitech = () => JSON.stringify({ apiVersion: '1', jobs: [
  { id: 'i1', title: 'Software Engineer, New Grad', location: 'New York', publishedAt: ago(2), isListed: true, isRemote: false, jobUrl: 'https://jobs.ashbyhq.com/initech/i1', applyUrl: 'https://jobs.ashbyhq.com/initech/i1/application', descriptionPlain: 'TPS reports.' },
  { id: 'i2', title: 'Software Engineer Intern', location: 'London', publishedAt: ago(2), isListed: true, isRemote: false, jobUrl: 'https://jobs.ashbyhq.com/initech/i2', descriptionPlain: 'London office.' },
  { id: 'i3', title: 'ML Engineer Intern', location: 'New York', publishedAt: ago(6), isListed: true, isRemote: false, jobUrl: 'https://jobs.ashbyhq.com/initech/i3', descriptionPlain: 'PyTorch.' },
  { id: 'i4', title: 'Software Engineer Intern', location: 'New York', publishedAt: ago(1), isListed: false, jobUrl: 'https://jobs.ashbyhq.com/initech/i4', descriptionPlain: 'Unlisted.' },
] });

const ashbyPiedPiper = () => JSON.stringify({ apiVersion: '1', jobs: [
  { id: 'p1', title: 'Software Engineer Intern (Compression)', location: 'Remote (US)', publishedAt: ago(3), isListed: true, isRemote: true,
    jobUrl: 'https://jobs.ashbyhq.com/piedpiper/p1', applyUrl: 'https://jobs.ashbyhq.com/piedpiper/p1/application',
    descriptionPlain: 'Middle-out compression in Python. Are you authorized to work in the US without sponsorship? We support students on OPT and CPT.',
    compensation: { compensationTierSummary: '$50/hr' } },
] });

const smartHooli = () => JSON.stringify({ offset: 0, limit: 100, totalFound: 2, content: [
  { id: '7441', name: 'Software Engineer Intern', company: { identifier: 'Hooli', name: 'Hooli' }, releasedDate: ago(4),
    location: { city: 'New York', region: 'NY', country: 'us', remote: false }, experienceLevel: { id: 'internship', label: 'Internship' }, typeOfEmployment: { label: 'Intern' } },
  { id: '7442', name: 'Software Engineer', company: { identifier: 'Hooli', name: 'Hooli' }, releasedDate: ago(4),
    location: { city: 'New York', region: 'NY', country: 'us' }, experienceLevel: { label: 'Mid-Senior Level' } },
] });

const PAGES = {
  'https://jobs.smartrecruiters.com/Hooli/7441': '# Software Engineer Intern\nHooli, New York\nWork on search. Visa sponsorship is available for this role. Python a plus.',
  'https://umbrella.wd5.myworkdayjobs.com/en-US/External/job/New-York/Software-Engineer-Intern_R123': '# Software Engineer Intern\nLocations\nNew York, NY\nPosted 3 Days Ago\nWe will provide visa sponsorship for eligible candidates. Python, Java.',
  'https://umbrella.wd5.myworkdayjobs.com/en-US/External/job/Austin/Software-Engineer-Intern-Infra_R124': '# Software Engineer Intern, Infrastructure\nLocations\nAustin, TX',
  'https://careers.vandelay.com/jobs/42': '# Software Engineer Intern\nSorry, this job is no longer available.',
  'https://careers.vandelay.com/jobs/43': '# Import/Export Software Intern\nNew York. We are unable to sponsor employment visas.',
};

function fetchOne(url, st) {
  if (url.startsWith('https://boards-api.greenhouse.io/v1/boards/acme/jobs')) return { text: greenhouseFeed(st) };
  if (url.startsWith('https://api.lever.co/v0/postings/globex')) return { text: leverFeed() };
  if (url.startsWith('https://api.ashbyhq.com/posting-api/job-board/initech')) return { text: ashbyInitech() };
  if (url.startsWith('https://api.ashbyhq.com/posting-api/job-board/piedpiper')) return { text: ashbyPiedPiper() };
  if (url.startsWith('https://api.smartrecruiters.com/v1/companies/Hooli/postings')) return { text: smartHooli() };
  if (PAGES[url]) return { text: PAGES[url], title: PAGES[url].split('\n')[0].replace('# ', '') };
  return { error: 'page_not_found', status: 404 };
}

function searchResults(q) {
  const query = String(q.get('query') || '').toLowerCase();
  const r = (url, title, extra = {}) => ({ position: 0, site_name: new URL(url).hostname, title, snippet: 'Apply now.', url, ...extra });
  if (query.includes('hooli careers')) return [r('https://jobs.smartrecruiters.com/Hooli/7441-software-engineer-intern', 'Software Engineer Intern at Hooli')];
  if (query.includes('pied piper careers jobs')) return [r('https://jobs.lever.co/someoneelse/zzz', 'Engineer at Someone Else')];
  if (query.includes('pied piper careers open')) return [];
  if (query.includes('vandelay careers jobs')) return [];
  if (query.includes('vandelay careers open')) return [
    r('https://www.linkedin.com/company/vandelay/jobs', 'Vandelay jobs | LinkedIn'),
    r('https://careers.vandelay.com/jobs', 'Careers at Vandelay Industries'),
  ];
  return [
    r('https://job-boards.greenhouse.io/acme/jobs/101', 'Job Application for Software Engineer Intern, Summer 2027 at Acme Robotics'),
    r('https://jobs.lever.co/globex/aaa-2', 'Globex - Backend Software Engineer Intern'),
    r('https://jobs.ashbyhq.com/initech/i3', 'ML Engineer Intern @ Initech'),
    r('https://umbrella.wd5.myworkdayjobs.com/en-US/External/job/New-York/Software-Engineer-Intern_R123', 'Software Engineer Intern | Umbrella Careers', { date: ago(3) }),
    r('https://www.linkedin.com/jobs/view/123', 'Software Engineer Intern - LinkedIn'),
  ];
}

function agentResult(run, st) {
  if (run.url.includes('umbrella')) {
    if (run.browser_profile === 'lite') return { company: 'Umbrella', blocked: true, jobs: [] };
    return { company: 'Umbrella Corp', blocked: false, jobs: [
      { title: 'Software Engineer Intern', location: 'New York, NY', posted: 'Posted 3 Days Ago', url: '/en-US/External/job/New-York/Software-Engineer-Intern_R123', department: null },
      { title: 'Software Engineer Intern, Infrastructure', location: 'Austin, TX', posted: 'Posted Yesterday', url: '/en-US/External/job/Austin/Software-Engineer-Intern-Infra_R124' },
      { title: 'Software Engineer Intern', location: 'New York, NY', posted: null, url: 'javascript:alert(1)' },
    ] };
  }
  if (run.url.includes('vandelay')) {
    return { company: 'Vandelay Industries', blocked: false, jobs: [
      { title: 'Software Engineer Intern', location: 'Remote', posted: 'Posted Today', url: 'https://careers.vandelay.com/jobs/42' },
      { title: 'Import/Export Software Intern', location: 'New York, NY', posted: '2026-09-30', url: '/jobs/43' },
    ] };
  }
  return { blocked: false, jobs: [] };
}

function startMock(port = 0) {
  const st = state();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-api-key'] !== 'test-key') return send(401, { error: { code: 'INVALID_API_KEY', message: 'bad key' } });
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'GET' && url.pathname === '/search') {
        if (!url.searchParams.get('query')) return send(400, { error: 'missing query' });
        st.calls.search.push(Object.fromEntries(url.searchParams));
        const results = searchResults(url.searchParams).map((r, i) => ({ ...r, position: i + 1 }));
        return send(200, { query: url.searchParams.get('query'), results, total_results: results.length, page: 0 });
      }
      if (req.method === 'POST' && url.pathname === '/fetch') {
        if (!Array.isArray(body.urls) || body.urls.length > 10) return send(400, { error: 'urls must be 1 to 10' });
        st.calls.fetch.push(body);
        const results = [];
        const errors = [];
        for (const u of body.urls) {
          const r = fetchOne(u, st);
          if (r.error) errors.push({ url: u, error: r.error, status: r.status });
          else results.push({ url: u, final_url: u, title: r.title || null, description: null, language: 'en', author: null, published_date: null, text: r.text, format: body.format || 'markdown', latency_ms: 5 });
        }
        return send(200, { results, errors });
      }
      if (req.method === 'POST' && url.pathname === '/agent/v1/automation/run-async') {
        if (!body.url || !body.goal) return send(400, { error: { code: 'INVALID_INPUT' } });
        try { if (body.output_schema) validateSchema(body.output_schema); } catch (e) { return send(400, { error: { code: 'INVALID_INPUT', message: e.message } }); }
        if (body.agent_config && 'max_steps' in body.agent_config) return send(403, { error: { code: 'FORBIDDEN', message: 'max_steps is beta' } });
        // Mirror the official SDK 0.8.0 strict proxy_config schema.
        if (body.proxy_config && Object.keys(body.proxy_config).some((k) => !['enabled', 'country_code'].includes(k))) {
          return send(400, { error: { code: 'INVALID_INPUT', message: 'proxy_config only accepts enabled and country_code' } });
        }
        st.calls.agentStart.push(body);
        const id = `run_${st.runs.size + 1}`;
        st.runs.set(id, { ...body, created: Date.now() });
        return send(200, { run_id: id, error: null });
      }
      const m = url.pathname.match(/^\/agent\/v1\/runs\/([^/]+)(\/cancel)?$/);
      if (m) {
        const run = st.runs.get(m[1]);
        if (!run) return send(404, { error: 'not found' });
        if (m[2]) { st.calls.cancel++; return send(200, { run_id: m[1], status: 'CANCELLED' }); }
        st.calls.agentPoll++;
        if (Date.now() - run.created < st.runDelayMs) return send(200, { run_id: m[1], status: 'RUNNING', result: null, streaming_url: `https://live.example.test/${m[1]}` });
        return send(200, { run_id: m[1], status: 'COMPLETED', num_of_steps: 7, result: agentResult(run, st), error: null });
      }
      return send(404, { error: 'unknown route' });
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, st })));
}

module.exports = { startMock, validateSchema };
