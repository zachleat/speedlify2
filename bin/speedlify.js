#!/usr/bin/env node
// Must stay first: loads .env before anything reads process.env.
import "../lib/env.js";

import fs from "node:fs";
import v8 from "node:v8";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, selectSites } from "../lib/config.js";
import { ResultStore } from "../lib/store.js";
import { RunLogger, readRunHistory } from "../lib/log.js";
import { Runner } from "../lib/runner.js";
import { fetchFieldHistory, checkApiKey } from "../lib/crux.js";
import { stamp, urlHash } from "../lib/hash.js";
import { selectBatch, parseShard, nextFailureCount } from "../lib/schedule.js";
import { readQueue, dropFromQueue } from "../lib/priority.js";
import { learnAliases, readAliases, applyAliases } from "../lib/aliases.js";
import { confirmRedirect, isLandingRedirect } from "../lib/redirect.js";
import { buildReport } from "../lib/report.js";

const RESULTS_DIR = process.env.SPEEDLIFY_RESULTS_DIR || "results";

/**
 * URLs to measure ahead of the schedule, one per line. See lib/priority.js.
 * Absent by default — a missing or empty file means nothing is queued.
 */
const PRIORITY_FILE = process.env.SPEEDLIFY_PRIORITY_FILE || "config/priority.txt";

/**
 * Stop a measure run when the heap gets this close to V8's ceiling.
 *
 * Not a guess at a byte count: it is read from the running process, so it holds
 * whether or not someone has raised --max-old-space-size.
 */
const HEAP_STOP_FRACTION = 0.8;

function heapPressure() {
	return process.memoryUsage().heapUsed / v8.getHeapStatistics().heap_size_limit;
}
const LOGS_DIR = process.env.SPEEDLIFY_LOGS_DIR || "logs";
const REPORT_FILE = process.env.SPEEDLIFY_REPORT_FILE || "report.json";

/**
 * How long a stored field history stays fresh.
 *
 * The CrUX History API returns weekly points and updates once a week, so
 * refetching a site whose file is hours old spends rate-limited quota to
 * rewrite the same 25 numbers. Six days rather than seven: on a fixed week a
 * run that starts a minute late finds everything still fresh, does nothing, and
 * the site drifts a week behind.
 */
const FIELD_FRESH_DAYS = 6;

/**
 * How long a run may spend before stopping cleanly.
 *
 * CrUX allows 150 queries a minute per project and lib/crux.js paces itself to
 * stay under that, which puts a hard floor on how many sites an hour's run can
 * cover — the whole list has not fitted in one pass since. A run that overruns
 * its CI timeout is killed, and a killed run commits nothing, so the work it
 * did do is lost as well. Stopping short and committing is strictly better: the
 * sites it did not reach are the stalest ones next time, by construction.
 */
const BACKFILL_BUDGET_MINUTES = 15;

/**
 * When a site's field history was last fetched, and whether it found anything.
 *
 * `at` is null if the site has never been asked. `empty` marks a recorded miss
 * — CrUX answered 404 for both the URL and the origin, which is the normal
 * answer for a site below its reporting threshold. Both are stored the same
 * way, so freshness alone cannot tell "25 weeks of metrics" from "asked, and
 * Google has nothing", and the two need reporting separately.
 *
 * Read out of the file rather than taken from its mtime: CI checks the repo out
 * fresh every run, which stamps every file with the checkout time and would
 * make the whole corpus look equally fresh. Matched rather than parsed — these
 * files carry 25 weeks of metrics each, and the whole list is scanned to decide
 * what to do.
 */
function fieldFetchedAt(resultsDir, hash) {
	let text;
	try {
		text = fs.readFileSync(path.join(resultsDir, hash, "field-history.json"), "utf8");
	} catch {
		return { at: null, empty: false };
	}

	const match = /"fetchedAt":\s*"([^"]+)"/.exec(text);
	const at = match ? Date.parse(match[1]) : Number.NaN;
	return { at: Number.isNaN(at) ? null : at, empty: /"series":\s*\[\s*\]/.test(text) };
}

const HELP = `
speedlify — measure web performance across sites and compare over time

Usage:
  speedlify measure [options]     Measure a batch of the stalest sites
  speedlify report [--out=F]      Generate the static JSON report the site builds from
  speedlify backfill [options]    Refresh ~25 weeks of CrUX field history, stalest first
  speedlify check                 Verify the CrUX API key works
  speedlify list                  Show configured sites and their latest result
  speedlify runs [--limit=N]      Show recent measurement runs from the log
  speedlify redirects             Show detected redirects and confirmed site moves
  speedlify reindex [--replace]   Rebuild series.json from the raw records
  speedlify prune [options]       Delete old result files

Options:
  --limit=<n>       Measure at most this many sites (default: config batchSize)
  --shard=<i/n>     Only this slice of the site list, e.g. 2/4
  --group=<id,id>   Only these config groups
  --url=<url>       Only this URL
  --filter=<text>   Only sites whose name or URL contains this
  --runs=<n>        Lighthouse runs per site (default: config value)
  --desktop         Measure desktop instead of mobile
  --force           Ignore the freshness window and re-measure everything
  --max-minutes=<n> backfill: stop after this long and exit cleanly (0 = no limit)
  --no-field        Skip CrUX field data
  --out=<file>      report: output path (default report.json)
  --pretty          report: indent the JSON for reading
  --stale           list: show only sites with no recent data
  --days=<n>        Prune: delete results older than this (default 365)
  --keep=<n>        Prune: always keep this many per site (default 30)
  --dry-run         Prune: report what would be deleted
  --replace         reindex: drop points whose raw record is gone. Destructive
                    to pruned history, which the series exists to outlive
  --quiet           Suppress console output (the log file is still written)

Environment:
  CRUX_API_KEY      Google API key with the Chrome UX Report API enabled.
                    Without it, field data and Core Web Vitals INP are skipped.
`;

const { values: flags, positionals } = parseArgs({
	allowPositionals: true,
	strict: false,
	options: {
		group: { type: "string" },
		url: { type: "string" },
		filter: { type: "string" },
		runs: { type: "string" },
		limit: { type: "string" },
		days: { type: "string" },
		keep: { type: "string" },
		shard: { type: "string" },
		"max-minutes": { type: "string" },
		stale: { type: "boolean" },
		out: { type: "string" },
		pretty: { type: "boolean" },
		desktop: { type: "boolean" },
		force: { type: "boolean" },
		"no-field": { type: "boolean" },
		"dry-run": { type: "boolean" },
		replace: { type: "boolean" },
		quiet: { type: "boolean" },
		help: { type: "boolean", short: "h" },
	},
});

const command = positionals[0] || "help";

const commands = { measure, report, backfill, check, list, runs: runsCmd, redirects, reindex, prune, help: showHelp };

if (flags.help || !commands[command]) {
	showHelp();
	process.exit(commands[command] || flags.help ? 0 : 1);
}

try {
	await commands[command]();
} catch (err) {
	process.stderr.write(`\x1b[31mError:\x1b[0m ${err.message}\n`);
	if (process.env.DEBUG) process.stderr.write(err.stack + "\n");
	process.exit(1);
}

/* -------------------------------------------------------------------------- */

function showHelp() {
	process.stdout.write(HELP);
}

async function measure() {
	const config = await loadConfig();

	// Follow confirmed site moves automatically. A redirect that has proved
	// permanent and stable is measured at its destination without anyone
	// editing config/sites.js.
	const configuredSites = applyAliases(config.sites, readAliases(RESULTS_DIR).aliases, urlHash);
	const matched = selectSites(configuredSites, flags);

	if (!matched.length) {
		process.stdout.write("No sites matched.\n");
		return;
	}

	const runId = stamp();
	const logger = new RunLogger({ dir: LOGS_DIR, runId, quiet: flags.quiet });
	const store = new ResultStore(RESULTS_DIR);

	const formFactor = flags.desktop ? "desktop" : config.formFactor;
	const runsPer = numFlag(flags.runs, config.runs);
	const cruxApiKey = flags["no-field"] ? null : process.env.CRUX_API_KEY || null;
	const shard = parseShard(flags.shard);

	// The batch is the unit of work. Each invocation spends its budget on the
	// staleest sites and stops — no invocation needs to see the whole list, and
	// an interrupted run costs at most the sites it hadn't reached.
	const limit = numFlag(flags.limit, config.batchSize ?? null);

	// Hand-queued URLs, measured ahead of whatever is stalest. Checked against the
	// configured list first: a queued URL nobody has configured cannot be
	// measured, and saying so is more use than silently doing nothing.
	const queued = readQueue(PRIORITY_FILE);
	const configuredUrls = new Set(matched.map((s) => s.url));
	for (let url of queued.filter((u) => !configuredUrls.has(u))) {
		logger.warn("queued URL is not in the site list, skipping", { url, file: PRIORITY_FILE });
	}

	const batch = selectBatch(matched, store, {
		limit,
		freshnessHours: flags.force ? 0 : config.freshnessHours,
		retryErrorsAfterHours: config.retryErrorsAfterHours,
		failureBackoff: config.failureBackoff,
		shard,
		priority: queued,
	});

	const sites = batch.selected;

	logger.info(`batch: ${sites.length} of ${batch.poolSize} site(s)`, {
		limit,
		eligible: batch.eligible,
		skippedFresh: batch.skipped.fresh,
		skippedBackoff: batch.skipped.backoff,
		caughtUp: batch.caughtUp,
		shard: shard ? `${shard.index + 1}/${shard.total}` : null,
		queued: batch.priority.length,
		formFactor,
		runsPer,
		field: Boolean(cruxApiKey),
		// Politeness settings in play for this batch, if any.
		rateLimited: [...new Set(sites.map((s) => s.rateLimit?.delayMs).filter(Boolean))],
	});

	/*
	 * The batch itself, one line per site, before any of it runs.
	 *
	 * The summary line above says how many and why; this says which. That is the
	 * difference between a run that can be reproduced and one that can only be
	 * described: when a batch dies halfway, or a shard keeps picking the same
	 * sites, the question is always which URLs it had chosen — and by then the
	 * process is gone.
	 *
	 * Debug level, so it lands in the run's own log file and stays out of the
	 * console: twenty lines before anything happens is noise on a terminal and
	 * exactly what you want in a file you are reading because something broke.
	 */
	for (let [i, site] of sites.entries()) {
		const age = batch.detail[i]?.ageHours;
		logger.debug(`queued [${i + 1}/${sites.length}] ${site.url}`, {
			url: site.url,
			group: site.group,
			// Why this site is in the batch: how stale it was, and whether it is
			// here because it failed rather than because it aged.
			ageHours: age === Infinity ? null : age === undefined ? null : Number(age.toFixed(1)),
			neverMeasured: age === Infinity,
			failing: batch.detail[i]?.failing ?? false,
			consecutiveFailures: batch.detail[i]?.consecutiveFailures ?? 0,
		});
	}

	if (!sites.length) {
		const why = batch.skipped.fresh
			? `all ${batch.skipped.fresh} site(s) measured within the last ${config.freshnessHours}h`
			: "nothing eligible";
		logger.info(`nothing to measure — ${why}`);
		await logger.close({ ...summaryOf(batch), measured: 0, skipped: batch.skipped.fresh, failed: 0, formFactor });
		if (!flags.quiet) process.stdout.write(`\n  Nothing to measure: ${why}.\n\n`);
		return;
	}

	if (!cruxApiKey && !flags["no-field"]) {
		logger.warn("CRUX_API_KEY not set — lab data only, no field metrics or INP");
	}

	const runner = new Runner({ logger, runs: runsPer, formFactor, cruxApiKey });
	const summary = {
		...summaryOf(batch),
		measured: 0,
		skipped: batch.skipped.fresh,
		failed: 0,
		formFactor,
	};

	/*
	 * Lighthouse can reject a promise nobody is awaiting.
	 *
	 * When a page dies or navigates mid-audit, an in-flight `Runtime.evaluate`
	 * comes back as "Protocol error ... Promise was collected" — from inside
	 * Lighthouse's own wait loop, after the call we awaited has already settled.
	 * Node's default for an unhandled rejection is to kill the process, so one
	 * uncooperative page ends the whole batch: the sites already measured are
	 * lost with it, and on CI the job never reaches the step that commits them.
	 *
	 * Narrow on purpose. Only protocol-level noise from the browser is absorbed;
	 * anything else is re-thrown, because a stray rejection in our own code is a
	 * bug and should still be loud. The count goes in the run summary so this
	 * cannot quietly become normal.
	 */
	let strayProtocolErrors = 0;
	const isProtocolNoise = (err) =>
		Boolean(err?.protocolMethod) || /Protocol error|Target closed|Session closed|WebSocket/i.test(err?.message ?? "");

	const onStrayRejection = (err) => {
		if (!isProtocolNoise(err)) throw err;
		strayProtocolErrors++;
		logger.warn("stray browser protocol error, continuing", { error: err?.message ?? String(err) });
	};
	process.on("unhandledRejection", onStrayRejection);
	process.on("uncaughtException", onStrayRejection);

	try {
		await runner.launch();

		for (let [i, site] of sites.entries()) {
			const prefix = `[${i + 1}/${sites.length}]`;
			const age = batch.detail[i]?.ageHours;

			logger.info(
				`${prefix} ${site.name}${age === Infinity ? " (never measured)" : age ? ` (${age.toFixed(1)}h old)` : ""}`,
				{ url: site.url }
			);

			const record = await runner.measure(site);

			// Carry the consecutive-failure count forward so the next scheduler
			// run can back off without re-reading this site's history.
			const previous = store.latest(site.url);
			record.consecutiveFailures = nextFailureCount(previous, Boolean(record.error));

			const file = store.write(record);

			const redirect = record.lab?.redirect;
			// A root origin serving its homepage from a landing path does so on
			// every run forever. Warning about it each time buries the redirects
			// that do mean something.
			if (redirect && !isLandingRedirect(redirect.from, redirect.to)) {
				logger.warn(`${prefix} ${site.name} redirects to ${redirect.to}`, {
					from: redirect.from,
					to: redirect.to,
					change: redirect.change,
					permanent: redirect.permanent,
					statuses: redirect.statuses,
				});
			}

			if (record.error) {
				summary.failed++;
				logger.error(`${prefix} ${site.name} FAILED`, { error: record.error });
			} else {
				summary.measured++;
				const s = record.lab.scores;
				const t = record.lab.timings;
				logger.info(
					`${prefix} ${site.name} — perf ${s.performance} a11y ${s.accessibility} ` +
						`bp ${s["best-practices"]} seo ${s.seo} | LCP ${fmtMs(t.lcp)} CLS ${t.cls} TBT ${fmtMs(t.tbt)}`,
					{ file }
				);
			}

			// Lighthouse does not give all of its memory back. A few thousand runs
			// in one process is enough to exhaust the heap, and the crash costs the
			// alias-learning and summary work below even though every record up to
			// that point is already on disk.
			//
			// Stopping early is cheap here precisely because measurement is rolling:
			// an invocation that does part of its batch is a successful invocation,
			// and the next one picks up whatever is stalest — including whatever
			// this run did not reach.
			if (heapPressure() >= HEAP_STOP_FRACTION) {
				summary.stoppedEarly = { after: summary.measured + summary.failed, remaining: sites.length - (i + 1) };
				logger.warn(
					`stopping after ${summary.stoppedEarly.after} site(s): heap is ${Math.round(heapPressure() * 100)}% of its limit`,
					{ remaining: summary.stoppedEarly.remaining, advice: "lower batchSize to keep each run short" },
				);
				break;
			}
		}
	} finally {
		await runner.close();
		// Removed before anything else runs: the handlers exist to keep one bad
		// page from ending the batch, not to make the whole process unkillable.
		process.off("unhandledRejection", onStrayRejection);
		process.off("uncaughtException", onStrayRejection);
		if (strayProtocolErrors) summary.strayProtocolErrors = strayProtocolErrors;
	}

	// Promote any redirect that has now held steady long enough to count as a
	// real move. Runs over every configured site, not just this batch, so an
	// alias is confirmed as soon as the evidence exists regardless of which
	// shard happened to collect it.
	const { learned } = learnAliases(store, matched.map((s) => s.url), {
		resultsDir: RESULTS_DIR,
		confirmations: config.redirectConfirmations,
	});

	// Queued URLs come off the queue once they have had their turn, whether the
	// measurement succeeded or not. The queue records an intention to measure
	// something next, and that has now happened; a site that failed is on the
	// ordinary retry path from here, and leaving it queued would give it priority
	// again on every run until it recovered.
	//
	// Only what this shard actually took. A queued URL in another shard's slice,
	// or one that did not fit inside the batch limit, is still waiting.
	summary.queued = batch.priority.length;
	if (batch.priority.length) {
		const removed = dropFromQueue(PRIORITY_FILE, batch.priority);
		logger.info(`cleared ${removed} queued URL(s)`, { file: PRIORITY_FILE });
	}

	summary.aliasesLearned = learned.length;
	for (let alias of learned) {
		logger.warn(`confirmed move: ${alias.from} -> ${alias.to}`, alias);
	}

	const record = await logger.close(summary);
	if (!flags.quiet) {
		// A run that stopped early left its untouched sites eligible too.
		const remaining =
			Math.max(0, batch.eligible - sites.length) + (summary.stoppedEarly?.remaining ?? 0);
		process.stdout.write(
			`\n  ${summary.measured} measured · ${summary.skipped} fresh · ${summary.failed} failed` +
				(summary.queued ? ` · ${summary.queued} queued` : "") +
				`  (${(record.durationMs / 1000).toFixed(1)}s)\n` +
				(summary.stoppedEarly
					? `  ! stopped early under memory pressure after ${summary.stoppedEarly.after} site(s)\n` +
						`    Lighthouse does not fully release memory between runs, so a very long\n` +
						`    invocation exhausts the heap. Lower batchSize and run more often.\n`
					: "") +
				(remaining
					? `  ${remaining} site(s) still stale — run again to continue\n`
					: `  coverage caught up\n`) +
				`  log: ${record.logFile}\n\n`
		);
	}

	/*
	 * A failed site is a result, not a failed run.
	 *
	 * This used to exit non-zero when every site in a batch failed, on the theory
	 * that nothing working means something is wrong here. It does not: a batch is
	 * as few as a couple of sites, and two sites being down at once is an
	 * ordinary Tuesday. The failures were recorded, the backoff was updated, and
	 * the run did exactly its job — reporting that as a broken build teaches
	 * people to ignore a red build.
	 *
	 * The genuinely broken cases already exit non-zero on their own, because they
	 * throw rather than being recorded: a browser that will not launch, a config
	 * that will not parse, a results directory that cannot be written. Those never
	 * reach this line.
	 */
	if (summary.failed && summary.measured === 0) {
		// Worth saying, since it is the shape a broken environment would also
		// take — but said in the log, where someone reading it can weigh it
		// against the errors above, rather than as an exit code that stops the
		// job before it commits anything.
		logger.warn("every site in this batch failed", { attempted: summary.failed });
	}
}

function summaryOf(batch) {
	return {
		batchSize: batch.selected.length,
		poolSize: batch.poolSize,
		eligible: batch.eligible,
		backoff: batch.skipped.backoff,
		caughtUp: batch.caughtUp,
	};
}

/**
 * Refresh field history. The CrUX History API hands back ~25 weekly data points
 * per call, so a fresh install gets six months of real-user trend immediately
 * instead of waiting six months to grow one.
 *
 * Rolling rather than exhaustive, for the same reason `measure` is: it takes
 * the stalest sites it can get through in the time it has and leaves the rest
 * for the next run.
 */
async function backfill() {
	const apiKey = process.env.CRUX_API_KEY;
	if (!apiKey) throw new Error("CRUX_API_KEY is required for backfill");

	const config = await loadConfig();
	const sites = selectSites(config.sites, flags);
	const runId = `backfill-${stamp()}`;
	const logger = new RunLogger({ dir: LOGS_DIR, runId, quiet: flags.quiet });

	const formFactor = flags.desktop ? "DESKTOP" : "PHONE";

	// Everything still inside the freshness window is already current; --force
	// takes the whole list regardless. What is left is ordered oldest first, so
	// consecutive runs walk the corpus instead of restarting at the top of it and
	// re-covering the same prefix forever.
	const freshBefore = Date.now() - FIELD_FRESH_DAYS * 24 * 60 * 60 * 1000;
	const scanned = sites.map((site) => ({ site, ...fieldFetchedAt(RESULTS_DIR, site.hash) }));
	const queue = scanned
		.filter(({ at }) => flags.force || at === null || at < freshBefore)
		.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

	// Of the ones not due, how many were asked and came back with nothing. The
	// freshness line below is about when we last asked, which on this corpus is
	// a much larger number than how many sites CrUX actually reports on.
	const held = scanned.filter(({ at }) => at !== null);
	const withData = held.filter(({ empty }) => !empty).length;

	const limit = numFlag(flags.limit, null);
	const work = limit ? queue.slice(0, limit) : queue;

	const budgetMs = numFlag(flags["max-minutes"], BACKFILL_BUDGET_MINUTES) * 60 * 1000;
	const deadline = budgetMs > 0 ? Date.now() + budgetMs : Infinity;

	const summary = {
		sites: sites.length,
		due: queue.length,
		fresh: sites.length - queue.length,
		written: 0,
		missing: 0,
		failed: 0,
		// Set when the budget ran out: how many of the due sites went untouched.
		// Loud on purpose — a run that silently covers a third of the list looks
		// exactly like one that covered all of it.
		remaining: 0,
	};

	if (!work.length) {
		await logger.close(summary);
		if (!flags.quiet) {
			process.stdout.write(
				`\n  Nothing due: all ${sites.length} field histories are under ${FIELD_FRESH_DAYS} days old.\n` +
					`  ${withData} of them carry CrUX data; ${held.length - withData} are recorded misses —\n` +
					`  sites CrUX has no record for, at either URL or origin scope.\n\n`
			);
		}
		return;
	}

	for (let [i, { site }] of work.entries()) {
		if (Date.now() >= deadline) {
			summary.remaining = work.length - i;
			logger.warn(`stopping after ${budgetMs / 60000} minutes with ${summary.remaining} still due`, {
				covered: i,
				due: work.length,
			});
			break;
		}

		const prefix = `[${i + 1}/${work.length}]`;
		try {
			const history = await fetchFieldHistory(site.url, { apiKey, formFactor });

			const dir = path.join(RESULTS_DIR, site.hash);
			fs.mkdirSync(dir, { recursive: true });

			// A miss is recorded, not just logged. Most of this corpus is too
			// small for CrUX to sample, and a site with no file reads as never
			// fetched — so without this the same ~1,500 sites would be due every
			// run, sort to the front as the stalest, and spend the whole budget
			// re-learning that they are still not in CrUX.
			//
			// Same shape either way, with an empty series: readFieldHistory in
			// lib/report.js already treats "no weeks" as no field data, so this
			// reads exactly like the absent file it replaces.
			const payload = {
				url: site.url,
				name: site.name,
				group: site.group,
				fetchedAt: new Date().toISOString(),
				...(history ?? { series: [], scope: null }),
			};
			fs.writeFileSync(path.join(dir, "field-history.json"), JSON.stringify(payload, null, 2) + "\n");

			if (!history) {
				logger.warn(`${prefix} no field data ${site.name}`, { url: site.url });
				summary.missing++;
				continue;
			}

			logger.info(`${prefix} ${site.name} — ${history.series.length} weeks (${history.scope})`);
			summary.written++;
		} catch (err) {
			logger.error(`${prefix} ${site.name} failed`, { error: err.message });
			summary.failed++;
		}
	}

	await logger.close(summary);
	if (!flags.quiet) {
		process.stdout.write(
			`\n  ${summary.written} backfilled · ${summary.missing} without field data · ${summary.failed} failed` +
				`\n  ${summary.fresh} already fresh` +
				(summary.remaining ? ` · ${summary.remaining} left for the next run (out of time)` : "") +
				`\n\n`
		);
	}
}

async function check() {
	const apiKey = process.env.CRUX_API_KEY;
	if (!apiKey) {
		process.stdout.write(
			"\n  CRUX_API_KEY is not set.\n\n" +
				"  Field data (and INP, which Lighthouse cannot measure in a lab run) will be\n" +
				"  skipped. To enable it:\n\n" +
				"    1. Create an API key at https://console.cloud.google.com/apis/credentials\n" +
				"    2. Enable the Chrome UX Report API for that project\n" +
				"    3. Put it in a .env file (see .env.example) or export it:\n\n" +
				"         echo 'CRUX_API_KEY=your-key' >> .env\n" +
				"         export CRUX_API_KEY=your-key\n\n"
		);
		process.exit(1);
	}

	process.stdout.write("  Checking CrUX API key against https://web.dev …\n");
	const result = await checkApiKey(apiKey);

	if (!result) {
		process.stdout.write("  Key works, but the test origin returned no data.\n");
		return;
	}

	process.stdout.write(`  OK — ${result.collectionPeriod.first} to ${result.collectionPeriod.last}\n\n`);
	for (let [name, m] of Object.entries(result.metrics)) {
		process.stdout.write(
			`    ${name.toUpperCase().padEnd(5)} p75 ${String(m.p75).padStart(8)}  ${m.rating ?? ""}\n`
		);
	}
	process.stdout.write("\n");
}

async function list() {
	const config = await loadConfig();
	const sites = selectSites(config.sites, flags);
	const store = new ResultStore(RESULTS_DIR);

	const now = Date.now();

	let rows = sites.map((site) => {
		// Newest successful data, which may be older than the newest attempt.
		const latest = store.latestSuccess(site.url);
		const lastAt = store.lastMeasuredAt(site.url);
		const ageHours = lastAt === null ? Infinity : (now - lastAt) / 3600000;

		return {
			name: site.name,
			group: site.group,
			perf: latest?.lab?.scores?.performance ?? null,
			lcp: latest?.lab?.timings?.lcp ?? null,
			field: latest?.field?.metrics?.lcp?.p75 ?? null,
			runs: store.count(site.url),
			ageHours,
			stale: ageHours >= (site.staleAfterHours ?? config.staleAfterHours ?? 48),
			never: lastAt === null,
		};
	});

	// Stalest first — the same order the scheduler will pick them in.
	rows.sort((a, b) => b.ageHours - a.ageHours);
	if (flags.stale) rows = rows.filter((r) => r.stale);

	const w = Math.max(4, ...rows.map((r) => r.name.length));
	process.stdout.write(
		`\n  ${"SITE".padEnd(w)}  ${"GROUP".padEnd(10)} ${"PERF".padStart(5)} ${"LAB LCP".padStart(9)} ${"FIELD LCP".padStart(10)} ${"RUNS".padStart(5)}  AGE\n`
	);
	process.stdout.write(`  ${"─".repeat(w + 52)}\n`);

	for (let r of rows) {
		const age = r.never ? "never" : r.ageHours < 48 ? `${r.ageHours.toFixed(1)}h` : `${(r.ageHours / 24).toFixed(1)}d`;
		const mark = r.never ? " ✗" : r.stale ? " !" : "";
		process.stdout.write(
			`  ${r.name.padEnd(w)}  ${r.group.slice(0, 10).padEnd(10)} ` +
				`${String(r.perf ?? "—").padStart(5)} ${fmtMs(r.lcp).padStart(9)} ${fmtMs(r.field).padStart(10)} ` +
				`${String(r.runs).padStart(5)}  ${age}${mark}\n`
		);
	}

	const stale = rows.filter((r) => r.stale).length;
	// Each row was judged against its own category's threshold; the summary can
	// only name one, so it names the default and says so when they differ.
	const thresholds = new Set(sites.map((s) => s.staleAfterHours ?? config.staleAfterHours ?? 48));
	const staleLabel =
		thresholds.size > 1
			? `each category's own threshold`
			: `older than ${[...thresholds][0]}h`;
	process.stdout.write(
		`\n  ${rows.length} site(s) · ${stale} stale (${staleLabel}) · ` +
			`${rows.filter((r) => r.never).length} never measured\n\n`
	);
}

async function runsCmd() {
	const history = readRunHistory(LOGS_DIR, numFlag(flags.limit, 20));

	if (!history.length) {
		process.stdout.write("\n  No runs logged yet.\n\n");
		return;
	}

	process.stdout.write(`\n  ${"RUN".padEnd(26)} ${"DUR".padStart(7)} ${"OK".padStart(4)} ${"SKIP".padStart(5)} ${"FAIL".padStart(5)}  LOG\n`);
	process.stdout.write(`  ${"─".repeat(78)}\n`);

	for (let r of history) {
		process.stdout.write(
			`  ${r.startedAt.slice(0, 19).replace("T", " ").padEnd(26)} ` +
				`${((r.durationMs || 0) / 1000).toFixed(0).padStart(6)}s ` +
				`${String(r.measured ?? r.written ?? 0).padStart(4)} ${String(r.skipped ?? 0).padStart(5)} ${String(r.failed ?? 0).padStart(5)}  ${r.logFile || ""}\n`
		);
	}
	process.stdout.write("\n");
}

/**
 * Generate the static JSON report the site is built from.
 *
 * This is the analysis step: it reads the measurements, computes every trend,
 * ranking and comparison, and writes the result to a single file. The Build Awesome
 * build then renders that file and nothing else — it never opens a measurement,
 * so it works against a read-only checkout and cannot mutate any cache as a
 * side effect.
 */
async function report() {
	const out = flags.out || REPORT_FILE;
	const started = Date.now();

	const data = await buildReport({ resultsDir: RESULTS_DIR });

	const json = flags.pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
	fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
	fs.writeFileSync(out, json + "\n");

	const bytes = Buffer.byteLength(json);
	const size = bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} kB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	const c = data.coverage;

	process.stdout.write(
		`\n  wrote ${out}  ${size}  (${((Date.now() - started) / 1000).toFixed(1)}s)\n` +
			`  ${data.entries.length} sites · ${c.measured} with data · ${c.stale} stale · ${c.never} never measured\n` +
			(data.moving.length ? `  ${data.moving.length} site(s) redirecting elsewhere — see \`speedlify redirects\`\n` : "") +
			(data.orphans.length ? `  ${data.orphans.length} orphaned histor${data.orphans.length === 1 ? "y" : "ies"}\n` : "") +
			// Loud on purpose: a collision silently costs those sites their embed.
			data.slugCollisions
				.map((c) => `  ! slug collision on "${c.slug}" — using hashes for ${c.urls.join(", ")}\n`)
				.join("") +
			"\n"
	);
}

/**
 * Show detected redirects and confirmed moves.
 *
 * Answers the two questions a redirect raises: is this site moving, and has
 * speedlify already carried its history across?
 */
async function redirects() {
	const config = await loadConfig();
	const sites = selectSites(config.sites, flags);
	const store = new ResultStore(RESULTS_DIR);

	const { aliases } = readAliases(RESULTS_DIR);
	const configured = new Set(config.sites.map((s) => s.url));

	const observed = [];
	for (let site of sites) {
		const points = store.series(site.url, { rebuild: false });
		const latest = points[points.length - 1];
		if (!latest?.to) continue;

		const verdict = confirmRedirect(points, { confirmations: config.redirectConfirmations });
		const landing = isLandingRedirect(site.url, latest.to);
		observed.push({ site, to: latest.to, permanent: latest.perm === 1, verdict, landing });
	}

	if (!observed.length && !aliases.length) {
		process.stdout.write("\n  No redirects detected.\n\n");
		return;
	}

	if (observed.length) {
		process.stdout.write("\n  Currently redirecting\n  ─────────────────────\n");
		for (let o of observed) {
			// A landing redirect is never aliased however stable it looks, so
			// reporting it as a confirmed move would promise something that is not
			// going to happen.
			const state = o.landing
				? "landing path — not a move, will not be aliased"
				: o.verdict.confirmed
					? "confirmed move"
					: `not yet confirmed (${o.verdict.reason}, ${o.verdict.observations}/${config.redirectConfirmations})`;
			// Whether a landing redirect is permanent changes nothing about what
			// happens to it, so the permanence clause is dropped rather than
			// contradicting the line beside it.
			const permanence = o.landing ? null : o.permanent ? "permanent" : "TEMPORARY — will not be aliased";

			process.stdout.write(
				`  ${o.site.name}\n    ${o.site.url}\n    → ${o.to}\n` +
					`    ${[permanence, state].filter(Boolean).join(" · ")}\n\n`
			);
		}
	}

	if (aliases.length) {
		process.stdout.write("  Confirmed moves (history is merged)\n  ───────────────────────────────────\n");
		for (let a of aliases) {
			process.stdout.write(`  ${a.from}\n    → ${a.to}   [${a.source}, since ${(a.since || a.confirmedAt).slice(0, 10)}]\n`);
		}
		process.stdout.write("\n");
	}

	// A destination nobody is measuring means the config is now pointing at the
	// old address. History is safe either way, but the config should catch up.
	const dangling = observed.filter((o) => o.verdict.confirmed && !configured.has(o.to));
	if (dangling.length) {
		process.stdout.write("  Update config/sites.js\n  ──────────────────────\n");
		process.stdout.write("  These sites have moved. Point them at the new URL — history follows\n");
		process.stdout.write("  automatically via the confirmed alias, so no previousUrls is needed:\n\n");
		for (let o of dangling) {
			process.stdout.write(`    { name: ${JSON.stringify(o.site.name)}, url: ${JSON.stringify(o.to)} },\n`);
		}
		process.stdout.write("\n");
	}
}

/**
 * Rebuild every series.json from the raw records.
 *
 * The series is a derived cache, so this is always safe to run: it never reads
 * anything but the archive, and never writes anything but the cache. Needed
 * after changing the projection in lib/series.js, or after restoring results
 * from a backup.
 */
/**
 * Rebuild every series from the raw records.
 *
 * Merging by default is not a shortcut: pruning deletes old raw records on
 * purpose and the series is what outlives them, so rebuilding from what is left
 * would quietly erase the history pruning exists to keep.
 *
 * `--replace` is for the other case — a record deliberately deleted, where the
 * point should go with it. Without it, a series keeps points for measurements
 * that no longer exist and nothing can remove them: three sites here kept
 * sparklines and log rows for bot-check runs whose records had been deleted.
 *
 * It is destructive to pruned history, so it says what it will do and counts
 * what it dropped rather than reporting a rebuild that looks like any other.
 */
async function reindex() {
	const store = new ResultStore(RESULTS_DIR);
	const hashes = store.hashes();
	const replace = Boolean(flags.replace);

	if (replace) {
		process.stdout.write(
			"\n  --replace: points whose raw record is gone will be dropped.\n" +
				"  That includes anything pruning removed on purpose.\n"
		);
	}

	let dropped = 0;

	let rebuilt = 0;
	let empty = 0;
	let points = 0;
	const started = Date.now();

	for (let hash of hashes) {
		// Work from the stored meta rather than config, so histories for URLs
		// that have since been removed are reindexed too.
		const metaFile = path.join(RESULTS_DIR, hash, "meta.json");
		if (!fs.existsSync(metaFile)) {
			empty++;
			continue;
		}

		let url;
		try {
			url = JSON.parse(fs.readFileSync(metaFile, "utf8")).url;
		} catch {
			empty++;
			continue;
		}
		if (!url) {
			empty++;
			continue;
		}

		const before = store.readSeries(url)?.points.length ?? 0;
		const series = store.rebuildSeries(url, { replace });
		if (series) {
			rebuilt++;
			points += series.points.length;
			dropped += Math.max(0, before - series.points.length);
		} else {
			empty++;
		}
	}

	process.stdout.write(
		`\n  rebuilt ${rebuilt} series (${points.toLocaleString()} points)` +
			`${dropped ? ` · ${dropped.toLocaleString()} orphaned ${dropped === 1 ? "point" : "points"} dropped` : ""}` +
			`${empty ? ` · ${empty} skipped` : ""}` +
			`  (${((Date.now() - started) / 1000).toFixed(1)}s)\n\n`
	);
}

async function prune() {
	const store = new ResultStore(RESULTS_DIR);
	const removed = store.prune({
		days: numFlag(flags.days, 365),
		keepMin: numFlag(flags.keep, 30),
		dryRun: Boolean(flags["dry-run"]),
	});

	const verb = flags["dry-run"] ? "would delete" : "deleted";
	process.stdout.write(`\n  ${verb} ${removed.length} result file(s)\n\n`);
}

/* -------------------------------------------------------------------------- */

/**
 * Numeric flag with a default. Not `Number(x) || fallback` — that silently
 * turns a deliberate `--days=0` into 365, which is the difference between
 * "prune everything" and "prune nothing".
 */
function numFlag(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function fmtMs(v) {
	if (v === null || v === undefined) return "—";
	return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}
