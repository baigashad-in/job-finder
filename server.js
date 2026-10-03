'use strict';
// Job finder server. No dependencies, Node 18+.
//   TINYFISH_API_KEY=... node server.js      then open http://localhost:3000
// Env: PORT (3000), HOST (127.0.0.1), REFRESH_HOURS (0 = off), DATA_DIR (./data)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TinyFish } = require('./src/tinyfish');
const { runPipeline } = require('./src/pipeline');
const { normalizePrefs } = require('./src/match');
const store = require('./src/store');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const REFRESH_HOURS = Number(process.env.REFRESH_HOURS || 0);
const VERSION = '3.0.0';
const INDEX = path.join(__dirname, 'public', 'index.html');

const tasks = new Map(); // id -> { status, log, result, error, startedAt }

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100000) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function startTask(prefs, { force = false, label = 'search' } = {}) {
  const running = [...tasks.values()].filter((t) => t.status === 'running').length;
  if (running >= 2) throw Object.assign(new Error('Two searches are already running. Wait for one to finish.'), { code: 429 });
  normalizePrefs(prefs); // validate early so the user sees input errors immediately
  const id = crypto.randomBytes(6).toString('hex');
  const task = { id, label, status: 'running', log: [], result: null, error: null, startedAt: Date.now() };
  tasks.set(id, task);
  const log = (kind, msg, extra) => {
    task.log.push({ t: Date.now() - task.startedAt, kind, msg, link: extra && extra.link ? String(extra.link) : undefined });
    if (task.log.length > 400) task.log.shift();
  };
  (async () => {
    try {
      const tf = new TinyFish({ log: (m) => log('warn', m) });
      const result = await runPipeline(prefs, { tf, store, log, force });
      store.saveLatest(result.searchId, result);
      store.touchSearch(result.searchId, { matched: result.counts.matched, fresh: result.counts.newSinceLastRun });
      task.result = result;
      task.status = 'done';
    } catch (err) {
      task.error = err.message;
      task.status = 'error';
      log('error', err.message);
    }
  })();
  return id;
}

// Old tasks are dropped after an hour.
setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [id, t] of tasks) if (t.startedAt < cutoff && t.status !== 'running') tasks.delete(id);
}, 600000).unref();

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(result) {
  const head = ['score', 'title', 'company', 'location', 'level', 'remote', 'visa', 'posted', 'new', 'apply_url', 'why'];
  const rows = result.listings.map((l) => [
    l.score, l.title, l.company, l.location, l.levelLabel, l.remote ? 'yes' : '', l.visa.status,
    l.postedAt ? l.postedAt.slice(0, 10) : '', l.isNew ? 'yes' : '', l.applyUrl, l.reasons.join('; '),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    if (parts[0] !== 'api') return json(res, 404, { error: 'Not found' });

    if (req.method === 'GET' && parts[1] === 'status') {
      return json(res, 200, { hasKey: !!process.env.TINYFISH_API_KEY, refreshHours: REFRESH_HOURS, version: VERSION });
    }
    if (req.method === 'POST' && parts[1] === 'search') {
      if (!process.env.TINYFISH_API_KEY) return json(res, 400, { error: 'Set TINYFISH_API_KEY before starting the server.' });
      const body = await readBody(req);
      return json(res, 202, { taskId: startTask(body.prefs || {}, { force: !!body.force }) });
    }
    if (req.method === 'GET' && parts[1] === 'task' && parts[2]) {
      const t = tasks.get(parts[2]);
      if (!t) return json(res, 404, { error: 'Task not found or expired' });
      if (parts[3] === 'csv') {
        if (!t.result) return json(res, 409, { error: 'Task has no result yet' });
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="jobs.csv"' });
        return res.end(toCsv(t.result));
      }
      const since = Number(url.searchParams.get('since') || 0);
      return json(res, 200, { status: t.status, error: t.error, log: t.log.slice(since), logTotal: t.log.length, result: t.status === 'done' ? t.result : null });
    }
    if (parts[1] === 'searches') {
      if (req.method === 'GET' && !parts[2]) return json(res, 200, store.listSearches());
      if (req.method === 'POST' && !parts[2]) {
        const body = await readBody(req);
        const p = normalizePrefs(body.prefs || {});
        const id = store.saveSearch(String(body.name || '').slice(0, 80), { ...body.prefs, role: p.role }, store.searchIdFor(p));
        return json(res, 201, { id });
      }
      if (req.method === 'DELETE' && parts[2]) { store.deleteSearch(parts[2]); return json(res, 200, { ok: true }); }
      if (req.method === 'GET' && parts[2] && parts[3] === 'latest') {
        const r = store.getLatest(parts[2]);
        return r ? json(res, 200, r) : json(res, 404, { error: 'This search has not run yet' });
      }
      if (req.method === 'POST' && parts[2] && parts[3] === 'run') {
        const s = store.listSearches().find((x) => x.id === parts[2]);
        if (!s) return json(res, 404, { error: 'Saved search not found' });
        const body = await readBody(req);
        return json(res, 202, { taskId: startTask(s.prefs, { force: !!body.force, label: s.name }) });
      }
    }
    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    return json(res, err.code === 429 ? 429 : 400, { error: err.message });
  }
});

// Optional: re-run every saved search on a schedule so results stay fresh.
async function refreshAll() {
  const all = store.listSearches();
  for (const s of all) {
    try {
      const tf = new TinyFish();
      const r = await runPipeline(s.prefs, { tf, store, force: true });
      store.saveLatest(r.searchId, r);
      store.touchSearch(r.searchId, { matched: r.counts.matched, fresh: r.counts.newSinceLastRun });
      console.log(`[refresh] ${s.name}: ${r.counts.matched} matches, ${r.counts.newSinceLastRun} new`);
    } catch (err) {
      console.log(`[refresh] ${s.name} failed: ${err.message}`);
    }
  }
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Job finder running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (!process.env.TINYFISH_API_KEY) console.log('Warning: TINYFISH_API_KEY is not set. Get one at https://agent.tinyfish.ai/api-keys');
    if (REFRESH_HOURS > 0 && process.env.TINYFISH_API_KEY) {
      console.log(`Saved searches refresh every ${REFRESH_HOURS}h`);
      setInterval(refreshAll, REFRESH_HOURS * 3600000);
    }
  });
}

module.exports = { server, toCsv };
