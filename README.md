# TinyFish Job Finder

A job and internship finder that reads live openings from company careers pages, matches them to what you want (role, level, location, visa), removes duplicates, ranks them, and tells you what is new since your last check.

It runs on your own computer. Node 18 or newer, no dependencies to install.

## Quick start

```bash
export TINYFISH_API_KEY="your key from https://agent.tinyfish.ai/api-keys"
npm start
# open http://localhost:3000
```

Type your search as a sentence: "Find **software engineer** roles at **intern** level in **New York; Remote**, and I **need** visa sponsorship." Press **Find jobs**.

Under **More options** you can add:

* **Companies to always check**: names (`Stripe`) or careers page URLs, one per line.
* **Keywords that rank higher** (`python, payments`) and **words that hide a job** (`clearance, unpaid`).
* **Search country**, **posted within** (7 to 60 days, or any time).
* **Careers sites to browse with Agent**: 0 means only the free Search and Fetch APIs are used.

Results show a match score out of 100, the reasons for it, level, remote, visa status with the exact sentence from the posting, posted date, and an **Apply** link. You can filter, sort, export CSV, and save the search.

## How TinyFish Search, Fetch and Agent are used

Each API does a job the others cannot do well. The UI's "Where these came from" table and usage line show exactly which API read each company in every run.

**1. Search finds where the jobs are (free).**
The app turns your preferences into 2 to 4 queries (for example `software engineer intern New York`) and restricts them with `include_domains` to the job systems most companies use: Greenhouse, Lever, Ashby, SmartRecruiters, Workday and Workable. The first query uses `recency_minutes` so recent postings surface first. A single hit like `job-boards.greenhouse.io/acme/jobs/123` tells the app that Acme has a Greenhouse board, so it reads the whole board in step 2, not just that one posting. Search also turns each company name in your watchlist into its real job board, and when a company has no job-system board, it finds the company's own careers page (with job aggregators like LinkedIn and Indeed excluded).

**2. Fetch reads the job boards and postings (free).**
Greenhouse, Lever, Ashby and SmartRecruiters publish a public JSON feed per company. One Fetch request (up to 10 URLs, batched in parallel) returns every open job at those companies with title, location, date and usually the full description. Fetch is also used to:

* confirm a watchlist company's board by trying its likely feed URLs when Search misses it,
* fall back to reading the human board page and pulling job links out of it if a feed cannot be parsed,
* read the posting page of the top matches that have no description yet (Agent results, SmartRecruiters, Workday postings found by Search). That text is what visa detection and keyword matching read, and it is how closed postings ("no longer available", 404) get removed.

The app sends `ttl` so normal runs can reuse a cache entry up to 1 hour old, and **Skip caches** sends `ttl: 0` for a fully live read.

**3. Agent browses sites that have no feed (uses credits).**
Workday, Workable and custom careers pages have no simple public feed. They need a real browser to type into the search box, apply a location filter and page through results. For those sites the app starts an Agent run (`/v1/automation/run-async`) with a step-by-step goal and an `output_schema`, so the result comes back as structured JSON: title, location, posted date, department and link for up to 25 postings. Spending is kept in check:

* runs are capped per search (default 2, you choose 0 to 6), with your watchlist sites first,
* results are cached for 12 hours, so re-running the same search costs nothing,
* runs that take too long are cancelled (`/v1/runs/{id}/cancel`),
* a run is retried once in `stealth` mode with a proxy only if the site blocked it.

Agent links are made absolute and only `http` and `https` links are kept.

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

## Command line

```bash
node cli.js --role "data analyst" --level entry --locations "Chicago; Remote" \
  --visa need --keywords "sql, tableau" --companies "Stripe, Figma" --agents 0 --out results.json
```

Run `node cli.js` with no arguments to see all options. Progress goes to stderr, ranked results go to stdout.

## Settings

All optional except the key. See `.env.example`.

* `TINYFISH_API_KEY` (required)
* `PORT` (3000) and `HOST` (127.0.0.1, so only your computer can reach it)
* `REFRESH_HOURS` (0, off)
* `MAX_BOARDS` (25) job boards read per search, `ENRICH_LIMIT` (20) posting pages read per search
* `AGENT_CACHE_HOURS` (12), `AGENT_MAX_WAIT_SECONDS` (200), `AGENT_STEALTH_RETRY` (1)

## Tests

```bash
npm test
```

27 tests, no network needed. `test/mock-tinyfish.js` is a fake TinyFish server used only by the tests. It copies the documented request and response shapes, rejects Agent schemas TinyFish would reject, and serves fixture data for fictional companies. The app itself never loads it; every real run reads live pages through TinyFish.

The end-to-end test checks that a full run uses all three APIs, returns exactly the expected matches with the right removal reasons, merges a posting found by both Search and Agent, retries in stealth only for a blocked site, spends zero Agent credits on a repeat run, flags a newly posted job as new, and still works with Agent turned off.

## Known limits

* **Coverage.** Companies on Greenhouse, Lever, Ashby and SmartRecruiters are read completely and for free. Workday, Workable and custom sites depend on Search finding them and on the Agent cap. LinkedIn and Indeed are not read: they need logins and mostly repeat postings that are already on company boards.
* **Visa detection uses fixed patterns.** It catches common wording and shows its evidence, but "not mentioned" is common. Treat it as a hint and check with the recruiter.
* **Level and role come from titles.** Unusual titles ("Member of Technical Staff", "Software Engineer, University Grad") are covered, but some will be missed or misread.
* **Agent results vary by site.** Some careers sites block automated browsers even in stealth mode. Failures are listed under the results, not hidden.
* **Posted dates differ by system.** Greenhouse gives the first publish date, Lever the creation date, Ashby the publish date. Some Agent results have no date.

## Files

* `server.js`: web server, background search tasks, saved searches, scheduled refresh
* `cli.js`: command line version
* `public/index.html`: the whole UI, plain HTML, CSS and JavaScript
* `src/tinyfish.js`: Search, Fetch and Agent client with retries, timeouts and usage counts
* `src/discover.js`: step 1, Search queries and watchlist lookup
* `src/read.js`: steps 2 and 5, Fetch for feeds and posting pages
* `src/agent.js`: step 3, Agent goal, schema, cache, cap and stealth retry
* `src/ats.js`: job system detection and feed parsers
* `src/match.js`: scoring, visa detection, location rules, dedupe
* `src/pipeline.js`: runs the steps in order
* `src/store.js`: JSON files in `data/` for saved searches, seen jobs and the Agent cache

## Demo script (about 2 minutes)

1. Start the server and open the page. Type a search you actually care about, add two companies you follow, set Agent to 2, press **Find jobs**.
2. Point at the progress log: Search finding boards, Fetch reading them, Agent browsing a Workday site.
3. Show the results: score, reasons, a visa chip with its quoted sentence, and **Apply** links that open the real posting.
4. Scroll to "Where these came from" to show which API read each company and the removal counts.
5. Save the search and run it again: the Agent result comes from cache (0 credits) and the **New** filter shows only fresh postings.
6. Change the role or city and run again to show it works for other inputs.
