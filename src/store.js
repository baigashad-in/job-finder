'use strict';
// Small JSON file store. No database needed for a personal tool.
// data/searches.json  saved searches
// data/seen.json      { searchId: { jobKey: firstSeenIso } }  powers "new since last run"
// data/agent-cache.json  Agent results by (url + goal), so re-runs do not spend credits
// data/latest/<searchId>.json  last result of each saved search

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let tmpCounter = 0;

// Write to a temporary file, then rename it over the real one, so a crash never leaves
// half a file. On Windows the rename can fail with EPERM, EACCES or EBUSY while another
// program (often antivirus) has the file open for a moment, so retry a few times and,
// if it still fails, write the file directly.
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const body = JSON.stringify(value, null, 1);
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  fs.writeFileSync(tmp, body);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      sleepSync(30 * (attempt + 1));
    }
  }
  fs.writeFileSync(file, body);
  try { fs.unlinkSync(tmp); } catch { /* leftover temp file is harmless */ }
}
function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}

// Same preferences give the same id, so a repeat search can show what is new.
function searchIdFor(p) {
  const { maxAgentRuns, expansions, ...rest } = p;
  return hash(JSON.stringify(rest));
}

const files = {
  searches: () => path.join(DIR, 'searches.json'),
  seen: () => path.join(DIR, 'seen.json'),
  agent: () => path.join(DIR, 'agent-cache.json'),
  latest: (id) => path.join(DIR, 'latest', `${id.replace(/[^a-z0-9]/gi, '')}.json`),
};

module.exports = {
  DIR,
  hash,
  searchIdFor,

  listSearches() {
    return readJson(files.searches(), []);
  },
  // id must come from normalised prefs (searchIdFor(normalizePrefs(raw))) so it matches pipeline runs.
  saveSearch(name, prefs, id) {
    const all = this.listSearches();
    const existing = all.find((s) => s.id === id);
    if (existing) {
      existing.name = name || existing.name;
      existing.prefs = prefs;
    } else {
      all.push({ id, name: name || prefs.role, prefs, createdAt: new Date().toISOString(), lastRunAt: null });
    }
    writeJson(files.searches(), all);
    return id;
  },
  deleteSearch(id) {
    writeJson(files.searches(), this.listSearches().filter((s) => s.id !== id));
  },
  touchSearch(id, summary) {
    const all = this.listSearches();
    const s = all.find((x) => x.id === id);
    if (s) {
      s.lastRunAt = new Date().toISOString();
      s.lastSummary = summary;
      writeJson(files.searches(), all);
    }
  },

  // Returns { firstRun, isNew(key) } and records all keys as seen.
  markSeen(searchId, keys) {
    const all = readJson(files.seen(), {});
    const prev = all[searchId] || {};
    const firstRun = Object.keys(prev).length === 0;
    const now = new Date().toISOString();
    const fresh = new Set();
    for (const k of keys) {
      if (!prev[k]) { fresh.add(k); prev[k] = now; }
    }
    all[searchId] = prev;
    writeJson(files.seen(), all);
    return { firstRun, isNew: (k) => !firstRun && fresh.has(k), firstSeen: (k) => prev[k] };
  },

  // Same answers as markSeen, without saving. A stopped search only read part of the
  // boards, so saving would make the next full search call jobs "new" that are not.
  peekSeen(searchId, keys) {
    const prev = readJson(files.seen(), {})[searchId] || {};
    const firstRun = Object.keys(prev).length === 0;
    return { firstRun, isNew: (k) => !firstRun && !prev[k], firstSeen: (k) => prev[k] || null };
  },

  getAgentCache(key, maxAgeHours) {
    const all = readJson(files.agent(), {});
    const hit = all[key];
    if (!hit) return null;
    if (Date.now() - new Date(hit.at).getTime() > maxAgeHours * 3600000) return null;
    return hit.value;
  },
  setAgentCache(key, value) {
    const all = readJson(files.agent(), {});
    all[key] = { at: new Date().toISOString(), value };
    // keep the cache small
    const keys = Object.keys(all);
    if (keys.length > 200) {
      keys.sort((a, b) => new Date(all[a].at) - new Date(all[b].at));
      for (const k of keys.slice(0, keys.length - 200)) delete all[k];
    }
    writeJson(files.agent(), all);
  },

  saveLatest(searchId, result) {
    writeJson(files.latest(searchId), result);
  },
  getLatest(searchId) {
    return readJson(files.latest(searchId), null);
  },
};
