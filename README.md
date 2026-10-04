# Job Finder

**Live link:** _add URL after deploy (see "Deploying a live demo" below)_

A job and internship finder for students. **TinyFish Search** finds which companies are hiring for your role, **TinyFish Fetch** reads each company's full job board and the posting pages behind the best matches, Fetch also reads Workday search results pages, and **TinyFish Agent** browses the careers sites Fetch cannot read (custom pages, Workable, Ashby job boards, and Workday sites where Fetch fails). The app then matches every opening to your role, level, location and visa needs, removes duplicates, ranks the rest with reasons, and marks what is new since your last check.

## Demo video

_Add a 60 to 90 second GIF or MP4 after a live run._ Suggested shots:

1. Type a real search ("software engineer, intern, New York; Remote, need sponsorship"), add two companies you follow, press **Find jobs**.
2. The progress log: Search finding boards, Fetch reading them, the Agent browsing a custom careers site, with its **Watch live** link open in a second tab.
3. Results: match score, reasons, a visa chip with the quoted sentence, **Apply** opening the real posting.
4. "Where these came from": which API read each company, and how many jobs each filter removed.
5. Run it again: the Agent result comes from cache (0 credits) and **New only** shows only fresh postings.

## How TinyFish is called

The app calls the REST endpoints directly so it has zero dependencies. Every request body was checked against the official `@tiny-fish/sdk` 0.8.0 schemas.

**Search** finds job boards (`src/discover.js`):

```js
const results = await tf.search({
  query: q.query,                    // "software engineer intern New York"
  include_domains: ATS_DOMAINS,      // greenhouse, lever, ashby, smartrecruiters, workday, workable
  location: p.country,
  recency_minutes: q.recency_minutes,
  purpose: `Find open ${p.role} job postings on company job boards`,
});
```

**Fetch** reads every open job at each company in one batch (`src/read.js`, `src/tinyfish.js`):

```js
// POST https://api.fetch.tinyfish.ai, up to 10 URLs per request, batches run in parallel
const body = { urls: batch, format: 'markdown', links: false, per_url_timeout_ms: 60000, ttl, purpose };
```

**Agent** browses sites with no feed and returns structured JSON (`src/agent.js`):

```js
// POST https://agent.tinyfish.ai/v1/automation/run-async, then poll GET /v1/runs/{id}
const body = {
  url: target.url,                   // a careers site Fetch could not read
  goal,                              // "search for 'intern software engineer', set a simple
                                     //  location box if there is one, read the first page only,
                                     //  return title, location, posted, url... If you hit a
                                     //  captcha, set blocked to true."
  output_schema: OUTPUT_SCHEMA,      // { blocked, jobs: [{ title, location, posted, url, department }] }
  browser_profile: stealth ? 'stealth' : 'lite',
  agent_config: { max_duration_seconds: 180 },
};
if (stealth) body.proxy_config = { enabled: true, country_code: 'US' };
```

## How to run

Needs Node 18 or newer. Nothing to install.

```bash
export TINYFISH_API_KEY="your key from https://agent.tinyfish.ai/api-keys"
npm start
# open http://localhost:3000
```

Or copy `.env.example` to `.env` and run `npm run start:env` (Node 20.6 or newer).

Environment variables:

* `TINYFISH_API_KEY` (required): covers Search, Fetch and Agent.
* `PORT` (3000) and `HOST` (127.0.0.1, so only your computer can reach it).
* `REFRESH_HOURS` (0, off): re-run every saved search on this schedule.
* `AGENT_RUNS_LIMIT` (6): most Agent runs per search for everyone on this server.
* `MAX_BOARDS` (40): job boards read per search. `ENRICH_LIMIT` (20): posting pages read per search.
* `AGENT_CACHE_HOURS` (12), `AGENT_MAX_WAIT_SECONDS` (200, counted from when a run starts), `AGENT_MAX_PENDING_SECONDS` (180, time a run may wait in the TinyFish queue), `AGENT_STEALTH_RETRY` (1).
* `DATA_DIR` (./data): saved searches, seen jobs and the Agent cache.

Command line version:

```bash
node cli.js --role "data analyst" --level entry --locations "Chicago; Remote" \
  --visa need --keywords "sql, tableau" --companies "Stripe, Figma" --agents 0 --out results.json
```

Tests (no network or credits needed): `npm test`

See what Fetch returns for one page (useful when a site reads 0 jobs):

```bash
node --env-file=.env debug-fetch.js "https://company.wd5.myworkdayjobs.com/en-US/Site" "software engineer"
node --env-file=.env debug-fetch.js "https://api.lever.co/v0/postings/COMPANY?mode=json" --html
node --env-file=.env debug-fetch.js "https://api.ashbyhq.com/posting-api/job-board/COMPANY" --json
```

## Architecture

```
Browser: public/index.html
  |  POST /api/search, then polls GET /api/task/:id for progress and results
  v
server.js  (Node, no dependencies; the API key never leaves the server)
  |
  v
src/pipeline.js
  1. discover.js  -> TinyFish Search   job boards for your role, watchlist company lookup
  2. read.js      -> TinyFish Fetch    each board's full public job feed
  3. read.js      -> TinyFish Fetch    Workday search results pages (?q=role)
     agent.js     -> TinyFish Agent    sites Fetch could not read: custom pages,
                                       Workable, Ashby boards, Workday pages with
                                       no job links
                                       (capped, cached 12h, 2 at a time, slow runs
                                        cancelled, one stealth retry only if blocked)
  4. match.js                          merge duplicates found by different sources
  5. read.js      -> TinyFish Fetch    top posting pages: visa wording, dates, closed jobs
  6. match.js                          score, filter, rank, mark "new since last run"
  |
  v
data/  saved searches, seen jobs, Agent cache (JSON files)
```

## Deploying a live demo

The server needs a host that keeps a Node process running, such as Render, Railway or Fly.io. Searches run as background tasks in memory, so serverless platforms (like Vercel functions) will not work without changes.

Before you make it public:

* Set `HOST=0.0.0.0` so the host can reach it.
* Set `AGENT_RUNS_LIMIT=1` or `0`. Every visitor's search spends your Agent credits; Search and Fetch stay free.
* Saved searches and "new since last run" are shared by everyone using the server. There are no user accounts.

## What each TinyFish API does here

**Search (free)** asks each job system separately (Greenhouse, Lever, Ashby, Workday, then SmartRecruiters and Workable), using `include_domains`, because one combined query returns only 10 results and one system can crowd out the rest. The search country follows the first city you type (Bangalore searches India), since a city is more specific than the country dropdown. An extra query across all systems uses `recency_minutes` so recent postings surface first. A single hit like `job-boards.greenhouse.io/acme/jobs/123` tells the app Acme has a Greenhouse board, so it reads the whole board, not just that posting. Search also turns company names in your watchlist into their real job boards, and finds a company's own careers page when it has no job-system board (LinkedIn, Indeed and other aggregators excluded).

**Fetch (free)** reads the public JSON feed that Greenhouse, Lever, Ashby and SmartRecruiters publish for each company: every open job with title, location, date and usually the full description. Lever and Ashby feeds hold raw HTML inside their JSON, which can break when converted to markdown, so a feed that does not parse is fetched again as HTML and the JSON is taken from that. If that fails too (Ashby feeds come back as only their description HTML), Fetch's `json` format is tried, and a board that still yields nothing goes to the Agent. It also confirms a watchlist company's board by trying its likely feed URLs, falls back to the human board page if a feed cannot be parsed, reads Workday search results pages (`?q=software engineer`, plus a second query with your city, taking job links from the page text or from Fetch's separate links list, and matching each link to its line of text for the real title and posted date), and reads the posting pages of top matches that have no description yet. That page text drives visa detection, keyword matching and removal of closed postings. Normal runs accept a cache entry up to 1 hour old (`ttl: 3600`); **Skip caches** sends `ttl: 0`.

**Agent (uses credits)** handles sites that need a real browser: custom careers pages with a search box, Workable, Ashby job boards (JavaScript apps that Fetch sees as empty), and Workday sites whose search page Fetch could not read. On a job board it only reads the list and keeps titles that fit your role. It returns structured JSON through `output_schema`. While it runs, the progress log shows a **Watch live** link to the Agent's browser. On Workday sites the Agent starts on the results page already filtered by your role and only reads the list. Spending is controlled: runs are capped per search (your watchlist first) and run two at a time, the app stops starting new runs after two fail with none succeeding, results are cached for 12 hours, a run is cancelled if it takes longer than 200 seconds once started or waits too long in the queue, and it is retried once in `stealth` mode with a proxy only if the site explicitly blocked it. Only `http` and `https` links from Agent results are kept.

## How matching works

Every job gets points for each of these, and some rules remove a job completely. The reasons are shown on each result.

* **Role (40 points).** The title must contain your role or a closely related title. "Software engineer" also matches "backend engineer", "full stack developer" and "member of technical staff". Titles that are clearly a different job (recruiter, sales, marketing, legal) are removed even when they mention your role, so "Technical Recruiter, Software Engineering" does not show up for a software engineer search.
* **Level (20 points).** Read from the title: intern, entry or new grad, mid, senior, staff and above, manager. "Software Engineer I" is entry, "II" is mid. An intern search only keeps internships and co-ops. A new grad search removes senior roles.
* **Location (20 points).** City nicknames work (NYC, SF, Bay Area, Bangalore). Countries work ("United States" matches "Austin, TX"). If you allow remote, remote jobs count, but "Remote, Canada" scores low for a US search.
* **Visa (10 points).** The app reads the description and labels each job as **mentions sponsorship**, **mentions OPT/CPT**, **no sponsorship** (including "must be a US citizen" and security clearance), or **not mentioned**. It shows the sentence it found. Application form questions like "Are you authorized to work without sponsorship?" are ignored, because they are questions, not policy. If you need sponsorship, jobs that say no are hidden (you can turn this off).
* **Keywords (12 points)** count more in the title than in the description. **Hidden words** remove a job.
* **Freshness (10 points).** Newer postings rank higher. Postings older than your "posted within" setting are removed.

**Duplicates** are merged when two results share the same cleaned link, or the same company, title and location. The merged row keeps the most complete copy and lists every source that found it.

Below the results, the app tells you how many jobs were removed for each reason, so an empty result explains itself ("location (120)") and suggests what to change.

## Keeping results fresh

* **New since last run.** The app remembers which jobs each search has shown. On later runs, jobs it has not seen before get a **New** label and a **New only** filter.
* **Saved searches** keep your preferences and last results. Start the server with `REFRESH_HOURS=24` to re-run every saved search on a schedule.
* **Closed postings** found while reading pages are removed.

## Tests

```bash
npm test
```

44 tests, no network needed. `test/mock-tinyfish.js` is a fake TinyFish server used only by the tests. It copies the documented request and response shapes, rejects Agent requests that TinyFish or the official SDK would reject (unsupported `output_schema` keywords, extra `proxy_config` fields, beta-only `max_steps`), and serves fixture data for fictional companies. The app itself never loads it; every real run reads live pages through TinyFish.

The end-to-end test checks that a full run uses all three APIs, returns exactly the expected matches with the right removal reasons, merges a posting found by both Search and Agent, retries in stealth only for a blocked site, reports a live browser link for each Agent run, respects `AGENT_RUNS_LIMIT`, reads Workday through Fetch before using the Agent, does not count queue time against the run limit, spends zero Agent credits on a repeat run, flags a newly posted job as new, and still works with Agent turned off.

## Known limits

* **Coverage.** Companies on Greenhouse, Lever, Ashby and SmartRecruiters are read completely and for free. Workday sites are read for free through their search page when Search finds them. Workable and custom sites depend on the Agent cap. LinkedIn and Indeed are not read: they need logins and mostly repeat postings that are already on company boards.
* **Visa detection uses fixed patterns.** It catches common wording and shows its evidence, but "not mentioned" is common. Treat it as a hint and check with the recruiter.
* **Level and role come from titles.** Unusual titles ("Member of Technical Staff", "Software Engineer, University Grad") are covered, but some will be missed or misread.
* **Agent results vary by site.** Some careers sites block automated browsers even in stealth mode. Failures are listed under the results, not hidden.
* **Posted dates differ by system.** Greenhouse gives the first publish date, Lever the creation date, Ashby the publish date. Some Agent results have no date.
* **Some Workday pages show no job links to Fetch,** probably because the page renders before its job list loads. The log line for each Workday site shows what Fetch saw; those sites then go to the Agent.
* **Workday through Fetch reads the first results page only** (about 20 jobs per query, two queries per site) and the main location of each job. Jobs listed in several cities count only their first city.

## Files

* `server.js`: web server, background search tasks, saved searches, scheduled refresh
* `cli.js`: command line version
* `debug-fetch.js`: shows what Fetch returns for one URL
* `public/index.html`: the whole UI, plain HTML, CSS and JavaScript
* `src/tinyfish.js`: Search, Fetch and Agent client with retries, timeouts and usage counts
* `src/discover.js`: step 1, Search queries and watchlist lookup
* `src/read.js`: steps 2 and 5, Fetch for feeds and posting pages
* `src/agent.js`: step 3, Agent goal, schema, cache, cap and stealth retry
* `src/ats.js`: job system detection and feed parsers
* `src/match.js`: scoring, visa detection, location rules, dedupe
* `src/pipeline.js`: runs the steps in order
* `src/util.js`: concurrency pool, posted-date parsing, plurals
* `src/store.js`: JSON files in `data/` for saved searches, seen jobs and the Agent cache
