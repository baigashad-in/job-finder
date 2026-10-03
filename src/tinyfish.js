'use strict';
// Thin REST client for the three TinyFish APIs this app uses.
// Endpoints and fields follow docs.tinyfish.ai (checked Oct 2026):
//   Search: GET  https://api.search.tinyfish.ai            (free)
//   Fetch:  POST https://api.fetch.tinyfish.ai             (free, max 10 URLs per call)
//   Agent:  POST https://agent.tinyfish.ai/v1/automation/run-async, GET /v1/runs/{id} (uses credits)
// Base URLs can be overridden with env vars so tests can point at a local mock.


const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TinyFishError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

class TinyFish {
  constructor({ apiKey, log } = {}) {
    this.apiKey = apiKey || process.env.TINYFISH_API_KEY;
    if (!this.apiKey) throw new Error('TINYFISH_API_KEY is not set');
    this.log = log || (() => {});
    this.searchUrl = process.env.TINYFISH_SEARCH_URL || 'https://api.search.tinyfish.ai';
    this.fetchUrl = process.env.TINYFISH_FETCH_URL || 'https://api.fetch.tinyfish.ai';
    this.agentUrl = (process.env.TINYFISH_AGENT_URL || 'https://agent.tinyfish.ai').replace(/\/$/, '');
    this.stats = {
      search: { calls: 0, results: 0, errors: 0 },
      fetch: { calls: 0, urls: 0, ok: 0, failed: 0 },
      agent: { runs: 0, completed: 0, failed: 0, cached: 0, steps: 0 },
    };
  }

  async _request(url, { method = 'GET', body, timeoutMs = 30000, retries = 2 } = {}) {
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            'X-API-Key': this.apiKey,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < retries) {
          attempt++;
          await sleep(800 * attempt);
          continue;
        }
        const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : err.message;
        throw new TinyFishError(`${method} ${url} failed: ${reason}`, 0);
      }
      clearTimeout(timer);
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non JSON body */ }
      if (res.ok) return json;
      if (RETRY_STATUS.has(res.status) && attempt < retries) {
        attempt++;
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 15000) : 1500 * attempt;
        this.log(`TinyFish returned ${res.status}, retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      const msg = (json && (json.message || json.error?.message || json.error)) || text.slice(0, 200);
      throw new TinyFishError(`${method} ${url} returned ${res.status}: ${msg}`, res.status, json);
    }
  }

  // Search API. params: query, location, language, include_domains (array or string),
  // exclude_domains, recency_minutes, page, purpose.
  async search(params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    this.stats.search.calls++;
    try {
      const json = await this._request(`${this.searchUrl}?${qs}`, { timeoutMs: 15000 });
      const results = (json && json.results) || [];
      this.stats.search.results += results.length;
      return results;
    } catch (err) {
      this.stats.search.errors++;
      throw err;
    }
  }

  // Fetch API. Splits into batches of 10 (the API max). Returns { results, errors }.
  async fetchUrls(urls, { format = 'markdown', links = false, ttl, purpose, perUrlTimeoutMs = 60000 } = {}) {
    const out = { results: [], errors: [] };
    for (let i = 0; i < urls.length; i += 10) {
      const batch = urls.slice(i, i + 10);
      const body = { urls: batch, format, links, per_url_timeout_ms: perUrlTimeoutMs };
      if (ttl !== undefined) body.ttl = ttl;
      if (purpose) body.purpose = purpose.slice(0, 1990);
      this.stats.fetch.calls++;
      this.stats.fetch.urls += batch.length;
      try {
        // Docs: 110s per URL backend limit and 120s CDN ceiling, so client waits 150s.
        const json = await this._request(this.fetchUrl, { method: 'POST', body, timeoutMs: 150000, retries: 1 });
        const results = (json && json.results) || [];
        const errors = (json && json.errors) || [];
        this.stats.fetch.ok += results.length;
        this.stats.fetch.failed += errors.length;
        out.results.push(...results);
        out.errors.push(...errors);
      } catch (err) {
        this.stats.fetch.failed += batch.length;
        for (const u of batch) out.errors.push({ url: u, error: 'request_failed', message: err.message });
      }
    }
    return out;
  }

  // Agent API. Starts an async run, polls until it finishes, cancels it if it runs too long.
  async agentRun(body, { maxWaitMs = 180000, pollMs = Number(process.env.AGENT_POLL_MS || 4000), onProgress } = {}) {
    this.stats.agent.runs++;
    const start = await this._request(`${this.agentUrl}/v1/automation/run-async`, {
      method: 'POST', body, timeoutMs: 30000, retries: 1,
    });
    const runId = start && start.run_id;
    if (!runId) {
      this.stats.agent.failed++;
      throw new TinyFishError(`Agent run was not created: ${JSON.stringify(start && start.error)}`, 0, start);
    }
    const deadline = Date.now() + maxWaitMs;
    let lastStatus = '';
    while (Date.now() < deadline) {
      await sleep(pollMs);
      let run;
      try {
        run = await this._request(`${this.agentUrl}/v1/runs/${encodeURIComponent(runId)}`, { timeoutMs: 20000 });
      } catch (err) {
        this.log(`Polling run ${runId} failed once: ${err.message}`);
        continue;
      }
      if (run && run.status !== lastStatus) {
        lastStatus = run.status;
        if (onProgress) onProgress(run.status, run);
      }
      if (run && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
        if (run.num_of_steps) this.stats.agent.steps += run.num_of_steps;
        if (run.status === 'COMPLETED') this.stats.agent.completed++;
        else this.stats.agent.failed++;
        return run;
      }
    }
    // Too slow: cancel so it stops using credits.
    try {
      await this._request(`${this.agentUrl}/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', timeoutMs: 15000, retries: 0 });
    } catch { /* best effort */ }
    this.stats.agent.failed++;
    return { run_id: runId, status: 'CANCELLED', result: null, error: { message: `Stopped after ${Math.round(maxWaitMs / 1000)}s` } };
  }
}

module.exports = { TinyFish, TinyFishError };
