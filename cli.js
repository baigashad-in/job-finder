#!/usr/bin/env node
'use strict';
// Run one search from the terminal.
// node cli.js --role "software engineer" --level intern --locations "New York; Remote" \
//   --visa need --companies "Stripe, Figma" --keywords "python, backend" --agents 2 --out results.json

const fs = require('fs');
const { TinyFish } = require('./src/tinyfish');
const { runPipeline } = require('./src/pipeline');
const store = require('./src/store');

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[k] = v;
  }
  return out;
}

async function main() {
  const a = args(process.argv);
  if (!a.role) {
    console.log('Usage: node cli.js --role "data analyst" [--level intern|entry|mid|senior|staff|manager]');
    console.log('       [--locations "Boston; London; Remote"] [--country GB (for remote; cities pick their own)] [--visa need] [--keywords "sql, python"]');
    console.log('       [--exclude "clearance"] [--companies "Stripe, https://careers.example.com"] [--days 30]');
    console.log('       [--agents 2] [--no-discover] [--refresh] [--top 25] [--out results.json]');
    process.exit(1);
  }
  const prefs = {
    role: a.role, seniority: a.level || 'any', locations: a.locations || '', country: a.country || '',
    visa: a.visa === 'need' ? 'need' : 'any', keywords: a.keywords || '', exclude: a.exclude || '',
    companies: a.companies || '', postedWithinDays: a.days || 30, maxAgentRuns: a.agents ?? 2,
    discover: !a['no-discover'],
  };
  // First Ctrl+C stops the search the same way the Stop button does: running Agent runs are
  // cancelled on TinyFish and the jobs read so far are still shown. A second Ctrl+C quits.
  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130);
    console.error('\nStopping: cancelling running Agent runs and showing what was read. Press Ctrl+C again to quit at once.');
    controller.abort();
  });
  const tf = new TinyFish({ log: (m) => console.error(`  ! ${m}`), signal: controller.signal });
  const r = await runPipeline(prefs, { tf, store, force: !!a.refresh, log: (k, m, x) => console.error(`[${k}] ${m}${x && x.link ? ` ${x.link}` : ''}`) });
  const top = Number(a.top || 25);
  console.log('');
  for (const l of r.listings.slice(0, top)) {
    const tags = [l.isNew ? 'NEW' : '', l.remote ? 'remote' : '', l.visa.status !== 'unknown' ? `visa:${l.visa.status}` : ''].filter(Boolean).join(' ');
    console.log(`${String(l.score).padStart(3)}  ${l.title}  (${l.company}, ${l.location || 'location n/a'}) ${tags}`);
    console.log(`     ${l.applyUrl}`);
  }
  console.log(`\n${r.counts.matched} matches from ${r.counts.unique} unique jobs. Filtered out: ${JSON.stringify(r.filteredOut)}`);
  console.log(`TinyFish usage: ${JSON.stringify(r.usage)}`);
  if (r.warnings.length) console.log(`Notes:\n  ${r.warnings.join('\n  ')}`);
  if (a.out) { fs.writeFileSync(a.out, JSON.stringify(r, null, 2)); console.log(`Saved ${a.out}`); }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
