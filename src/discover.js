'use strict';
// Step 1: DISCOVER with TinyFish Search.
// Search is restricted to ATS domains, so every hit points at a real job posting
// or job board. A single posting hit tells us the company's board token, and we
// then read the whole board (Step 2), not just the one posting the search found.

const { ATS_DOMAINS, PARSERS, detectAts, companyFromTitle, prettyName, safeUrl, toIso, parseJsonText } = require('./ats');
const { pool, plural } = require('./util');

const LEVEL_WORDS = { intern: 'intern', entry: 'new grad', senior: 'senior', staff: 'staff', manager: 'manager' };
// Aggregators need logins or block bots, and they duplicate the ATS postings we already read.
const AGGREGATORS = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com', 'simplyhired.com',
  'builtin.com', 'wellfound.com', 'joinhandshake.com', 'levels.fyi', 'reddit.com', 'youtube.com', 'facebook.com',
  'twitter.com', 'x.com', 'instagram.com', 'wikipedia.org', 'crunchbase.com'];

function buildQueries(p) {
  const lvl = LEVEL_WORDS[p.seniority] || '';
  const place = p.places[0] || (p.remoteOk ? 'remote' : '');
  const base = [p.role, lvl, place].filter(Boolean).join(' ');
  const q = [
    { label: 'recent postings', query: base, recency_minutes: (p.postedWithinDays || 30) * 1440 },
    { label: 'all postings', query: `${base} jobs` },
  ];
  if (p.keywords.length) q.push({ label: 'with keywords', query: [p.role, lvl, ...p.keywords.slice(0, 2)].filter(Boolean).join(' ') });
  if (p.places[1]) q.push({ label: 'second location', query: [p.role, lvl, p.places[1]].filter(Boolean).join(' ') });
  if (p.remoteOk && p.places.length) q.push({ label: 'remote', query: [p.role, lvl, 'remote'].filter(Boolean).join(' ') });
  return q.slice(0, 4);
}

function cleanSearchTitle(t) {
  return String(t || '')
    .replace(/^job application for\s+/i, '')
    .split(/\s+\|\s+/)[0]
    .replace(/\s+at\s+[A-Z0-9][\w&.' ]{1,40}$/, '')
    // "Software Engineer - Myworkdayjobs.com", "Software Engineer - PTC Careers"
    .replace(/\s+[-\u2013]\s+(myworkdayjobs\.com|workday|[^-\u2013]{0,40}\bcareers?)$/i, '')
    .trim();
}

function addHit(acc, r, from) {
  const d = detectAts(r.url);
  if (!d) return;
  const key = `${d.ats}:${d.token}`;
  if (d.kind === 'feed') {
    const isNew = !acc.boards.has(key);
    const b = acc.boards.get(key) || { ...d, hits: 0, company: null, from };
    b.hits++;
    b.company = b.company || companyFromTitle(r.title);
    acc.boards.set(key, b);
    return isNew;
  }
  const isNew = !acc.agentTargets.has(key);
  const t = acc.agentTargets.get(key) || { ...d, url: d.boardUrl, hits: 0, company: null, from };
  t.hits++;
  t.company = t.company || companyFromTitle(r.title) || prettyName(d.token);
  acc.agentTargets.set(key, t);
  // A posting on a Workday/Workable site is already a listing. Keep it; Fetch reads it later.
  if (d.jobId && !acc.singles.has(r.url)) {
    acc.singles.set(r.url, {
      url: r.url, title: cleanSearchTitle(r.title), snippet: r.snippet || '',
      company: t.company, ats: d.ats, postedAt: toIso(r.date),
    });
  }
  return isNew;
}

function slugOf(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function tokenMatches(token, name) {
  const a = slugOf(token);
  const b = slugOf(name);
  if (b.length < 3 || a.length < 3) return a === b;
  return a.includes(b) || b.includes(a);
}

// Turns one watchlist entry (company name or URL) into a board or an Agent target.
async function resolveCompany(entry, tf, p, log, acc, warnings) {
  if (/^https?:\/\//i.test(entry)) {
    const d = detectAts(entry);
    const u = safeUrl(entry);
    if (!u) { warnings.push(`Not a valid URL: ${entry}`); return; }
    if (d && d.kind === 'feed') {
      acc.boards.set(`${d.ats}:${d.token}`, { ...d, hits: 99, company: null, from: 'watchlist' });
    } else {
      const key = d ? `${d.ats}:${d.token}` : `custom:${u.hostname}${u.pathname}`;
      acc.agentTargets.set(key, {
        ...(d || { ats: 'custom', kind: 'agent', token: u.hostname }),
        url: entry, hits: 99, company: prettyName(u.hostname.replace(/^(www|careers|jobs)\./, '').split('.')[0]), from: 'watchlist',
      });
    }
    return;
  }

  // Company name: look for its ATS board first.
  try {
    const hits = await tf.search({
      query: `${entry} careers jobs`, include_domains: ATS_DOMAINS, location: p.country,
      purpose: `Find the official job board of ${entry} to list its open roles`,
    });
    for (const r of hits) {
      const d = detectAts(r.url);
      if (d && tokenMatches(d.token, entry)) {
        log('search', `${entry}: found ${d.ats} board "${d.token}"`);
        const key = `${d.ats}:${d.token}`;
        if (d.kind === 'feed') acc.boards.set(key, { ...d, hits: 99, company: entry, from: 'watchlist' });
        else acc.agentTargets.set(key, { ...d, url: d.boardUrl, hits: 99, company: entry, from: 'watchlist' });
        return;
      }
    }
  } catch (err) {
    warnings.push(`Search failed for ${entry}: ${err.message}`);
  }

  // Not found on an ATS: guess the common feed URLs and let Fetch confirm (free, one call).
  const slug = slugOf(entry);
  const guesses = [
    { ats: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, board: `https://job-boards.greenhouse.io/${slug}` },
    { ats: 'lever', url: `https://api.lever.co/v0/postings/${slug}?mode=json`, board: `https://jobs.lever.co/${slug}` },
    { ats: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${slug}`, board: `https://jobs.ashbyhq.com/${slug}` },
  ];
  try {
    const res = await tf.fetchUrls(guesses.map((g) => g.url), { ttl: 86400, perUrlTimeoutMs: 20000, purpose: `Check whether ${entry} has a public job board` });
    for (const g of guesses) {
      const r = res.results.find((x) => x.url === g.url);
      const json = r ? parseJsonText(r.text) : null;
      if (json && PARSERS[g.ats](json, { token: slug, company: entry }).length > 0) {
        const d = detectAts(g.board);
        log('fetch', `${entry}: confirmed ${g.ats} board by fetching its feed`);
        acc.boards.set(`${d.ats}:${d.token}`, { ...d, hits: 99, company: entry, from: 'watchlist' });
        return;
      }
    }
  } catch { /* fall through */ }

  // Still nothing: find the company's own careers page and let the Agent read it.
  try {
    const hits = await tf.search({
      query: `${entry} careers open positions`, exclude_domains: AGGREGATORS, location: p.country,
      purpose: `Find the official careers page of ${entry}`,
    });
    for (const r of hits) {
      const u = safeUrl(r.url);
      if (!u) continue;
      const own = slugOf(u.hostname).includes(slug.slice(0, Math.max(4, Math.min(slug.length, 10))));
      if (own && /career|jobs|join|work-with-us|opportunit|openings|positions/i.test(u.href)) {
        log('search', `${entry}: using careers page ${u.hostname}${u.pathname}`);
        acc.agentTargets.set(`custom:${u.hostname}${u.pathname}`, {
          ats: 'custom', kind: 'agent', token: u.hostname, url: r.url, hits: 99, company: entry, from: 'watchlist',
        });
        return;
      }
    }
  } catch (err) {
    warnings.push(`Search failed for ${entry}: ${err.message}`);
  }
  warnings.push(`Could not find a careers page for "${entry}". Paste its careers URL instead.`);
}

async function discover(p, tf, log, warnings) {
  const acc = { boards: new Map(), agentTargets: new Map(), singles: new Map() };

  if (p.companies.length) {
    log('step', `Looking up ${plural(p.companies.length, 'company')} from your watchlist`);
    await pool(p.companies, 3, (c) => resolveCompany(c, tf, p, log, acc, warnings));
  }

  if (p.discover) {
    const queries = buildQueries(p);
    log('step', `Searching job boards with ${plural(queries.length, 'TinyFish Search query')}`);
    await pool(queries, 2, async (q) => {
      try {
        const results = await tf.search({
          query: q.query,
          include_domains: ATS_DOMAINS,
          location: p.country,
          recency_minutes: q.recency_minutes,
          purpose: `Find open ${p.role} job postings on company job boards`,
        });
        let added = 0;
        for (const r of results) if (addHit(acc, r, 'search')) added++;
        log('search', `"${q.query}" (${q.label}): ${plural(results.length, 'hit')}, ${plural(added, 'new board')}`);
      } catch (err) {
        warnings.push(`Search "${q.query}" failed: ${err.message}`);
      }
    });
  }
  return acc;
}

module.exports = { discover, buildQueries, cleanSearchTitle, tokenMatches, AGGREGATORS };
