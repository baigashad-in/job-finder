'use strict';
// Step 3: BROWSE with TinyFish Agent (uses credits, so it is capped and cached).
// Used only for careers sites with no public GET feed: Workday, Workable and
// custom careers pages. These sites need typing into a search box, applying
// filters and paging, which a static fetch cannot do.

const { parseJsonText, safeUrl, prettyName } = require('./ats');
const { pool, parsePostedText, plural } = require('./util');

const PROXY_COUNTRIES = new Set(['US', 'GB', 'CA', 'DE', 'FR', 'JP', 'AU']);
const MAX_JOBS = 25;
const CACHE_HOURS = Number(process.env.AGENT_CACHE_HOURS || 12);
const MAX_WAIT_MS = Number(process.env.AGENT_MAX_WAIT_SECONDS || 200) * 1000;
const STEALTH_RETRY = process.env.AGENT_STEALTH_RETRY !== '0';
const LEVEL_WORDS = { intern: 'intern', entry: 'new grad', senior: 'senior', staff: 'staff', manager: 'manager' };

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    company: { type: 'string', nullable: true },
    blocked: { type: 'boolean' },
    jobs: {
      type: 'array',
      maxItems: MAX_JOBS,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          location: { type: 'string', nullable: true },
          posted: { type: 'string', nullable: true },
          url: { type: 'string' },
          department: { type: 'string', nullable: true },
        },
        required: ['title', 'url'],
      },
    },
  },
  required: ['blocked', 'jobs'],
};

function buildGoal(p) {
  const lvl = LEVEL_WORDS[p.seniority] || '';
  const searchText = [lvl, p.role].filter(Boolean).join(' ');
  const place = p.places[0] || '';
  return [
    'Goal: list open job postings on this careers site that match the search below. Work quickly.',
    `Search: role "${p.role}"${lvl ? `, level "${lvl}"` : ''}${place ? `, location "${place}"` : ''}${p.remoteOk ? ', remote is fine' : ''}.`,
    'Steps:',
    '1. Close any cookie or privacy banner.',
    `2. If the page has a job search box, search for "${searchText}".`,
    place
      ? `3. If there is a simple location box or dropdown, set it to "${place}". If that takes more than two clicks, skip it.`
      : '3. Do not use location filters.',
    `4. Read only the first page of results. Collect up to ${MAX_JOBS} postings whose title fits the role. Take title, location, posted date and link from the list itself. Do not open postings.`,
    'Return: the company name, and for each posting its title, location as shown (or null), posted date text as shown (or null), department if shown (or null), and url, the full absolute link to the posting.',
    'Rules: copy text exactly as shown. Do not invent postings or links. If nothing matches, return an empty jobs list. If you hit a captcha, a login wall or an access denied page, stop and set blocked to true.',
  ].join('\n');
}

// Workday runs start on the results page already filtered by ?q=role, so the Agent
// only has to read the list. Typing and filters were what made runs hit the time limit.
function buildWorkdayGoal() {
  return [
    'Goal: read the job search results already shown on this page. Work quickly.',
    'Steps:',
    '1. Close any cookie or privacy banner.',
    '2. Wait for the list of jobs to appear. Do not type in the search box, do not use filters, and do not open postings.',
    `3. Read the first page of results, up to ${MAX_JOBS} postings.`,
    'Return: the company name, and for each posting its title, location as shown (or null), posted date text as shown (or null), department if shown (or null), and url, the full absolute link to the posting.',
    'Rules: copy text exactly as shown. Do not invent postings or links. If the page says no jobs were found, return an empty jobs list. If you hit a captcha, a login wall or an access denied page, stop and set blocked to true.',
  ].join('\n');
}

function findJobsArray(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  if (Array.isArray(obj)) return obj.length && obj[0] && typeof obj[0] === 'object' && 'title' in obj[0] ? obj : null;
  for (const v of Object.values(obj)) {
    const f = findJobsArray(v, depth + 1);
    if (f) return f;
  }
  return null;
}

function parseAgentResult(run) {
  let r = run ? run.result : null;
  const rawText = typeof r === 'string' ? r : '';
  if (typeof r === 'string') r = parseJsonText(r) || { raw: r };
  if (r && r.result && !r.jobs) r = typeof r.result === 'string' ? parseJsonText(r.result) : r.result;
  const jobs = (r && Array.isArray(r.jobs) ? r.jobs : findJobsArray(r)) || [];
  const code = run && run.error && run.error.code;
  // Look for block words only in error text and raw text answers. Searching the whole
  // result would match the schema's own field name in {"blocked": false}.
  const errText = `${JSON.stringify((run && run.error) || '')} ${rawText}`.toLowerCase();
  const blocked = (r && r.blocked === true) || code === 'SITE_BLOCKED' ||
    (!jobs.length && /captcha|access denied|are you a robot|bot detection|verify you are human/.test(errText));
  return { company: r && r.company ? String(r.company) : null, blocked, jobs: jobs.filter((j) => j && j.title && j.url) };
}

function toListings(parsed, target, now = Date.now()) {
  const company = target.company || parsed.company || prettyName(target.token);
  const out = [];
  for (const j of parsed.jobs) {
    let abs;
    try { abs = new URL(String(j.url), target.url).toString(); } catch { continue; }
    const u = safeUrl(abs);
    if (!u || !/^https?:$/.test(u.protocol)) continue; // drop javascript: and other schemes
    out.push({
      title: String(j.title).slice(0, 200),
      company,
      location: j.location ? String(j.location).slice(0, 160) : null,
      locations: j.location ? [String(j.location)] : [],
      remote: null,
      workplace: null,
      postedAt: parsePostedText(j.posted, now),
      url: abs,
      applyUrl: abs,
      department: j.department || null,
      employmentType: null,
      salary: null,
      description: '',
      levelHint: null,
      ats: target.ats,
      sources: [`agent:${target.ats}`],
    });
  }
  return out;
}

function runBody(target, goal, stealth, country) {
  const body = {
    url: target.url,
    goal,
    output_schema: OUTPUT_SCHEMA,
    browser_profile: stealth ? 'stealth' : 'lite',
    agent_config: { max_duration_seconds: Math.round(MAX_WAIT_MS / 1000) - 20 },
  };
  // Only enabled + country_code: the official SDK (0.8.0) rejects any other proxy_config field.
  if (stealth && PROXY_COUNTRIES.has(country)) body.proxy_config = { enabled: true, country_code: country };
  return body;
}

async function runAgents(targets, p, tf, log, warnings, force, store) {
  const report = [];
  const searchText = [LEVEL_WORDS[p.seniority] || '', p.role].filter(Boolean).join(' ');
  let failures = 0;
  let successes = 0;
  let skipped = 0;
  const lists = await pool(targets, 2, async (target) => {
    const isWorkday = target.ats === 'workday' && target.boardUrl;
    const t = isWorkday ? { ...target, url: `${target.boardUrl}?q=${encodeURIComponent(searchText)}` } : target;
    const goal = isWorkday ? buildWorkdayGoal() : buildGoal(p);
    const host = (safeUrl(t.url) || {}).hostname || t.url;
    const cacheKey = store.hash(`${t.url}|${goal}`);
    if (!force) {
      const cached = store.getAgentCache(cacheKey, CACHE_HOURS);
      if (cached) {
        tf.stats.agent.cached++;
        log('agent', `${t.company}: using Agent result from the last ${CACHE_HOURS}h (no credits used)`);
        report.push({ company: t.company, url: t.url, ats: t.ats, status: 'cached', jobs: cached.jobs.length });
        return toListings(cached, t);
      }
    }
    // Two failures and no success usually means this kind of site does not work today.
    // Stop starting new runs instead of spending credits on the rest.
    if (failures >= 2 && successes === 0) {
      skipped++;
      report.push({ company: t.company, url: t.url, ats: t.ats, status: 'skipped', jobs: 0 });
      return [];
    }
    log('agent', `${t.company}: Agent is browsing ${host}`);
    let run;
    let parsed;
    try {
      const onStream = (url) => log('agent', `${t.company}: live browser view available`, { link: url });
      run = await tf.agentRun(runBody(t, goal, false, p.country), {
        maxWaitMs: MAX_WAIT_MS,
        onProgress: (s) => log('agent', `${t.company}: run ${s.toLowerCase()}`),
        onStream,
      });
      parsed = parseAgentResult(run);
      if (parsed.blocked && STEALTH_RETRY) {
        log('agent', `${t.company}: blocked, retrying once in stealth mode`);
        run = await tf.agentRun(runBody(t, goal, true, p.country), { maxWaitMs: MAX_WAIT_MS, onStream });
        parsed = parseAgentResult(run);
      }
    } catch (err) {
      failures++;
      warnings.push(`Agent could not read ${t.company} (${host}): ${err.message}`);
      report.push({ company: t.company, url: t.url, ats: t.ats, status: 'error', jobs: 0 });
      return [];
    }
    if (run.status !== 'COMPLETED' || parsed.blocked) {
      failures++;
      const why = parsed.blocked ? 'site blocked the browser' : (run.error && (run.error.message || run.error.code)) || run.status;
      warnings.push(`Agent could not read ${t.company} (${host}): ${why}`);
      report.push({ company: t.company, url: t.url, ats: t.ats, status: 'failed', jobs: 0 });
      return [];
    }
    successes++;
    store.setAgentCache(cacheKey, parsed);
    log('agent', `${t.company}: Agent returned ${plural(parsed.jobs.length, 'posting')} in ${run.num_of_steps || '?'} steps`);
    report.push({ company: t.company, url: t.url, ats: t.ats, status: 'done', jobs: parsed.jobs.length, steps: run.num_of_steps || null });
    return toListings(parsed, t);
  });
  if (skipped) {
    warnings.push(`${failures} Agent runs failed and none succeeded, so the app skipped ${plural(skipped, 'careers site')} to save credits.`);
  }
  return { listings: lists.flat(), agentReport: report };
}

module.exports = { runAgents, buildGoal, buildWorkdayGoal, parseAgentResult, toListings, OUTPUT_SCHEMA };
