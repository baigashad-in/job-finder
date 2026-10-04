'use strict';
// Step 2 and Step 4: READ with TinyFish Fetch (free).
//  readFeeds: each board's public JSON feed returns every open job at that company
//             in one request. Fetch handles rendering, caching (ttl) and blocked hosts.
//  enrich:    for top matches that have no description (Agent results, SmartRecruiters,
//             postings found by Search), Fetch the posting page itself. The text is
//             what visa detection, keyword matching and "job closed" checks read.

const { PARSERS, parseJsonText, parseJsonFromHtml, jobLinksFromMarkdown, workdayJobsFromMarkdown, workdayJobsFromLinks, prettyName, clip, toIso } = require('./ats');
const { pool, plural } = require('./util');

function byRequestedUrl(res) {
  const m = new Map();
  for (const r of res.results) m.set(r.url, r);
  const e = new Map();
  for (const x of res.errors) e.set(x.url, x);
  return { ok: m, err: e };
}

async function fetchChunks(tf, urls, opts) {
  const chunks = [];
  for (let i = 0; i < urls.length; i += 10) chunks.push(urls.slice(i, i + 10));
  const parts = await pool(chunks, 3, (c) => tf.fetchUrls(c, opts));
  return {
    results: parts.flatMap((p) => p.results),
    errors: parts.flatMap((p) => p.errors),
  };
}

async function readFeeds(boards, p, tf, log, warnings, force) {
  if (!boards.length) return { listings: [], boardReport: [] };
  const ttl = force ? 0 : 3600; // accept a TinyFish cache entry up to 1 hour old unless refreshing
  const purpose = `Read the public job feed of each company to list open ${p.role} roles`;
  // SmartRecruiters returns at most 100 postings, so ask it for the role up front.
  const feedUrlOf = (b) => (b.ats === 'smartrecruiters' ? `${b.feedUrl}&q=${encodeURIComponent(p.role)}` : b.feedUrl);
  const res = byRequestedUrl(await fetchChunks(tf, boards.map(feedUrlOf), { ttl, purpose, perUrlTimeoutMs: 60000 }));

  const listings = [];
  const report = [];
  const retryLite = [];
  const retryPage = [];
  const retryHtml = [];

  for (const b of boards) {
    const r = res.ok.get(feedUrlOf(b));
    if (r) {
      const json = parseJsonText(r.text);
      if (json) {
        const items = PARSERS[b.ats](json, b);
        items.forEach((x) => { x.sources = [`fetch:${b.ats}`]; });
        listings.push(...items);
        report.push({ company: items[0] ? items[0].company : b.company || prettyName(b.token), ats: b.ats, url: b.boardUrl, jobs: items.length, via: 'feed' });
        continue;
      }
      retryHtml.push(b);
      continue;
    }
    const e = res.err.get(feedUrlOf(b));
    if (e && e.error === 'content_too_large' && b.feedUrlLite) retryLite.push(b);
    else if (e && e.error === 'page_not_found') report.push({ company: b.company || prettyName(b.token), ats: b.ats, url: b.boardUrl, jobs: 0, via: 'feed', note: 'board not found' });
    else retryPage.push(b);
  }

  // Very large Greenhouse boards: read without descriptions; enrichment adds them for top matches.
  if (retryLite.length) {
    log('fetch', `${plural(retryLite.length, 'board')} too large with descriptions, reading titles only`);
    const lite = byRequestedUrl(await fetchChunks(tf, retryLite.map((b) => b.feedUrlLite), { ttl, purpose }));
    for (const b of retryLite) {
      const r = lite.ok.get(b.feedUrlLite);
      const json = r ? parseJsonText(r.text) : null;
      const items = json ? PARSERS[b.ats](json, b) : [];
      items.forEach((x) => { x.sources = [`fetch:${b.ats}`]; });
      listings.push(...items);
      report.push({ company: items[0] ? items[0].company : b.token, ats: b.ats, url: b.boardUrl, jobs: items.length, via: 'feed (titles only)' });
    }
  }

  // Feed text was not valid JSON. Lever and Ashby feeds hold raw HTML inside JSON strings,
  // which can break when Fetch converts the page to markdown. Ask for HTML and take the
  // JSON from that. Only feeds that still fail fall through to the board page below.
  if (retryHtml.length) {
    log('fetch', `${plural(retryHtml.length, 'feed')} did not parse as JSON, retrying as HTML`);
    const html = byRequestedUrl(await fetchChunks(tf, retryHtml.map(feedUrlOf), { ttl, purpose, format: 'html', perUrlTimeoutMs: 60000 }));
    for (const b of retryHtml) {
      const r = html.ok.get(feedUrlOf(b));
      const json = r ? parseJsonFromHtml(r.text) : null;
      if (!json) { retryPage.push(b); continue; }
      const items = PARSERS[b.ats](json, b);
      items.forEach((x) => { x.sources = [`fetch:${b.ats}`]; });
      listings.push(...items);
      report.push({ company: items[0] ? items[0].company : b.company || prettyName(b.token), ats: b.ats, url: b.boardUrl, jobs: items.length, via: 'feed (html)' });
    }
  }

  // Feed unreadable: read the human board page and pull job links out of it.
  if (retryPage.length) {
    log('fetch', `${plural(retryPage.length, 'feed')} unreadable, reading board pages instead`);
    const pages = byRequestedUrl(await fetchChunks(tf, retryPage.map((b) => b.boardUrl), { ttl, purpose, links: false }));
    for (const b of retryPage) {
      const r = pages.ok.get(b.boardUrl);
      const items = r ? jobLinksFromMarkdown(r.text, b) : [];
      items.forEach((x) => { x.sources = [`fetch:${b.ats}`]; });
      listings.push(...items);
      const e = pages.err.get(b.boardUrl);
      report.push({ company: b.company || prettyName(b.token), ats: b.ats, url: b.boardUrl, jobs: items.length, via: 'board page', note: e ? e.error : undefined });
      if (e) warnings.push(`Could not read ${b.boardUrl}: ${e.error}`);
    }
  }
  return { listings, boardReport: report };
}

const CLOSED = /(no longer (available|accepting|open)|position has been filled|this job (is|has been) closed|job (posting )?(has )?expired|page you are looking for (doesn't|does not) exist|job not found)/i;

function guessLocation(text) {
  const m = String(text || '').match(/(?:^|\n)\s*(?:\*\*)?(?:locations?|job location|office location|work location)(?:\*\*)?\s*[:\n]\s*([^\n]{2,80})/i);
  return m ? m[1].replace(/[*_#]/g, '').trim() : null;
}

// Mutates listings in place. Returns how many it read and how many were closed.
async function enrich(listings, p, tf, log, limit, force) {
  const todo = listings.slice(0, limit);
  if (!todo.length) return { read: 0, closed: 0 };
  log('step', `Reading ${plural(todo.length, 'posting page')} with TinyFish Fetch to check visa notes and details`);
  const res = byRequestedUrl(await fetchChunks(tf, todo.map((l) => l.url), {
    ttl: force ? 0 : 21600,
    perUrlTimeoutMs: 45000,
    purpose: `Read job postings for ${p.role} roles to find location, posting date and visa sponsorship policy`,
  }));
  let closed = 0;
  for (const l of todo) {
    const r = res.ok.get(l.url);
    const e = res.err.get(l.url);
    // A live ATS feed is the authority on whether a job is open. Only trust
    // "closed" signals for jobs found by Search or Agent.
    const fromFeed = (l.sources || []).some((s) => s.startsWith('fetch:') && s !== 'fetch:page');
    if (e && e.error === 'page_not_found' && !fromFeed) { l.closed = true; closed++; continue; }
    if (!r) continue;
    const text = typeof r.text === 'string' ? r.text : '';
    if (!fromFeed && CLOSED.test(text.slice(0, 3000))) { l.closed = true; closed++; continue; }
    l.description = clip(text);
    if (!l.title || l.title.length < 4) l.title = r.title || l.title;
    if (!l.postedAt && r.published_date) l.postedAt = toIso(r.published_date);
    if (!l.location) l.location = guessLocation(text);
    if (r.final_url && r.final_url !== l.url && !l.applyUrl) l.applyUrl = r.final_url;
    l.sources = [...new Set([...(l.sources || []), 'fetch:page'])];
  }
  return { read: todo.length, closed };
}

// Workday careers sites have no public GET feed, but Fetch renders their search results
// page (?q=...) for free in seconds. Sites where that yields no job links go to the Agent.
async function readWorkdayBoards(targets, p, tf, log, force) {
  const place = p.places[0];
  const queries = [p.role, place ? `${p.role} ${place}` : null].filter(Boolean);
  const reqs = [];
  for (const t of targets) for (const q of queries) reqs.push({ t, url: `${t.boardUrl}?q=${encodeURIComponent(q)}` });
  const res = byRequestedUrl(await fetchChunks(tf, reqs.map((r) => r.url), {
    ttl: force ? 0 : 3600,
    links: true, // second source of job links if the page text has none
    perUrlTimeoutMs: 90000,
    purpose: `Read job search results on each company's Workday careers site for ${p.role} roles`,
  }));
  const listings = [];
  const report = [];
  const needAgent = [];
  for (const t of targets) {
    const byUrl = new Map();
    let zero = false;
    const seen = []; // what Fetch returned, logged so a failure can be diagnosed
    for (const r of reqs.filter((x) => x.t === t)) {
      const page = res.ok.get(r.url);
      const err = res.err.get(r.url);
      if (!page) { seen.push(err ? `error ${err.error}` : 'no result'); continue; }
      const text = typeof page.text === 'string' ? page.text : '';
      const links = Array.isArray(page.links) ? page.links : [];
      if (/\b0\s+jobs?\s+found\b/i.test(text)) zero = true;
      let found = workdayJobsFromMarkdown(text, t);
      if (!found.length && links.length) found = workdayJobsFromLinks(links, t, text);
      for (const item of found) byUrl.set(item.url, item);
      const jobLinks = links.filter((u) => /\/job\//.test(u)).length;
      seen.push(`${text.length} chars, ${links.length} links (${jobLinks} to jobs), ${found.length} jobs read`);
    }
    log('fetch', `${t.company} Workday page: ${seen.join(' | ')}`);
    const items = [...byUrl.values()];
    items.forEach((x) => { x.sources = ['fetch:workday']; });
    listings.push(...items);
    if (items.length || zero) report.push({ company: t.company, ats: 'workday', url: t.boardUrl, jobs: items.length, via: 'search page' });
    else needAgent.push(t);
  }
  log('fetch', `Workday: ${plural(listings.length, 'job')} read by Fetch, ${plural(needAgent.length, 'site')} left for the Agent`);
  return { listings, report, needAgent };
}

module.exports = { readFeeds, readWorkdayBoards, enrich, guessLocation, CLOSED };
