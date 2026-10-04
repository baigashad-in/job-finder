#!/usr/bin/env node
'use strict';
// Shows what TinyFish Fetch returns for one URL, to diagnose pages the app cannot read.
//   node --env-file=.env debug-fetch.js "https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers" "software engineer"
// With a second argument and no "?" in the URL, it adds ?q=<words> (Workday search).
// It never prints your API key.

const { TinyFish } = require('./src/tinyfish');

async function main() {
  let url = process.argv[2];
  const words = process.argv[3];
  if (!url) {
    console.log('Usage: node --env-file=.env debug-fetch.js "<url>" ["search words"]');
    process.exit(1);
  }
  if (words && !url.includes('?')) url = `${url.replace(/\/$/, '')}?q=${encodeURIComponent(words)}`;
  console.log(`Fetching ${url}\n`);
  const tf = new TinyFish();
  const res = await tf.fetchUrls([url], { ttl: 0, links: true, perUrlTimeoutMs: 90000 });
  if (res.errors.length) {
    console.log('Fetch error:', JSON.stringify(res.errors[0]));
    return;
  }
  const r = res.results[0];
  if (!r) { console.log('No result returned.'); return; }
  const text = typeof r.text === 'string' ? r.text : '';
  const mdLinks = [...text.matchAll(/\[([^\]]{1,200})\]\(([^)\s]+)\)/g)];
  const mdJobLinks = mdLinks.filter((m) => /\/job\//.test(m[2]));
  const links = Array.isArray(r.links) ? r.links : [];
  const jobLinks = links.filter((u) => /\/job\//.test(u));

  console.log(`final_url:        ${r.final_url}`);
  console.log(`title:            ${r.title}`);
  console.log(`text length:      ${text.length} characters`);
  console.log(`links in text:    ${mdLinks.length} (${mdJobLinks.length} contain /job/)`);
  console.log(`links list:       ${links.length} (${jobLinks.length} contain /job/)`);
  if (mdJobLinks.length) console.log(`\nFirst job links in text:\n  ${mdJobLinks.slice(0, 5).map((m) => `[${m[1]}] ${m[2]}`).join('\n  ')}`);
  if (jobLinks.length) console.log(`\nFirst job links in list:\n  ${jobLinks.slice(0, 5).join('\n  ')}`);
  console.log(`\nFirst 1500 characters of text:\n${text.slice(0, 1500)}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
