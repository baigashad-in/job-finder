'use strict';
// Orchestrates one search run:
//  1 Search  -> find job boards and postings (discover.js)
//  2 Fetch   -> read each board's full feed (read.js)
//  3 Agent   -> browse careers sites with no feed, capped (agent.js)
//  4 Dedupe  -> one row per job across sources (match.js)
//  5 Fetch   -> read top posting pages for visa notes, dates, closed jobs (read.js)
//  6 Rank    -> score, filter, sort, mark "new since last run"

const { normalizePrefs, evaluate, dedupe, LEVEL_LABEL } = require('./match');
const { discover } = require('./discover');
const { readFeeds, readWorkdayBoards, enrich } = require('./read');
const { runAgents } = require('./agent');
const { plural } = require('./util');

const MAX_BOARDS = Number(process.env.MAX_BOARDS || 25);
const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT || 20);
const MAX_RESULTS = 300;

function byPriority(a, b) {
  const w = (x) => (x.from === 'watchlist' ? 1000 : 0) + (x.hits || 0);
  return w(b) - w(a);
}

async function runPipeline(rawPrefs, { tf, store, log = () => {}, force = false }) {
  const started = Date.now();
  const p = normalizePrefs(rawPrefs);
  const searchId = store.searchIdFor(p);
  const warnings = [];
  if (p.countryFrom) log('step', `Searching in country ${p.country} because your first location is ${p.countryFrom}`);
  // Server-wide ceiling on Agent runs, for public deploys where visitors spend your credits.
  const limit = Number.parseInt(process.env.AGENT_RUNS_LIMIT, 10);
  if (Number.isFinite(limit) && limit >= 0 && p.maxAgentRuns > limit) {
    warnings.push(`This server allows at most ${plural(limit, 'Agent run')} per search.`);
    p.maxAgentRuns = limit;
  }

  // 1. Discover
  const disc = await discover(p, tf, log, warnings);
  const boards = [...disc.boards.values()].sort(byPriority);
  const targets = [...disc.agentTargets.values()].sort(byPriority);
  if (boards.length > MAX_BOARDS) warnings.push(`Found ${boards.length} job boards, read the top ${MAX_BOARDS}.`);

  // 2. Read feeds
  const useBoards = boards.slice(0, MAX_BOARDS);
  log('step', `Reading ${plural(useBoards.length, 'job board')} with TinyFish Fetch`);
  const feeds = await readFeeds(useBoards, p, tf, log, warnings, force);
  log('fetch', `Boards returned ${plural(feeds.listings.length, 'open job')} in total`);

  // 3a. Workday: Fetch the search results page first (free). Only failures go to the Agent.
  const workday = targets.filter((t) => t.ats === 'workday').slice(0, MAX_BOARDS);
  let wd = { listings: [], report: [], needAgent: [] };
  if (workday.length) {
    log('step', `Reading ${plural(workday.length, 'Workday site')} with TinyFish Fetch`);
    wd = await readWorkdayBoards(workday, p, tf, log, force);
  }

  // 3b. Agent for sites Fetch could not read
  const agentQueue = targets.filter((t) => t.ats !== 'workday' || wd.needAgent.includes(t));
  const useTargets = agentQueue.slice(0, p.maxAgentRuns);
  if (agentQueue.length > useTargets.length) {
    warnings.push(`Skipped ${plural(agentQueue.length - useTargets.length, 'careers site')} because Agent runs are capped at ${p.maxAgentRuns}. Raise the cap to include them.`);
  }
  let agent = { listings: [], agentReport: [] };
  if (useTargets.length) {
    log('step', `Browsing ${plural(useTargets.length, 'careers site')} with TinyFish Agent`);
    agent = await runAgents(useTargets, p, tf, log, warnings, force, store);
  }

  // Postings found directly by Search on sites without feeds
  const singles = [...disc.singles.values()].map((s) => ({
    title: s.title, company: s.company, location: null, locations: [], remote: null, workplace: null,
    postedAt: s.postedAt, url: s.url, applyUrl: s.url, department: null, employmentType: null, salary: null,
    description: '', levelHint: null, ats: s.ats, sources: ['search'],
  }));

  // 4. Dedupe
  const raw = [...feeds.listings, ...wd.listings, ...agent.listings, ...singles];
  const { listings, removed } = dedupe(raw);
  log('step', `Matching ${plural(listings.length, 'unique job')} (${plural(removed, 'duplicate')} merged)`);

  // 5. Enrich the best candidates that have no description yet
  const prelim = listings.map((l) => ({ l, e: evaluate(l, p) }));
  const needText = prelim
    .filter(({ l, e }) => (!e.dropped || /^(visa|keywords)/.test(e.dropped)) && (!l.description || l.description.length < 40))
    .sort((a, b) => b.e.score - a.e.score)
    .map(({ l }) => l);
  const enr = await enrich(needText, p, tf, log, ENRICH_LIMIT, force);
  if (enr.closed) log('fetch', `${plural(enr.closed, 'posting')} closed, removed`);

  // 6. Rank
  const drops = {};
  const matched = [];
  for (const l of listings) {
    if (l.closed) { drops['closed or removed'] = (drops['closed or removed'] || 0) + 1; continue; }
    const e = evaluate(l, p);
    if (e.dropped) {
      const k = e.dropped.split(':')[0];
      drops[k] = (drops[k] || 0) + 1;
      continue;
    }
    matched.push({ l, e });
  }
  matched.sort((a, b) => b.e.score - a.e.score || String(b.l.postedAt || '').localeCompare(String(a.l.postedAt || '')));

  const seen = store.markSeen(searchId, matched.map(({ l }) => l.key));
  const out = matched.slice(0, MAX_RESULTS).map(({ l, e }) => ({
    key: l.key,
    title: l.title,
    company: l.company,
    location: l.location || (l.locations && l.locations[0]) || null,
    otherLocations: (l.locations || []).filter((x) => x && x !== l.location).slice(0, 4),
    remote: e.remote,
    level: e.level,
    levelLabel: LEVEL_LABEL[e.level],
    postedAt: l.postedAt,
    daysOld: e.daysOld,
    department: l.department,
    employmentType: l.employmentType,
    salary: l.salary,
    url: l.url,
    applyUrl: l.applyUrl || l.url,
    ats: l.ats,
    sources: l.sources,
    score: e.score,
    reasons: e.reasons,
    visa: e.visa,
    keywordHits: e.keywordHits,
    isNew: seen.isNew(l.key),
    firstSeen: seen.firstSeen(l.key),
  }));

  const result = {
    searchId,
    prefs: p,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    firstRun: seen.firstRun,
    counts: {
      collected: raw.length,
      unique: listings.length,
      duplicatesMerged: removed,
      matched: matched.length,
      shown: out.length,
      newSinceLastRun: out.filter((x) => x.isNew).length,
      pagesRead: enr.read,
    },
    filteredOut: drops,
    boards: [...feeds.boardReport, ...wd.report],
    agentSites: agent.agentReport,
    usage: JSON.parse(JSON.stringify(tf.stats)),
    warnings,
    listings: out,
  };
  log('done', `${plural(out.length, 'match')}${seen.firstRun ? '' : `, ${result.counts.newSinceLastRun} new since last run`}`);
  return result;
}

module.exports = { runPipeline };
