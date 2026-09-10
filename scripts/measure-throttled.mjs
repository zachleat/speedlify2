#!/usr/bin/env node
/**
 * Measure one site with real throttling, to see what a throttled filmstrip
 * looks like before deciding whether to switch anything over.
 *
 * TEMPORARY. This is a testing affordance, not a measurement path — there is no
 * config option for throttling and nothing else in the project sets one. Delete
 * it, or promote it to a `--throttling` flag on `speedlify measure`, once the
 * question it exists to answer has been answered.
 *
 * What it changes about the run: the scores are measured the way they always
 * are, with Lighthouse's default "simulate", and one extra pass under
 * "devtools" — real connection and CPU throttling — supplies the filmstrip.
 * That is the arrangement the project is moving to, so this exercises it rather
 * than a variant of it: the numbers stay comparable with every other site and
 * only the pictures change.
 *
 * `--convert` measures the scores throttled as well, for seeing what that does
 * to the Performance ring. It is not the arrangement above; the resulting scores
 * are not comparable with the rest of the corpus.
 *
 * Expect it to be slow. Lighthouse raises four quiet-window settings from 1s to
 * 5.25s whenever throttling is not simulated, and the load itself is genuinely
 * throttled on top of that.
 *
 * The result is written to `results/` like any other measurement, so the site
 * page and /compare/ pick it up after `npm run report`. It replaces that site's
 * filmstrip — pass a URL you do not mind re-measuring.
 *
 *   node scripts/measure-throttled.mjs https://www.11ty.dev/
 *   node scripts/measure-throttled.mjs https://www.11ty.dev/ --report   # and rebuild
 *   node scripts/measure-throttled.mjs https://www.11ty.dev/ --simulate # control run
 *   node scripts/measure-throttled.mjs https://www.11ty.dev/ --convert  # scores too
 */

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { loadConfig } from "../lib/config.js";
import { Runner } from "../lib/runner.js";
import { ResultStore } from "../lib/store.js";
import { RunLogger } from "../lib/log.js";

const { values: flags, positionals } = parseArgs({
	allowPositionals: true,
	strict: false,
	options: {
		runs: { type: "string" },
		desktop: { type: "boolean" },
		simulate: { type: "boolean" },
		convert: { type: "boolean" },
		report: { type: "boolean" },
	},
});

const url = positionals[0];
if (!url) {
	process.stderr.write("\n  Usage: node scripts/measure-throttled.mjs <url> [--runs=1] [--desktop] [--simulate]\n\n");
	process.exit(1);
}

const RESULTS_DIR = process.env.SPEEDLIFY_RESULTS_DIR || "results";
/* Scores stay simulated unless --convert says otherwise; the strip is the part
   being throttled. --simulate turns the whole thing back into a control run. */
const scoreMethod = flags.convert && !flags.simulate ? "devtools" : "simulate";
const stripMethod = flags.simulate ? null : "devtools";

const config = await loadConfig();

/*
 * The configured entry for this URL, so the run carries the same settings a
 * normal pass would — screenshots mode above all, since a site whose category
 * is "none" would produce no filmstrip and defeat the point of the exercise.
 */
const site =
	config.sites.find((s) => s.url === url) ||
	config.sites.find((s) => s.url.replace(/\/$/, "") === url.replace(/\/$/, ""));

if (!site) {
	process.stderr.write(`\n  ${url} is not in the config, so there is no category to take settings from.\n\n`);
	process.exit(1);
}

if (site.screenshots !== "filmstrip") {
	process.stderr.write(
		`\n  ${site.url} is screenshots: "${site.screenshots}", so this run would store no filmstrip.\n` +
			`  Pick a site in a category set to "filmstrip".\n\n`
	);
	process.exit(1);
}

const logger = new RunLogger({
	dir: process.env.SPEEDLIFY_LOGS_DIR || "logs",
	runId: new Date().toISOString().replace(/[:.]/g, "-"),
});
const runner = new Runner({
	logger,
	runs: Number(flags.runs) || 1,
	formFactor: flags.desktop ? "desktop" : "mobile",
	// Field data is a separate API call and irrelevant to what is being tested.
	cruxApiKey: null,
	throttlingMethod: scoreMethod,
	filmstripThrottling: stripMethod,
	// Throttled runs are slow, and the default would abandon them mid-load.
	timeoutMs: 10 * 60 * 1000,
});

process.stdout.write(
	`\n  Measuring ${site.url}\n` +
		`  scores:    ${scoreMethod}\n` +
		`  filmstrip: ${stripMethod || scoreMethod}${stripMethod ? " (separate pass)" : ""}\n\n`
);

const startedAt = Date.now();
let record;
try {
	record = await runner.measure(site);
} finally {
	await runner.close();
}

const store = new ResultStore(RESULTS_DIR);
const file = store.write(record);

const strip = record.screenshots;
const timings = record.lab?.timings || {};
process.stdout.write(
	`\n  Wrote ${file}\n` +
		`  took ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n` +
		`  scores measured under: ${record.lab?.environment?.throttlingMethod}\n` +
		`  frames captured under: ${record.screenshotThrottling}\n` +
		`  frames captured: ${strip ? strip.length : 0}` +
		(strip?.length ? `, spanning ${strip[strip.length - 1].timing}ms` : "") +
		`\n  FCP ${timings.fcp}ms · LCP ${timings.lcp}ms · TTFB ${timings.ttfb}ms\n` +
		(record.error ? `  error: ${record.error}\n` : "") +
		(flags.report ? "" : `\n  Run \`npm run report\` to see it on the site page and at /compare/.\n`) +
		`\n`
);

/* The measurement is only half of seeing it: the pages read report.json, so
   without this the run lands on disk and changes nothing on screen. */
if (flags.report) {
	process.stdout.write("  Rebuilding report.json…\n\n");
	const built = spawnSync("node", ["./bin/speedlify.js", "report"], { stdio: "inherit" });
	process.exit(built.status ?? 0);
}
