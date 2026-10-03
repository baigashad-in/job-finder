'use strict';
// Turns raw listings into ranked matches. Every score comes with plain reasons
// so the user can see why a job is ranked where it is.

const { safeUrl } = require('./ats');

// ===== text normalisation =====
const STOP = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'for', 'to', 'in', 'at', 'with', 'on']);

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
}
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function toks(s) {
  return norm(s).split(' ').filter((w) => w && !STOP.has(w)).map(stem);
}
function hasPhrase(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i <= hay.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}
function wordRe(word) {
  const esc = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i');
}

// ===== role =====
const ROLE_FAMILIES = [
  ['software engineer', 'software developer', 'swe', 'backend engineer', 'back end engineer', 'frontend engineer', 'front end engineer', 'full stack engineer', 'fullstack engineer', 'full stack developer', 'web developer', 'mobile engineer', 'ios engineer', 'android engineer', 'platform engineer', 'member of technical staff', 'product engineer'],
  ['data scientist', 'data science', 'applied scientist', 'research scientist', 'machine learning scientist', 'decision scientist'],
  ['machine learning engineer', 'ml engineer', 'ai engineer', 'deep learning engineer', 'research engineer', 'applied scientist', 'mlops engineer'],
  ['data analyst', 'business analyst', 'bi analyst', 'business intelligence analyst', 'analytics analyst', 'product analyst', 'data analytics'],
  ['data engineer', 'analytics engineer', 'data platform engineer', 'etl developer'],
  ['product manager', 'associate product manager', 'apm', 'technical product manager', 'product owner'],
  ['product designer', 'ux designer', 'ui designer', 'ux researcher', 'interaction designer', 'visual designer'],
  ['devops engineer', 'site reliability engineer', 'sre', 'infrastructure engineer', 'cloud engineer', 'platform engineer'],
  ['security engineer', 'security analyst', 'application security engineer', 'cybersecurity analyst'],
  ['hardware engineer', 'electrical engineer', 'embedded engineer', 'embedded software engineer', 'firmware engineer', 'fpga engineer'],
  ['mechanical engineer', 'manufacturing engineer', 'robotics engineer'],
  ['quantitative researcher', 'quantitative trader', 'quantitative developer', 'quant researcher', 'quant developer', 'quantitative analyst'],
  ['marketing', 'growth marketing', 'product marketing', 'marketing manager', 'content marketing'],
  ['account executive', 'sales development representative', 'business development representative', 'sdr', 'bdr'],
  ['financial analyst', 'investment banking analyst', 'fp a analyst', 'accountant'],
  ['recruiter', 'technical recruiter', 'recruiting coordinator', 'talent acquisition'],
];
// Words that mean the posting is a different job even if it mentions the role.
const CONFLICT_WORDS = ['recruiter', 'recruiting', 'sourcer', 'talent acquisition', 'account executive', 'sales', 'marketing', 'counsel', 'attorney', 'paralegal', 'executive assistant'];

const GENERIC_ROLE_WORDS = new Set(['engineer', 'developer', 'manager', 'analyst', 'specialist', 'associate',
  'lead', 'scientist', 'designer', 'consultant', 'architect', 'administrator', 'coordinator', 'representative',
  'officer', 'technician', 'assistant', 'intern', 'senior', 'junior', 'staff', 'principal', 'director', 'head']);

function roleExpansions(role) {
  const rt = toks(role);
  const out = new Set();
  for (const fam of ROLE_FAMILIES) {
    if (fam.some((ph) => hasPhrase(rt, toks(ph)) || hasPhrase(toks(ph), rt))) {
      for (const ph of fam) out.add(ph);
    }
  }
  out.delete(norm(role));
  return [...out];
}

function scoreRole(listing, p) {
  if (!p.role) return { score: 25, reason: null };
  const title = listing.title || '';
  const tt = toks(title);
  const roleText = [p.role, ...p.expansions].join(' ').toLowerCase();
  for (const w of CONFLICT_WORDS) {
    if (wordRe(w).test(title) && !roleText.includes(w)) {
      return { score: 0, drop: true, reason: `title looks like a ${w} role` };
    }
  }
  const rt = toks(p.role);
  if (hasPhrase(tt, rt)) return { score: 40, reason: `title matches "${p.role}"` };
  for (const ph of p.expansions) {
    if (hasPhrase(tt, toks(ph))) return { score: 32, reason: `related title "${ph}"` };
  }
  // Sharing only a generic word ("engineer", "manager") is not enough: "Support Engineer"
  // is not a match for "software engineer". At least one specific word must match.
  const hits = rt.filter((t) => tt.includes(t));
  const overlap = hits.length / Math.max(rt.length, 1);
  const specific = rt.some((t) => !GENERIC_ROLE_WORDS.has(t));
  const specificHit = !specific || hits.some((t) => !GENERIC_ROLE_WORDS.has(t));
  if (overlap >= 0.5 && specificHit) return { score: Math.round(30 * overlap), reason: 'title shares most role words' };
  return { score: 0, drop: true, reason: 'title does not match role' };
}

// ===== seniority =====
const LEVEL_LABEL = { intern: 'Intern', entry: 'Entry / new grad', mid: 'Mid', senior: 'Senior', staff: 'Staff+', manager: 'Manager', unspecified: 'Level not stated' };

function detectLevel(title, hint, roleText) {
  const t = ` ${norm(title)} `;
  const roleHasManager = /manager/.test(roleText || '');
  if (/ (intern|internship|co op|coop|apprentice|apprenticeship|working student|summer analyst|summer associate|placement) /.test(t) ||
      / (summer|fall|spring|winter) 20\d\d /.test(t)) return 'intern';
  if (/ (staff|principal|distinguished|fellow) /.test(t)) return 'staff';
  if (/ (director|head|vp|vice president|chief) /.test(t)) return 'manager';
  if (!roleHasManager && / (engineering manager|manager) /.test(t) && !/ product manager /.test(t)) return 'manager';
  if (/ (senior|sr|lead|iii|iv) /.test(t)) return 'senior';
  if (/ (new grad|new graduate|graduate|grad|entry level|entry|junior|jr|early career|university|campus|associate) /.test(t) ||
      / (engineer|developer|scientist|analyst|designer) i /.test(t)) return 'entry';
  if (/ (ii|mid level|intermediate) /.test(t)) return 'mid';
  const h = String(hint || '').toLowerCase();
  if (h.includes('intern')) return 'intern';
  if (h.includes('entry') || h === 'associate') return 'entry';
  if (h.includes('mid')) return 'mid';
  if (h.includes('director') || h.includes('executive')) return 'manager';
  return 'unspecified';
}

// points for (wanted level -> listing level). Missing entry means "drop".
const LEVEL_FIT = {
  any: { intern: 20, entry: 20, mid: 20, senior: 20, staff: 20, manager: 20, unspecified: 20 },
  intern: { intern: 20 },
  entry: { entry: 20, unspecified: 10, mid: 4 },
  mid: { mid: 20, unspecified: 14, entry: 8, senior: 6 },
  senior: { senior: 20, staff: 12, unspecified: 10, mid: 6, manager: 4 },
  staff: { staff: 20, senior: 10, manager: 6, unspecified: 6 },
  manager: { manager: 20, staff: 8, senior: 4, unspecified: 4 },
};

function scoreLevel(listing, p) {
  const level = detectLevel(listing.title, listing.levelHint, [p.role, ...p.expansions].join(' '));
  const pts = (LEVEL_FIT[p.seniority] || LEVEL_FIT.any)[level];
  if (pts === undefined) return { level, score: 0, drop: true, reason: `${LEVEL_LABEL[level]}, not ${LEVEL_LABEL[p.seniority] || p.seniority}` };
  const reason = p.seniority === 'any' ? null : (pts >= 20 ? `${LEVEL_LABEL[level]} level` : `${LEVEL_LABEL[level]}, close to what you want`);
  return { level, score: pts, reason };
}

// ===== location =====
const CITY_ALIASES = {
  'new york': ['new york', 'nyc', 'manhattan', 'brooklyn'],
  'san francisco': ['san francisco', 'sf', 'bay area', 'south san francisco', 'sf bay area'],
  'los angeles': ['los angeles', 'santa monica', 'culver city'],
  'washington dc': ['washington dc', 'washington d c', 'district of columbia', 'arlington va'],
  'seattle': ['seattle', 'bellevue', 'redmond', 'kirkland'],
  'boston': ['boston', 'cambridge ma', 'somerville'],
  'bengaluru': ['bengaluru', 'bangalore'],
  'mumbai': ['mumbai', 'bombay'],
  'gurugram': ['gurugram', 'gurgaon'],
  'san jose': ['san jose', 'santa clara', 'sunnyvale', 'mountain view', 'palo alto', 'menlo park', 'cupertino'],
};
const US_STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');
const COUNTRIES = {
  US: ['united states', 'usa', 'us', 'u s', 'america'],
  GB: ['united kingdom', 'uk', 'england', 'scotland', 'wales', 'london', 'manchester', 'edinburgh', 'cambridge uk'],
  CA: ['canada', 'toronto', 'vancouver', 'montreal', 'waterloo', 'ottawa'],
  IN: ['india', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'mumbai', 'delhi', 'gurugram', 'gurgaon', 'noida', 'chennai'],
  DE: ['germany', 'berlin', 'munich', 'hamburg', 'deutschland'],
  FR: ['france', 'paris'],
  IE: ['ireland', 'dublin'],
  NL: ['netherlands', 'amsterdam'],
  SG: ['singapore'],
  AU: ['australia', 'sydney', 'melbourne'],
  JP: ['japan', 'tokyo'],
};
const COUNTRY_INPUT = {
  'united states': 'US', usa: 'US', us: 'US', 'u s': 'US', america: 'US',
  'united kingdom': 'GB', uk: 'GB', england: 'GB', gb: 'GB',
  canada: 'CA', india: 'IN', germany: 'DE', france: 'FR', ireland: 'IE',
  netherlands: 'NL', singapore: 'SG', australia: 'AU', japan: 'JP',
};

function locationText(listing) {
  return [listing.location, ...(listing.locations || [])].filter(Boolean).join(' ; ');
}
function isRemote(listing) {
  if (listing.remote === true) return true;
  if (listing.workplace && /remote/i.test(listing.workplace)) return true;
  return /\b(remote|anywhere|work from home|wfh|distributed)\b/i.test(locationText(listing));
}
function inCountry(text, code) {
  const n = ` ${norm(text)} `;
  if ((COUNTRIES[code] || []).some((a) => n.includes(` ${a} `))) return true;
  if (code === 'US') {
    const re = new RegExp(`(,|\\s)\\s*(${US_STATES.join('|')})(\\b|$)`);
    if (re.test(text)) return true;
    if (/\b(new york|san francisco|seattle|austin|boston|chicago|los angeles|denver|atlanta)\b/i.test(text)) return true;
  }
  return false;
}
function otherCountry(text, code) {
  for (const c of Object.keys(COUNTRIES)) {
    if (c !== code && inCountry(text, c)) return c;
  }
  return null;
}

function scoreLocation(listing, p) {
  const text = locationText(listing);
  const remote = isRemote(listing);
  if (!p.places.length && !p.remoteOk) return { score: 15, remote, reason: null };
  if (!text && !remote) return { score: 5, remote, reason: 'location not listed' };
  const n = ` ${norm(text)} `;
  for (const place of p.places) {
    const key = norm(place);
    const code = COUNTRY_INPUT[key];
    if (code) {
      if (inCountry(text, code)) return { score: remote ? 16 : 14, remote, reason: `in ${place}` };
      continue;
    }
    const city = norm(place.split(',')[0]);
    const aliases = CITY_ALIASES[key] || CITY_ALIASES[city] ||
      Object.values(CITY_ALIASES).find((a) => a.includes(key) || a.includes(city)) || [key, city];
    if (aliases.some((a) => a && n.includes(` ${a} `))) return { score: 20, remote, reason: `in ${place}` };
  }
  if (remote && p.remoteOk) {
    const other = otherCountry(text, p.country);
    if (other) return { score: 6, remote, reason: `remote, but seems limited to ${other}` };
    return { score: 18, remote, reason: 'remote' };
  }
  return { score: 0, remote, drop: true, reason: `location (${text.slice(0, 60)}) not in your list` };
}

// ===== visa =====
const VISA_NO = [
  /\b(not|unable to|cannot|can ?not|can't|will not|won't|do not|does not|don't|are not able to|is not able to)\s+(be able to\s+)?(provide|offer|sponsor|support|consider)[^.\n]{0,60}(visa|sponsorship|immigration|work authori[sz]ation|h-?1b)/i,
  /\bno\s+(visa\s+|immigration\s+)?sponsorship\b/i,
  /\bsponsorship\s+(is\s+|will\s+)?not\s+(be\s+)?(available|provided|offered|possible)/i,
  /\bwithout\s+(the\s+need\s+for\s+|requiring\s+|need\s+of\s+)?(current\s+or\s+future\s+|employer\s+|company\s+)?(visa\s+)?sponsorship/i,
  /\b(u\.?s\.?|united states)\s+citizen(ship)?\s+(is\s+)?(required|only)/i,
  /\b(active|current)\s+(secret|top secret|ts\/sci|security)\s+clearance\b/i,
  /\bmust\s+be\s+(a\s+)?(u\.?s\.?|united states)\s+citizen/i,
];
const VISA_YES = [
  /\b(will|can|able to|happy to|we)\s+(provide|offer|sponsor|support)[^.\n]{0,40}(visa|sponsorship|immigration|h-?1b)/i,
  /\b(visa|immigration)\s+sponsorship\s+(is\s+)?(available|provided|offered|possible|supported)/i,
  /\bsponsorship\s+(is\s+)?available/i,
  /\bwe\s+sponsor\s+visas?\b/i,
  /\b(visa|relocation and visa|relocation & visa)\s+support\b/i,
  /\bopen to sponsoring\b/i,
];

function snippetAround(text, idx, len) {
  let start = idx;
  while (start > 0 && !/[.?!\n]/.test(text[start - 1]) && idx - start < 160) start--;
  let end = idx + len;
  while (end < text.length && !/[.?!\n]/.test(text[end]) && end - idx < 220) end++;
  return text.slice(start, end + 1).replace(/\s+/g, ' ').trim().slice(0, 240);
}

VISA_NO.push(/\b(unable to|cannot|can ?not|can't|will not|won't|do not|does not|not able to|not in a position to)\s+sponsor\b/i);

// Application forms ask "Are you authorized to work without sponsorship?".
// That is a question, not a policy, so skip matches inside questions.
function isQuestion(snippet) {
  return /\?/.test(snippet) || /\b(are|will|do|would) you\b/i.test(snippet);
}
function firstMatch(text, patterns) {
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) {
      const ev = snippetAround(text, m.index, m[0].length);
      if (!isQuestion(ev)) return ev;
    }
  }
  return null;
}
function detectVisa(text) {
  const t = String(text || '');
  if (!t) return { status: 'unknown', evidence: null };
  const no = firstMatch(t, VISA_NO);
  if (no) return { status: 'no', evidence: no };
  const yes = firstMatch(t, VISA_YES);
  if (yes) return { status: 'yes', evidence: yes };
  const opt = firstMatch(t, [/\b(STEM OPT|OPT|CPT)\b/]);
  if (opt) return { status: 'opt', evidence: opt };
  return { status: 'unknown', evidence: null };
}

function scoreVisa(listing, p) {
  const v = detectVisa(listing.description);
  if (p.visa !== 'need') return { ...v, score: 5, reason: null };
  if (v.status === 'no') return { ...v, score: 0, drop: p.hideNoSponsor, reason: 'says no visa sponsorship' };
  if (v.status === 'yes') return { ...v, score: 10, reason: 'mentions visa sponsorship' };
  if (v.status === 'opt') return { ...v, score: 7, reason: 'mentions OPT or CPT' };
  return { ...v, score: 3, reason: listing.description ? 'visa not mentioned' : 'visa unknown (no description read)' };
}

// ===== keywords =====
function scoreKeywords(listing, p) {
  const title = listing.title || '';
  const body = `${listing.description || ''} ${listing.department || ''}`;
  for (const ex of p.exclude) {
    if (wordRe(ex).test(title) || wordRe(ex).test(body)) return { score: 0, drop: true, reason: `contains excluded word "${ex}"` };
  }
  if (!p.keywords.length) return { score: 6, hits: [], reason: null };
  let score = 0;
  const hits = [];
  for (const kw of p.keywords) {
    if (wordRe(kw).test(title)) { score += 6; hits.push(kw); } else if (wordRe(kw).test(body)) { score += 3; hits.push(kw); }
  }
  return { score: Math.min(score, 12), hits, reason: hits.length ? `keywords: ${hits.join(', ')}` : 'none of your keywords found' };
}

// ===== freshness =====
function scoreFresh(listing, p, now) {
  if (!listing.postedAt) return { score: 2, days: null, reason: null };
  const days = Math.max(0, Math.floor((now - new Date(listing.postedAt).getTime()) / 86400000));
  if (p.postedWithinDays && days > p.postedWithinDays) return { score: 0, days, drop: true, reason: `posted ${days} days ago` };
  const score = days <= 3 ? 10 : days <= 7 ? 8 : days <= 14 ? 5 : days <= 30 ? 2 : 0;
  return { score, days, reason: days <= 7 ? `posted ${days === 0 ? 'today' : `${days}d ago`}` : null };
}

// ===== combine =====
function evaluate(listing, p, now = Date.now()) {
  const parts = {
    role: scoreRole(listing, p),
    level: scoreLevel(listing, p),
    location: scoreLocation(listing, p),
    visa: scoreVisa(listing, p),
    keywords: scoreKeywords(listing, p),
    fresh: scoreFresh(listing, p, now),
  };
  const dropped = Object.entries(parts).find(([, v]) => v.drop);
  const raw = Object.values(parts).reduce((s, v) => s + (v.score || 0), 0);
  return {
    score: Math.round((raw / 112) * 100),
    dropped: dropped ? `${dropped[0]}: ${dropped[1].reason}` : null,
    reasons: Object.values(parts).map((v) => v.reason).filter(Boolean),
    level: parts.level.level,
    remote: parts.location.remote,
    visa: { status: parts.visa.status, evidence: parts.visa.evidence },
    keywordHits: parts.keywords.hits || [],
    daysOld: parts.fresh.days,
  };
}

// ===== dedupe =====
function canonicalUrl(u) {
  const x = safeUrl(u);
  if (!x) return null;
  const gh = x.searchParams.get('gh_jid');
  let path = x.pathname.replace(/\/+$/, '').replace(/\/(apply|application)$/i, '');
  return `${x.hostname.replace(/^www\./, '').toLowerCase()}${path.toLowerCase()}${gh ? `?gh_jid=${gh}` : ''}`;
}
function contentKey(l) {
  return [norm(l.company), norm(l.title), norm((l.location || '').split(/[;,|]/)[0])].join('|');
}
function richness(l) {
  return (l.description ? l.description.length > 200 ? 3 : 1 : 0) + (l.postedAt ? 1 : 0) + (l.location ? 1 : 0) + (l.ats && l.ats !== 'web' ? 1 : 0);
}
function dedupe(listings) {
  const byUrl = new Map();
  const byContent = new Map();
  const groups = [];
  for (const l of listings) {
    const uk = canonicalUrl(l.url);
    const ck = contentKey(l);
    let g = (uk && byUrl.get(uk)) || byContent.get(ck);
    if (!g) {
      g = { best: l, sources: new Set(), urls: new Set() };
      groups.push(g);
    } else if (richness(l) > richness(g.best)) {
      g.best = { ...l, company: l.company || g.best.company };
    }
    for (const s of l.sources || []) g.sources.add(s);
    if (uk) { byUrl.set(uk, g); g.urls.add(uk); }
    byContent.set(ck, g);
  }
  return {
    listings: groups.map((g) => ({ ...g.best, key: canonicalUrl(g.best.url) || contentKey(g.best), sources: [...g.sources] })),
    removed: listings.length - groups.length,
  };
}

// ===== prefs =====
const LEVELS = ['any', 'intern', 'entry', 'mid', 'senior', 'staff', 'manager'];
function list(v, re, max, len = 80) {
  const arr = Array.isArray(v) ? v : String(v || '').split(re);
  return arr.map((s) => String(s).trim()).filter(Boolean).map((s) => s.slice(0, len)).slice(0, max);
}
function normalizePrefs(raw = {}) {
  const role = String(raw.role || '').trim().slice(0, 100);
  if (!role) throw new Error('Add a role, for example "software engineer".');
  const locations = list(raw.locations, /[;\n|]/, 8);
  const places = locations.filter((l) => !/^remote\b/i.test(l));
  const remoteOk = !!raw.remoteOk || locations.some((l) => /^remote\b/i.test(l));
  const visa = raw.visa === 'need' ? 'need' : 'any';
  const country = /^[A-Z]{2}$/.test(String(raw.country || '').toUpperCase()) ? String(raw.country).toUpperCase() : 'US';
  const days = Number.parseInt(raw.postedWithinDays, 10);
  const agents = Number.parseInt(raw.maxAgentRuns, 10);
  return {
    role,
    expansions: roleExpansions(role),
    seniority: LEVELS.includes(raw.seniority) ? raw.seniority : 'any',
    locations,
    places,
    remoteOk,
    country,
    visa,
    hideNoSponsor: visa === 'need' && raw.hideNoSponsor !== false,
    keywords: list(raw.keywords, /[,;\n]/, 10, 40),
    exclude: list(raw.exclude, /[,;\n]/, 10, 40),
    companies: list(raw.companies, /[\n;,]/, 15, 300),
    postedWithinDays: Number.isFinite(days) ? Math.min(Math.max(days, 0), 180) : 30,
    maxAgentRuns: Number.isFinite(agents) ? Math.min(Math.max(agents, 0), 6) : 2,
    discover: raw.discover !== false,
  };
}

module.exports = {
  normalizePrefs, evaluate, dedupe, canonicalUrl, detectLevel, detectVisa, scoreLocation,
  isRemote, roleExpansions, LEVEL_LABEL, norm, toks,
};
