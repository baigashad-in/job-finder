'use strict';

// Run fn over items with at most n in flight. Keeps result order.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// Turns "Posted 3 Days Ago", "Posted Today", "Yesterday", "30+ days ago",
// "2026-09-28" or "Sep 28, 2026" into an ISO date. Returns null if unsure.
function parsePostedText(s, now = Date.now()) {
  if (!s) return null;
  const t = String(s).toLowerCase().trim();
  const day = 86400000;
  if (/\b(today|just posted|just now|hours? ago|minutes? ago)\b/.test(t)) return new Date(now).toISOString();
  if (/\byesterday\b/.test(t)) return new Date(now - day).toISOString();
  let m = t.match(/(\d+)\+?\s*(day|week|month)s?\s+ago/);
  if (m) {
    const n = Number(m[1]);
    const mult = m[2] === 'day' ? 1 : m[2] === 'week' ? 7 : 30;
    return new Date(now - n * mult * day).toISOString();
  }
  m = t.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) {
    const d = new Date(m[1]);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const cleaned = t.replace(/^(posted|posted on|date posted|published)[:\s]*/, '');
  const d = new Date(cleaned);
  if (!Number.isNaN(d.getTime()) && d.getFullYear() > 2015 && d.getTime() <= now + day) return d.toISOString();
  return null;
}

const IRREGULAR = { company: 'companies', query: 'queries', match: 'matches', 'careers site': 'careers sites', 'TinyFish Search query': 'TinyFish Search queries' };
// plural(1, 'job') -> "1 job", plural(3, 'company') -> "3 companies"
function plural(n, word) {
  return `${n} ${n === 1 ? word : IRREGULAR[word] || `${word}s`}`;
}

module.exports = { pool, parsePostedText, plural };
