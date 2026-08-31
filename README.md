# speedlify2

Measure web performance across a list of sites and compare the results over time. Lighthouse for lab data, the Chrome UX Report for real-user field data, append-only JSON logs for history, and a static Build Awesome site for output.

- [See it live at `speedlify.dev`](https://www.speedlify.dev/)
- The successor to [`zachleat/speedlify`](https://github.com/zachleat/speedlify).

```bash
npm install
npm run measure     # measure a batch of the stalest sites
npm run backfill    # seed ~25 weeks of CrUX field history (needs CRUX_API_KEY)
npm start           # generate the report, then build and serve at localhost:8080
```

## Starting your own instance

**Use this template**, don't fork. A fork carries every commit of this repository
and stays linked to it; the template button gives you a repository with a single
commit that is yours. Nothing in this project can undo a fork's history from the
inside, so this is the one step that has to happen on GitHub rather than here.

Then, before you measure anything:

```bash
npm install
npm run reset
```

`npm run reset` empties this instance out of your copy. Run it first — without
it, `npm run measure` spends its first batch on sites from the list above rather
than yours. It prints everything it intends to do and waits for you to type
`reset`, and it:

- deletes `results/`, which is roughly 30 MB of measurements belonging to this
  instance, and the run logs beside it
- replaces `config/sites.js` with [`config/sites.example.js`](config/sites.example.js)
  — three sites in one category, enough to run
- removes the imported site lists in `config/` (about 1,500 URLs from the
  Eleventy community, starters and emeritus lists) and the scripts that generate
  them
- clears the priority queue and the built `report.json`

It leaves the code, the workflows, `src/`, `lib/` and your git history alone. Run
it twice and the second run tells you there is nothing to do.

```bash
npm run reset -- --dry-run   # show the plan, change nothing
npm run reset -- --yes       # skip the confirmation, for scripting
```

Two things to set afterwards, both read from the environment with this
instance's values as fallbacks — see [`src/_data/meta.js`](src/_data/meta.js):

```bash
SPEEDLIFY_SITE_URL=https://example.com   # where your instance is published
SPEEDLIFY_REPO_URL=https://github.com/you/your-repo
```

Then edit `config/sites.js` and you are running your own instance:

```bash
npm run measure
npm start
```

One inherited design worth knowing about: every measurement is committed, on
purpose — `measure` and `publish` are separate workflows on separate checkouts,
and the repository is the only channel between them. Your repository will grow
the same way this one has. [`npm run clean`](#sizing-it) prunes old measurements
when that starts to matter.

## How it works

Three independent steps. None waits for another, and none needs a previous one to have completed fully.

```
speedlify measure            →  results/      collect
speedlify report             →  report.json   analyze
npx @awesome.me/buildawesome →  _site/        render
```

1. **`speedlify measure --limit=N`** measures the **N stalest sites** and stops. Lighthouse N times per URL, median kept, one JSON file per measurement in `results/`. Run it as often as you like, from as many machines as you like — each invocation independently picks whatever is most out of date, so coverage converges with no coordination, lock, or queue.
2. **`speedlify report`** reads the measurements and does all the analysis — trends, rankings, deltas, significance, coverage — writing a single `report.json`.
3. **`npx @awesome.me/buildawesome`** renders that one file. It opens **no** measurements, so the build is a pure function of the report, works against a read-only checkout, and can't mutate a cache as a side effect.

`npm run build` runs steps 2 and 3.

The report renders **whatever successful data exists, newest first**. Missing, stale, and currently-failing sites all render — labeled — rather than blocking the build. Nothing is fetched at runtime; the published site is plain HTML, CSS, and build-time inline SVG, with no client-side JavaScript, including for the sparklines.

### The report

```bash
speedlify report              # -> report.json
speedlify report --pretty     # indented, for reading
speedlify report --out=x.json # somewhere else (or set SPEEDLIFY_REPORT_FILE)
```

It is self-describing: alongside the entries it carries the metric definitions (label, unit, note) the site renders with, so it can be consumed without this codebase. It is not published with the site — it is the build's input, and at full coverage it runs to tens of megabytes. What the site serves instead is one small file per site at **`/api/site/<slug>.json`**, which is what the embed component reads.

`report.json` is derived and gitignored. Size is ~24 kB per site with a 120-point window, so roughly 26 MB at 1000 sites; if you publish at that scale, consider dropping the passthrough.

Two things it deliberately does *not* duplicate: trends carry a bare `values` array rather than a point object per measurement (there are ~26 trends per site, so the naive version wrote each site's history 26 times), and `history` is capped to the rows the log table actually renders.

### Freshness on the page

Because sites are measured on a rolling schedule, the report is always a snapshot of an uneven dataset. Every table has an **Updated** column showing how old that site's figures are, amber past `staleAfterHours`, and each site page states the age of the data it's showing. The home page summarizes coverage: how many sites have data, the median age, how many are stale, how many have never been measured.

Sites are identified by their **URL** rather than a configured name — `11ty.dev`, `developer.mozilla.org/en-US`. If stripping `www.` would make two tracked URLs render identically, both keep it.

### Two layers of storage

A stored measurement is ~4 kB of nested detail. The report needs all of that for exactly **one** measurement per site (the newest successful one); for charting it needs about two dozen scalars per point. So each site keeps both:

```
results/<url-hash>/<timestamp>.json    the archive — full detail, append-only
results/<url-hash>/series.json         the projection — flat scalars, one per line
```

Measured at 1000 sites × 365 days:

| Report read | Time | Heap | Disk |
| --- | --- | --- | --- |
| via `series.json` | **1.3 s** | **152 MB** | 136 MB |
| via raw records | 24.6 s | 1053 MB | 1482 MB |

Build cost is a function of *site count*, not history depth.

`series.json` is a **derived cache** — every value can be recomputed from the archive:

```bash
speedlify reindex
```

It rebuilds itself automatically when it is missing, corrupt, or behind the raw records, so an existing `results/` directory needs no migration. Points are written one per line, so a new measurement appends exactly one line to the diff.

Committing it is the default (fast builds from a fresh clone), but deleting it is always safe.

### Rolling measurement

There is no "full sweep" to finish or fail. A run that measures 20 of 1000 sites is a successful run.

```bash
speedlify measure --limit=20        # 20 stalest sites, then stop
speedlify measure --limit=40 --shard=2/4   # 40 stalest within a disjoint quarter
speedlify list --stale              # what is falling behind
```

Batch selection, in priority order:

1. **Never measured** — a site with no data at all is the worst case.
2. **Oldest measurement** — straight staleness.

Skipped: anything measured within `freshnessHours`, and anything inside its failure backoff window. A URL that has been dead for a week backs off to a daily retry (1h → 2h → 4h → … → 24h) instead of consuming a slot in every batch ahead of sites with real data.

Selection reads **no file contents** — staleness comes from the timestamp in each filename. Picking a batch out of 1000 sites costs ~0.5s and about 1 MB.

`--shard=i/n` partitions the list deterministically by URL hash, so several machines can measure at once without overlapping or coordinating. Shard assignment is stable when you reorder the config.

### Sizing it

Measured on this machine: **~9.8s per Lighthouse run** (median 8.3s). At the default `runs: 3` that's ~30s per site.

| Sites | Cadence | Setup | Every site measured every |
| --- | --- | --- | --- |
| 50 | hourly | `--limit=20` | ~2.5 hours |
| 200 | every 2h | `--limit=40`, 2 shards | ~5 hours |
| 1000 | every 2h | `--limit=40`, 4 shards | ~12 hours |

Size `--limit` to how long you want **one invocation** to take, not to the length of your site list.

> **Do not run Lighthouse concurrently inside one process.** It shares global state — `lighthouse-logger` uses `marky`, which registers global `performance.mark()` names — and concurrent runs collide and throw. Parallelism must come from separate processes or separate machines, which is what `--shard` is for. Even then, 4-way parallelism on 12 cores measurably drops `benchmarkIndex` by ~4% through CPU contention, which is exactly what the environment-drift warning exists to catch.

## Configuration

Sites live in [`config/sites.js`](config/sites.js):

```js
export default {
  runs: 3,               // Lighthouse runs per URL; the median is kept
  formFactor: "mobile",  // or "desktop"
  freshnessHours: 20,    // skip URLs measured more recently than this
  batchSize: null,       // default --limit; null = no limit
  staleAfterHours: 48,   // data older than this is flagged in the report
  historyLimit: 120,     // measurements per site loaded by the build

  groups: {
    ssg: {
      name: "Static Site Generators",
      showEmbed: true,     // offer the embed snippet on these sites' pages
      sites: [{ name: "Eleventy", url: "https://www.11ty.dev/" }],
    },
  },
};
```

History is keyed by URL, not by name. Renaming a site keeps its history.

`showEmbed` is opt-in: a site page carries the "Embed this score" section only if
one of its categories asks for it. The snippet invites a reader to publish a live
badge for that site, which suits a register people submit their own sites to and
does not suit a list of companies nobody here speaks for.

### When a site moves

Lighthouse follows redirects, so a site that changes address would otherwise keep filing results under its old URL — the metrics change and nothing says why. speedlify compares the requested and final URLs on every run and acts on the difference.

A redirect becomes a **confirmed move** only when both hold:

- **It's permanent.** A 301 or 308, or an `http`→`https` upgrade of the same URL. A 302/303/307 elsewhere is the site saying this is temporary.
- **It's stable.** The same destination on `redirectConfirmations` consecutive successful runs (default 3). This is the guard that catches A/B tests, geo splits and maintenance pages, which look permanent for a run or two.

Confirmed moves are recorded in `results/aliases.json` automatically. Point the config at the new URL and **history follows on its own** — no manual step:

```bash
speedlify redirects     # what is redirecting, what has been confirmed
```

The site page then shows where the move happened, and history rows measured at the old address are marked, so a step-change reads as a change of address rather than a regression.

Aliases live in `results/` rather than in `config/sites.js` deliberately: the config is hand-written and reviewed, this is observed state derived from measurements. A transient redirect can never silently rewrite something you wrote. To declare a move by hand — before it's been observed, or to overrule detection — use `previousUrls`:

```js
{ name: "Nuxt", url: "https://nuxt.new/", previousUrls: ["https://nuxt.com/"] }
```

A URL that is both measured on its own and claimed as another site's `previousUrls` is rejected at config load, since its history would otherwise be counted twice.

If you change a URL without a redirect ever being observed, the old history isn't lost — it's listed on the home page as "orphaned" rather than deleted.

## Appearance

Modeled on [the Eleventy Leaderboards](https://www.11ty.dev/speedlify/): centered masthead, URL-as-name in monospace with a favicon, `#1` ranks with 🥇🥈🥉 for the podium, and the four Lighthouse categories as score rings.

**Dark by default, light on request.** Dark is unconditional — not "dark unless your OS says light" — so every reader gets the same thing on first visit. Light is an explicit choice: the toggle sets `data-theme="light"` on `<html>` and stores it in `localStorage`.

That toggle is the only client-side JavaScript on the site: ~1 kB inline across two blocks, no external file. One runs in `<head>` so a reader who chose light never sees a dark flash; the other wires the button. The button is `hidden` in the markup and revealed by script, so a no-JS reader gets dark and no dead control rather than a button that silently does nothing.

The score rings are inline SVG generated at build time — Speedlify draws them with a web component that inlines the full result JSON per row, but an arc is just a `stroke-dasharray`, so the same picture costs no JavaScript.

The favicons are the **one external request** the built site makes, via the same avatar service Speedlify uses. Set `meta.avatarService` to `""` in [`src/_data/meta.js`](src/_data/meta.js) to drop them and keep the output fully self-contained — arguably the right call for a tool that measures third-party weight for a living.

## Ranking

Ports the leaderboard algorithm from [performance-leaderboard](https://github.com/zachleat/performance-leaderboard), as described in [Eleventy Leaderboard](https://www.zachleat.com/web/eleventy-leaderboard-speedlify/#the-algorithm-and-tiebreaker-changes):

1. **Ring counts**, worst color first — the whole row of circles, read as counts rather than as a total. All six rings — the four Lighthouse categories, axe, and Core Web Vitals — are reduced to green / amber / red / gray and counted. Fewest red wins, then fewest gray, then fewest amber, then most green. A site showing any red ranks below a site showing none, whatever else it has.
2. **The axe ring's color** — green, then amber, then gray, then red. The band, not the count: two sites showing the same six colors can still differ in *which* ring is the amber one, and this asks whose amber is the accessibility ring. Second only to the rings, and ahead of every measure of speed: a slow site is a better site than an inaccessible one.
3. **Core Web Vitals** from real users — how badly first, then how many. A vital that is merely short of the good threshold beats one that is poor. A site CrUX has never sampled is not assessed here and falls through to the next step, neither credited nor blamed for data that does not exist.
4. **Sum of all four Lighthouse categories** (0–400), higher wins. Read only once two sites have shown the same circles, the same accessibility ring and the same real-user verdict — at which point the points are all that is left to separate them.
5. **Fewest axe violations**, counted as violating *nodes* — one rule broken across eight elements is eight violations. The same ring as step 2 at full resolution: up there one violation and thirty are the same color, and here the difference between them decides. It settles about a fifth of the board, and without it those pairs fall to speed — putting a site with four violations above one with a single violation.
6. **Tiebreaker value**, lower wins:

```
50000 * speedIndex / weight + TTFB + TBT
```

Speed Index per KB. A fast *heavy* site is more impressive than a fast empty one, so with Speed Index equal the larger site wins, and with weight equal the lower Speed Index wins. TTFB and TBT are added so server latency and main-thread blocking still cost you.

The weight in that ratio counts document, CSS and JS in full but caps **images at 400 kB** and **fonts at 100 kB** — otherwise a site could climb the board by shipping enormous images it doesn't need.

Sites with no successful measurement sort last rather than being treated as a zero score. Row order *is* the ranking, so a row's position and its printed rank can never disagree.

### Why bands rank ahead of points

A total treats the categories as a currency, so one can be sold off to buy points elsewhere: 100/100/100/80 sums to 380 and beats 90/90/90/90 on 360, while showing an amber ring against four greens — a row that looks worse than the row beneath it. Banding first says that a ring dropping out of green is a fact about the site that no amount of points elsewhere buys back.

The same reasoning puts the axe ring above the total. An axe violation costs nothing in the Lighthouse score — axe is a separate run — so a site could carry four violations alongside a perfect 400 and outrank a site whose only fault was the ring its total was docked for. preactjs.com sat six places above typescriptlang.org on exactly that trade. Reading the ring's color before the points ends it, and the violation count settles the rest below the total.

Gray — no data — is counted in its own bucket, between red and amber. A Lighthouse category with no score and an axe run that never happened are both unchecked, and unchecked is not clean: a site must not climb by failing to be measured. But a check that did not run is not a measured failure either, so it costs less than a red.

**Core Web Vitals is counted like any other ring**, with one exception: an unsampled vital is not a gray ring. Most of this corpus is too small for CrUX to sample, and that is a fact about a site's traffic rather than about the site, so it goes in no bucket at all — where a missing axe run does cost you. A vital that *was* sampled and failed is a red circle like any other. It is also read again a step below the rings, where how badly a site fails separates two sites the counts could not.

### Archiving a URL

`config/archived.json` takes a URL out of circulation without losing it. An archived site is not measured, not ranked, and not linked — it has no row and no page — but its stored measurements stay on disk and it is named as plain text at the bottom of the home page.

```json
{ "urls": ["https://example.com/"] }
```

It is the middle option. Deleting a URL from a category loses its history and leaves an orphaned directory behind; leaving it in place keeps a dead site in the rankings and keeps sending traffic to it.

**Sites archive themselves after `archiveAfterFailures` consecutive failures** (14 by default; `0` turns it off). That half is derived from the stored failure count rather than written into `archived.json`, which is what makes it reversible — one successful measurement resets the count and the site is back on the board with no edit. Automatically archived sites *keep being measured*, on the backoff's daily cadence, because a site that stops being measured can never stop failing. Hand-archived sites do not.

**Not for sites that moved off Eleventy.** Those keep being measured and are reclassified into 11ty Emeritus on their own, by `requireGenerator` — archiving one would throw away the measurements that show the move. Archive a site whose domain has lapsed or is now parked.

Listed here rather than removed from a category file because the community and starter lists are generated — a deletion there lasts until the next import. One entry covers every category the URL appears in.

### Accessibility comes from a real axe run

Step 2 uses a standalone [axe-core](https://github.com/dequelabs/axe-core) pass, not Lighthouse's accessibility score. Lighthouse runs a subset of axe's rules and folds the outcome into a weighted number; a page can score 93 there and still fail 13 axe checks — which is exactly what `jekyllrb.com` does in the sample data.

The pass connects to the Chrome that `chrome-launcher` already started for Lighthouse, so it costs one extra page load per site and no second browser download. It runs once per measurement rather than once per Lighthouse run, since it is a static analysis of the rendered DOM.

If axe fails or times out, the measurement is still kept — accessibility is a tiebreaker, and losing the whole record over it would be a bad trade. A site with no axe data sorts *after* one that has it, so a failed run never wins the tiebreaker by default.

The five per-metric rankings (performance, accessibility, LCP, weight, requests) are still computed and available in `report.json` as side rankings.

### Configuration via .env

A `.env` file in the project root is loaded automatically by every command and by the build. Copy [`.env.example`](.env.example) to get started:

```bash
cp .env.example .env
```

Two behaviors worth knowing:

- **Real environment variables win.** A value set by your shell or by CI is never overwritten by the file, so a stray local `.env` cannot shadow a `CRUX_API_KEY` secret in GitHub Actions. (Note that an *empty* variable still counts as set.)
- **A missing `.env` is not an error.** It is optional and gitignored; every variable it can set has a working default.

This uses Node's built-in `process.loadEnvFile` (Node 20.12+), so it costs no dependency. Point it elsewhere with `SPEEDLIFY_ENV_FILE=.env.local`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CRUX_API_KEY` | — | Chrome UX Report field data, including INP |
| `SPEEDLIFY_RESULTS_DIR` | `results` | Where measurements live |
| `SPEEDLIFY_LOGS_DIR` | `logs` | Where NDJSON run logs are written |
| `SPEEDLIFY_REPORT_FILE` | `report.json` | What `speedlify report` writes and the build reads |
| `SPEEDLIFY_ENV_FILE` | `.env` | Load a different env file |
| `SPEEDLIFY_SITE_URL` | — | Deployed origin, for page metadata |
| `SPEEDLIFY_REPO_URL` | `https://github.com/zachleat/speedlify2` | Repository link in the footer |

## Real-user data (recommended)

Lighthouse gives you lab data: a simulation, on one machine, with synthetic throttling. The Chrome UX Report gives you what actually happened to real Chrome users over a trailing 28 days.

Two reasons this matters enough to set up:

- **INP is field-only.** Lighthouse cannot measure Interaction to Next Paint in a lab run — a cold navigation has no interactions. Without CrUX you are missing a third of Core Web Vitals and substituting TBT as a proxy.
- **The lab/field gap is the interesting number.** Lab flat while field degrades usually means a population you don't test on: slower devices, worse networks, a region you just started serving.

Set it up:

1. Create an API key in the [Google Cloud console](https://console.cloud.google.com/apis/credentials).
2. Enable the **Chrome UX Report API** on that project.
3. Export it and verify:

```bash
export CRUX_API_KEY=your-key-here
npx speedlify check
```

Then seed history. The CrUX History API returns ~25 weekly data points per request, so a brand-new install gets six months of real-user trend immediately instead of waiting six months to grow one:

```bash
npx speedlify backfill
```

### When there's no key

Core Web Vitals are **skipped entirely** — no panel, no badge, no home-page stat. Without CrUX there is no INP, so the only thing left to show would be a lab approximation, and labelling that "Core Web Vitals" implies a measurement that isn't happening. Everything else (scores, lab timings, weight, main thread, a11y, hygiene) is unaffected.

With a key set, sites that lack Chrome traffic return no data individually. That is expected, not an error — those fall back to a clearly-labeled lab approximation using TBT in place of INP, because in that case CrUX *is* configured and this URL simply isn't covered.

Field data already stored in `results/` always renders, even if the key isn't present for a later build.

## What gets measured

Every run records far more than the four Lighthouse scores, because the scores are the *lagging* indicator — the leading indicators are what let you catch a regression while it's still small.

| Group | Metrics |
| --- | --- |
| **Scores** | Performance, Accessibility, Best Practices, SEO |
| **Lab timings** | LCP, CLS, TBT, FCP, Speed Index, TTFB, max potential FID, server response time, network RTT |
| **LCP subparts** | TTFB, resource load delay, load duration, element render delay |
| **Field (CrUX)** | LCP, **INP**, CLS, FCP, TTFB — p75 plus the full good/needs-work/poor distribution |
| **Weight** | Total bytes and requests, split by resource type; main document size |
| **Third parties** | Per-entity transfer size and main-thread time |
| **Main thread** | Script evaluation, style/layout, parse, GC; long task count and longest task |
| **Waste** | Unused JS/CSS, legacy JS, duplicated JS, unminified bytes, render-blocking, poorly-cached bytes |
| **DOM** | Element count, depth, max children |
| **Accessibility** | Failing audit count and failing node count, plus which audits |
| **Hygiene** | HTTPS, HSTS, CSP, clickjacking, origin isolation, Trusted Types, bfcache, HTTP protocol, console errors |
| **Environment** | Lighthouse version, form factor, throttling method, and **benchmark index** |

### Why benchmark index is recorded

`benchmarkIndex` scores the CPU of the machine that ran the test. A busy or slower CI runner inflates every CPU-bound metric — TBT, TTI, main thread work — and looks exactly like a real regression.

speedlify tracks it as a first-class metric and shows a warning banner on a site's page when the measuring machine drifted more than 20% from its own baseline. It is the single most common cause of phantom regressions in synthetic monitoring, and most tools don't record it at all.

### Signal vs noise

Lab metrics jitter. Comparing one new measurement against one old one produces a stream of false regressions, which is how a performance dashboard trains people to ignore it.

Two things guard against that:

- Each measurement runs Lighthouse N times and keeps the **median**, not the best.
- A change is only flagged **significant** if it exceeds that metric's own observed noise floor — the median absolute step between consecutive measurements. This needs at least three data points, so the first couple of runs deliberately flag nothing.

## Logs

Every run writes NDJSON, one JSON object per line:

- `logs/<runId>.ndjson` — full event log for that run
- `logs/runs.ndjson` — one summary line per run, appended forever

Both are greppable, and the run history is published at `/runs/` so you can answer "did that run actually finish?" without shell access to the build machine.

```bash
# every warning and error across all runs
grep -h '"level":"warn"\|"level":"error"' logs/*.ndjson | jq .

# what happened to one site in one run
jq 'select(.data.url == "https://example.com/")' logs/2026-01-01*.ndjson

# run history at a glance
npx speedlify runs
```

Failed measurements are stored as records with an `error` field rather than discarded — "this site was down on Tuesday" is data you want on the chart.

## Commands

```bash
speedlify measure [options]    # measure a batch of the stalest sites
speedlify report [--out=F]     # generate the JSON report the site builds from
speedlify backfill             # seed ~25 weeks of CrUX field history
speedlify check                # verify the CrUX API key
speedlify list [--stale]       # configured sites, stalest first
speedlify runs [--limit=N]     # recent runs from the log
speedlify redirects            # detected redirects and confirmed site moves
speedlify reindex              # rebuild series.json from the raw records
speedlify prune [options]      # delete old raw records (series is preserved)
```

Useful options:

| Flag | Effect |
| --- | --- |
| `--group=ssg,docs` | Only these config groups |
| `--url=<url>` | Only this URL |
| `--filter=<text>` | Sites whose name or URL contains this |
| `--runs=<n>` | Override runs per site |
| `--desktop` | Measure desktop instead of mobile |
| `--force` | Ignore the freshness window |
| `--no-field` | Skip CrUX |
| `--quiet` | No console output; the log file is still written |

Pruning deletes old **raw records** while leaving `series.json` intact, so charts and trends keep their full history even after the detailed archive behind them is gone. It also always keeps a minimum number of recent records per site, so a long-dormant URL never loses its detail entirely:

```bash
speedlify prune --days=365 --keep=30 --dry-run
```

## Automation

Two workflows, deliberately separate:

- [`measure.yml`](.github/workflows/measure.yml) — every 2 hours, 4 shards in parallel, a bounded batch each, committing results back to the repo. A shard failing doesn't stop the others.
- [`publish.yml`](.github/workflows/publish.yml) — hourly and on push, builds and deploys whatever data exists. It never waits for a measurement run and never fails because coverage is incomplete.

To use them, add `CRUX_API_KEY` as a repository secret and enable GitHub Pages with "GitHub Actions" as the source. Without the secret both still run; field data is just skipped.

Shards write to disjoint directories but push to one branch, so the commit step rebases and retries on a race.

`results/` and `logs/` are intentionally **not** gitignored — they are the dataset. Committing them means history accumulates in version control, diffs cleanly, and can be rebuilt into the site from a fresh checkout.

## Project layout

```
config/sites.js        the site list
lib/
  runner.js            drives headless Chrome + Lighthouse
  metrics.js           LHR → the compact record we persist
  crux.js              Chrome UX Report client (current + history)
  redirect.js          redirect detection and move confirmation
  aliases.js           learned URL moves, history stitching
  schedule.js          which sites a limited batch should measure
  series.js            record → flat series point projection
  report.js            measurements -> report.json (all the analysis)
  report-metrics.js    which metrics are charted, and how they are labeled
  rank.js              the leaderboard algorithm and its tiebreakers
  axe.js               standalone axe-core accessibility pass
  env.js               loads .env, without clobbering real env vars
  compare.js           trends, deltas, ranks, significance
  store.js             append-only archive + derived series
  log.js               NDJSON run logger
bin/speedlify.js           CLI
src/                   Build Awesome templates and build-time data
report.json            the generated report (derived, gitignored)
results/               the dataset (committed)
logs/                  run logs (committed)
```

## Notes

- Requires Node 18+ and a local Chrome/Chromium (`chrome-launcher` finds it).
- Lighthouse 13 renamed many audits behind `*-insight` ids. `lib/metrics.js` reads defensively and records `null` for anything missing, so a Lighthouse upgrade degrades a metric rather than breaking the history.
- The URL hash in `results/` must stay stable. Don't change `urlHash()` without migrating the directory names.

## License

MIT
