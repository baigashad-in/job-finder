'use strict';
// Detects which applicant tracking system (ATS) a URL belongs to and turns each
// ATS's public job feed into one common listing shape.
//
// Feed ATS (public JSON feed, read with TinyFish Fetch):
//   greenhouse, lever, ashby, smartrecruiters
// Agent ATS (no simple public GET feed, read with TinyFish Agent):
//   workday, workable, and any custom careers page

const FEED_DOMAINS = [
  'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co',
  'jobs.ashbyhq.com', 'jobs.smartrecruiters.com',
];
const { parsePostedText } = require('./util');

const AGENT_DOMAINS = ['myworkdayjobs.com', 'apply.workable.com'];
const ATS_DOMAINS = [...FEED_DOMAINS, ...AGENT_DOMAINS];

const RESERVED = new Set(['embed', 'v1', 'api', 'jobs', 'job', 'search', 'en', 'en-us', 'careers']);

function safeUrl(u) {
  try { return new URL(u); } catch { return null; }
}

function detectAts(rawUrl) {
  const u = safeUrl(rawUrl);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (host.endsWith('greenhouse.io')) {
    let token = u.searchParams.get('for') || parts[0];
    if (!token || RESERVED.has(token.toLowerCase())) return null;
    token = token.toLowerCase();
    const eu = host.includes('.eu.');
    const jobIdx = parts.indexOf('jobs');
    const jobId = jobIdx >= 0 ? parts[jobIdx + 1] : u.searchParams.get('token');
    return {
      ats: 'greenhouse', kind: 'feed', token, jobId: jobId || null,
      boardUrl: `https://${eu ? 'job-boards.eu' : 'job-boards'}.greenhouse.io/${token}`,
      feedUrl: `https://${eu ? 'boards-api.eu' : 'boards-api'}.greenhouse.io/v1/boards/${token}/jobs?content=true`,
      feedUrlLite: `https://${eu ? 'boards-api.eu' : 'boards-api'}.greenhouse.io/v1/boards/${token}/jobs`,
    };
  }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    const token = parts[0];
    if (!token) return null;
    const eu = host.includes('.eu.');
    return {
      ats: 'lever', kind: 'feed', token: token.toLowerCase(), jobId: parts[1] || null,
      boardUrl: `https://${host}/${token}`,
      feedUrl: `https://${eu ? 'api.eu' : 'api'}.lever.co/v0/postings/${token}?mode=json`,
    };
  }
  if (host === 'jobs.ashbyhq.com') {
    const token = parts[0];
    if (!token) return null;
    return {
      ats: 'ashby', kind: 'feed', token, jobId: parts[1] || null,
      boardUrl: `https://jobs.ashbyhq.com/${token}`,
      feedUrl: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`,
    };
  }
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') {
    const token = parts[0];
    if (!token || RESERVED.has(token.toLowerCase())) return null;
    return {
      ats: 'smartrecruiters', kind: 'feed', token, jobId: parts[1] ? parts[1].split('-')[0] : null,
      boardUrl: `https://jobs.smartrecruiters.com/${token}`,
      feedUrl: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=100`,
    };
  }
  if (host.endsWith('.myworkdayjobs.com')) {
    // https://tenant.wd5.myworkdayjobs.com/en-US/SiteName/job/... -> board root keeps locale + site
    const keep = [];
    for (const p of parts) {
      if (p === 'job' || p === 'details') break;
      keep.push(p);
      if (!/^[a-z]{2}-[A-Z]{2}$/.test(p)) break; // stop after the site name
    }
    const isJob = parts.includes('job') || parts.includes('details');
    return {
      ats: 'workday', kind: 'agent', token: host.split('.')[0],
      jobId: isJob ? parts[parts.length - 1] : null,
      boardUrl: `https://${host}/${keep.join('/')}`,
    };
  }
  if (host === 'apply.workable.com') {
    const token = parts[0];
    if (!token) return null;
    return {
      ats: 'workable', kind: 'agent', token, jobId: parts[1] === 'j' ? parts[2] : null,
      boardUrl: `https://apply.workable.com/${token}/`,
    };
  }
  return null;
}

// ===== text helpers =====

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: ',', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: '...' };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function htmlToText(html) {
  if (!html) return '';
  let s = decodeEntities(String(html)); // Greenhouse content is escaped HTML, so decode first
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n* ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/[ \t\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

function prettyName(token) {
  const t = String(token || '');
  if (/^[a-z0-9]{2,3}$/i.test(t)) return t.toUpperCase(); // cba -> CBA, ptc -> PTC
  return t
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// "Software Engineer, Backend at Figma" -> "Figma"; "Jobs at Figma" -> "Figma"
function companyFromTitle(title) {
  if (!title) return null;
  const t = String(title).replace(/\s*[|\u2013\u2014-]\s*(greenhouse|lever|ashby|workday|smartrecruiters|workable).*$/i, '').trim();
  const m = t.match(/\bat\s+([A-Z0-9][\w&.' ]{1,40}?)\s*$/);
  return m ? m[1].trim() : null;
}

// Fetch returns JSON documents as text. Parse defensively in case it arrives
// wrapped in a code fence or with markdown escapes.
function parseJsonText(t) {
  if (t == null) return null;
  if (typeof t === 'object') return t;
  let s = String(t).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const attempts = [s, s.replace(/\\([_*\[\]()#+\-.!{}`>~|])/g, '$1')];
  for (const a of attempts) {
    try { return JSON.parse(a); } catch { /* try next */ }
    const i = a.search(/[\[{]/);
    const end = Math.max(a.lastIndexOf('}'), a.lastIndexOf(']'));
    if (i >= 0 && end > i) {
      try { return JSON.parse(a.slice(i, end + 1)); } catch { /* try next */ }
    }
  }
  return null;
}

// Fetch result requested as HTML. A JSON document usually arrives as raw JSON or inside
// <pre> with HTML entities escaped, so try both. Entities are decoded in one pass, so
// text like &amp;quot; inside JSON strings stays intact.
function parseJsonFromHtml(t) {
  if (t == null) return null;
  const direct = parseJsonText(t);
  if (direct) return direct;
  const s = String(t);
  const pre = s.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  return parseJsonText(decodeEntities(pre ? pre[1] : s.replace(/<[^>]+>/g, '')));
}

function clip(s, n = 8000) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) : s;
}

function toIso(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ===== feed parsers =====
// Every parser returns objects with this shape:
// { title, company, location, locations[], remote, workplace, postedAt, url, applyUrl,
//   department, employmentType, salary, description, levelHint, ats }

function parseGreenhouse(json, board) {
  const jobs = (json && json.jobs) || [];
  return jobs.map((j) => {
    const loc = j.location && j.location.name ? j.location.name : null;
    const offices = (j.offices || []).map((o) => o.location || o.name).filter(Boolean);
    return {
      title: j.title,
      company: String(j.company_name || board.company || prettyName(board.token)).trim(),
      location: loc,
      locations: [loc, ...offices].filter(Boolean),
      remote: null,
      workplace: null,
      postedAt: toIso(j.first_published || j.updated_at),
      url: j.absolute_url,
      applyUrl: j.absolute_url,
      department: j.departments && j.departments[0] ? j.departments[0].name : null,
      employmentType: null,
      salary: null,
      description: clip(htmlToText(j.content || '')),
      levelHint: null,
      ats: 'greenhouse',
    };
  }).filter((x) => x.title && x.url);
}

function parseLever(json, board) {
  const arr = Array.isArray(json) ? json : [];
  return arr.map((p) => {
    const c = p.categories || {};
    const lists = (p.lists || []).map((l) => `${l.text || ''}\n${htmlToText(l.content || '')}`).join('\n');
    const sr = p.salaryRange;
    return {
      title: p.text,
      company: board.company || prettyName(board.token),
      location: c.location || null,
      locations: (c.allLocations && c.allLocations.length ? c.allLocations : [c.location]).filter(Boolean),
      remote: p.workplaceType === 'remote' ? true : null,
      workplace: p.workplaceType && p.workplaceType !== 'unspecified' ? p.workplaceType : null,
      postedAt: toIso(p.createdAt),
      url: p.hostedUrl,
      applyUrl: p.applyUrl || p.hostedUrl,
      department: c.department || c.team || null,
      employmentType: c.commitment || null,
      salary: sr && (sr.min || sr.max) ? `${sr.currency || ''} ${sr.min || '?'} to ${sr.max || '?'} ${String(sr.interval || '').replace(/-/g, ' ')}`.trim() : null,
      description: clip([p.descriptionPlain || htmlToText(p.description), lists, p.additionalPlain || htmlToText(p.additional)].filter(Boolean).join('\n')),
      levelHint: null,
      ats: 'lever',
    };
  }).filter((x) => x.title && x.url);
}

function parseAshby(json, board) {
  const jobs = (json && json.jobs) || [];
  return jobs.filter((j) => j.isListed !== false).map((j) => {
    const sec = (j.secondaryLocations || []).map((s) => s.location || s.locationName).filter(Boolean);
    const comp = j.compensation || {};
    return {
      title: j.title,
      company: board.company || prettyName(board.token),
      location: j.location || null,
      locations: [j.location, ...sec].filter(Boolean),
      remote: j.isRemote === true ? true : null,
      workplace: j.workplaceType ? String(j.workplaceType).toLowerCase() : null,
      postedAt: toIso(j.publishedAt || j.publishedDate),
      url: j.jobUrl,
      applyUrl: j.applyUrl || j.jobUrl,
      department: j.department || j.team || null,
      employmentType: j.employmentType || null,
      salary: comp.compensationTierSummary || comp.scrapeableCompensationSalarySummary || null,
      description: clip(j.descriptionPlain || htmlToText(j.descriptionHtml)),
      levelHint: null,
      ats: 'ashby',
    };
  }).filter((x) => x.title && x.url);
}

function parseSmartRecruiters(json, board) {
  const list = (json && json.content) || [];
  return list.map((p) => {
    const l = p.location || {};
    const loc = l.fullLocation || [l.city, l.region, l.country ? String(l.country).toUpperCase() : null].filter(Boolean).join(', ') || null;
    const ident = (p.company && p.company.identifier) || board.token;
    return {
      title: p.name,
      company: (p.company && p.company.name) || board.company || prettyName(board.token),
      location: loc,
      locations: [loc].filter(Boolean),
      remote: l.remote === true ? true : null,
      workplace: l.remote === true ? 'remote' : null,
      postedAt: toIso(p.releasedDate),
      url: `https://jobs.smartrecruiters.com/${ident}/${p.id}`,
      applyUrl: `https://jobs.smartrecruiters.com/${ident}/${p.id}`,
      department: (p.department && p.department.label) || (p.function && p.function.label) || null,
      employmentType: (p.typeOfEmployment && p.typeOfEmployment.label) || null,
      salary: null,
      description: '', // list endpoint has no description; enrichment fills it for top matches
      levelHint: (p.experienceLevel && p.experienceLevel.label) || null,
      ats: 'smartrecruiters',
    };
  }).filter((x) => x.title && !/\/undefined$/.test(x.url));
}

const PARSERS = {
  greenhouse: parseGreenhouse,
  lever: parseLever,
  ashby: parseAshby,
  smartrecruiters: parseSmartRecruiters,
};

// Fallback when a feed cannot be parsed: read job links out of the board page markdown.
function jobLinksFromMarkdown(markdown, board) {
  const out = [];
  const seen = new Set();
  const re = /\[([^\]]{3,200})\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(String(markdown || '')))) {
    const d = detectAts(m[2]);
    if (!d || d.ats !== board.ats || !d.jobId) continue;
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    const title = m[1].replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
    out.push({
      title, company: board.company || prettyName(board.token), location: null, locations: [],
      remote: null, workplace: null, postedAt: null, url: m[2], applyUrl: m[2], department: null,
      employmentType: null, salary: null, description: '', levelHint: null, ats: board.ats,
    });
  }
  return out;
}

// Workday search results page read by Fetch (https://x.wd5.myworkdayjobs.com/en-US/Site?q=...).
// Job links look like /en-US/Site/job/Bangalore-India/Software-Engineer_R123, absolute or relative.
// The path segment after /job/ is the job's main location.
function workdayJobsFromMarkdown(markdown, target) {
  const text = String(markdown || '');
  const links = [...text.matchAll(/\[([^\]]{3,200})\]\(([^)\s]+)\)/g)];
  const out = [];
  const seen = new Set();
  links.forEach((m, i) => {
    let u;
    try { u = new URL(m[2], target.boardUrl || target.url); } catch { return; }
    if (!/^https?:$/.test(u.protocol) || !u.hostname.endsWith('.myworkdayjobs.com')) return;
    const parts = u.pathname.split('/').filter(Boolean);
    const j = parts.indexOf('job');
    if (j < 0 || parts.length < j + 3) return;
    const url = `${u.origin}${u.pathname}`;
    if (seen.has(url.toLowerCase())) return;
    seen.add(url.toLowerCase());
    const end = i + 1 < links.length ? links[i + 1].index : m.index + m[0].length + 400;
    const after = text.slice(m.index + m[0].length, end);
    const posted = after.match(/posted[^\n|]{0,40}/i);
    const more = after.match(/\b(\d+)\s+locations\b/i);
    let location;
    try { location = decodeURIComponent(parts[j + 1]); } catch { location = parts[j + 1]; }
    location = location.replace(/[-_]+/g, ' ').trim();
    if (more && Number(more[1]) > 1) location = `${location} (+${Number(more[1]) - 1} more)`;
    out.push({
      title: m[1].replace(/[*_`#\\]/g, '').replace(/\s+/g, ' ').trim(),
      company: target.company || prettyName(target.token),
      location, locations: [location], remote: /\bremote\b/i.test(location) ? true : null, workplace: null,
      postedAt: posted ? parsePostedText(posted[0]) : null,
      url, applyUrl: url, department: null, employmentType: null, salary: null,
      description: '', levelHint: null, ats: 'workday',
    });
  });
  return out;
}

// Fallback when the page text has no usable link markup: build jobs from the links list
// Fetch returns with links: true. The title comes from the URL slug:
// /job/Bangalore-India/Software-Engineer--Java-_R123 -> "Software Engineer Java".
// The URL slug loses punctuation ("C++" becomes "C"), so when the page text has a line
// with the same words, use that line as the title and read the posted date below it.
function workdayJobsFromLinks(urls, target, text = '') {
  const lines = String(text).split('\n').map((l) => l.replace(/[*_#`>|\[\]]/g, '').trim()).filter(Boolean);
  const keyOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const lineKeys = lines.map(keyOf);
  const used = new Set();
  const md = (urls || []).map((u) => {
    try {
      const x = new URL(u, target.boardUrl || target.url);
      const parts = x.pathname.split('/').filter(Boolean);
      const j = parts.indexOf('job');
      if (j < 0 || parts.length < j + 3) return '';
      const slug = decodeURIComponent(parts[parts.length - 1]).replace(/_[A-Za-z0-9-]+$/, '');
      let title = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
      let below = '';
      const k = keyOf(title);
      const i = k.length >= 6 ? lineKeys.findIndex((lk, n) => !used.has(n) && (lk === k || (k.length >= 15 && lk.startsWith(k)))) : -1;
      if (i >= 0) {
        used.add(i);
        title = lines[i];
        below = lines.slice(i + 1, i + 4).join('\n');
      }
      return title.length >= 3 ? `[${title}](${x.href})\n${below}` : '';
    } catch { return ''; }
  }).filter(Boolean).join('\n');
  return workdayJobsFromMarkdown(md, target);
}

// /en-US/Site/job/Bangalore-India/SWE_R1 -> "Bangalore India"
function workdayLocationFromUrl(u) {
  const x = safeUrl(u);
  if (!x || !x.hostname.endsWith('.myworkdayjobs.com')) return null;
  const parts = x.pathname.split('/').filter(Boolean);
  const j = parts.indexOf('job');
  if (j < 0 || parts.length < j + 3) return null;
  let loc;
  try { loc = decodeURIComponent(parts[j + 1]); } catch { loc = parts[j + 1]; }
  return loc.replace(/[-_]+/g, ' ').trim() || null;
}

module.exports = {
  FEED_DOMAINS, AGENT_DOMAINS, ATS_DOMAINS, PARSERS,
  detectAts, htmlToText, decodeEntities, prettyName, companyFromTitle, parseJsonText,
  jobLinksFromMarkdown, workdayJobsFromMarkdown, workdayJobsFromLinks, workdayLocationFromUrl,
  parseJsonFromHtml, toIso, clip, safeUrl,
};
