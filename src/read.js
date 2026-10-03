'use strict';
// Step 2 and Step 4: READ with TinyFish Fetch (free).
//  readFeeds: each board's public JSON feed returns every open job at that company
//             in one request. Fetch handles rendering, caching (ttl) and blocked hosts.
//  enrich:    for top matches that have no description (Agent results, SmartRecruiters,
//             postings found by Search), Fetch the posting page itself. The text is
//             what visa detection, keyword matching and "job closed" checks read.

const { PARSERS, parseJsonText, jobLinksFromMarkdown, clip, toIso } = require('./ats');
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
  const res = byRequestedUrl(await fetchChunks(tf, boards.map((b) => b.feedUrl), { ttl, purpose, perUrlTimeoutMs: 60000 }));

  const listings = [];
  const report = [];
  const retryLite = [];
  const retryPage = [];

  for (const b of boards) {
    const r = res.ok.get(b.feedUrl);
    if (r) {
      const json = parseJsonText(r.text);
      if (json) {
        const items = PARSERS[b.ats](json, b);
        items.forEach((x) => { x.sources = [`fetch:${b.ats}`]; });
        listings.push(...items);
        report.push({ company: items[0] ? items[0].company : b.company || b.token, ats: b.ats, url: b.boardUrl, jobs: items.length, via: 'feed' });
        continue;
      }
      retryPage.push(b);
      continue;
    }
    const e = res.err.get(b.feedUrl);
    if (e && e.error === 'content_too_large' && b.feedUrlLite) retryLite.push(b);
    else if (e && e.error === 'page_not_found') report.push({ company: b.company || b.token, ats: b.ats, url: b.boardUrl, jobs: 0, via: 'feed', note: 'board not found' });
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
      report.push({ company: b.company || b.token, ats: b.ats, url: b.boardUrl, jobs: items.length, via: 'board page', note: e ? e.error : undefined });
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

module.exports = { readFeeds, enrich, guessLocation, CLOSED };
