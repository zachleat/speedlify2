#!/usr/bin/env node
/**
 * Recompute `noJsText` in every stored screenshot.json.
 *
 * That figure is measured once, when the screenshot is taken, and stored beside
 * it — so a change to the detector only reaches a site the next time it comes
 * round for measurement. On a fleet measured over days that leaves the report
 * showing two different rules at once. This applies the current detector to the
 * captures already on disk.
 *
 * Uses `textRows` from lib/axe.js rather than its own copy: a backfill that
 * disagrees with the measurement it is backfilling is worse than no backfill.
 *
 *   node scripts/backfill-nojs-text.mjs --dry-run   # show what would change
 *   node scripts/backfill-nojs-text.mjs             # write it
 *
 * `results/` is version controlled, so the writes still need committing.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import * as chromeLauncher from "chrome-launcher";
import puppeteer from "puppeteer-core";
import { textRows } from "../lib/axe.js";
import { clientRendered } from "../lib/report.js";

const { values: flags } = parseArgs({ options: { "dry-run": { type: "boolean" } }, strict: false });

const RESULTS_DIR = process.env.SPEEDLIFY_RESULTS_DIR || "results";
const dryRun = Boolean(flags["dry-run"]);

const jobs = [];
for (const hash of fs.readdirSync(RESULTS_DIR)) {
	const file = path.join(RESULTS_DIR, hash, "screenshot.json");
	if (!fs.existsSync(file)) continue;

	let meta;
	try {
		meta = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		continue;
	}

	// Only captures that have a no-JS image to measure. A record with none has
	// no `noJsText` to be wrong about.
	if (!meta.noJs?.file) continue;
	const image = path.join(RESULTS_DIR, hash, meta.noJs.file);
	if (!fs.existsSync(image)) continue;

	jobs.push({ hash, file, image, meta });
}

if (!jobs.length) {
	process.stdout.write("\n  No stored no-JS captures to measure.\n\n");
	process.exit(0);
}

process.stdout.write(`\n  Measuring ${jobs.length} stored no-JS captures…\n`);

const chrome = await chromeLauncher.launch({ chromeFlags: ["--headless=new", "--no-sandbox"] });
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });

const changed = [];
let unchanged = 0;
let failed = 0;

try {
	for (const job of jobs) {
		const shot = { buffer: fs.readFileSync(job.image), type: path.extname(job.image).slice(1) };
		const value = await textRows(browser, shot);

		if (value === null) {
			failed++;
			continue;
		}
		if (value === job.meta.noJsText) {
			unchanged++;
			continue;
		}

		const before = clientRendered(job.meta);
		const after = clientRendered({ ...job.meta, noJsText: value });
		changed.push({ ...job, value, before, after });
	}
} finally {
	await browser.disconnect();
	await chrome.kill();
}

const flipped = changed.filter((c) => c.before !== c.after);

process.stdout.write(`\n  unchanged: ${unchanged}`);
if (failed) process.stdout.write(`   could not be measured: ${failed}`);
process.stdout.write(`\n  ${dryRun ? "would be rewritten" : "rewritten"}: ${changed.length}`);
process.stdout.write(`   of those, verdict changes: ${flipped.length}\n\n`);

// Null is a third answer: too little to judge on. A record that had no stored
// figure at all reads as null before and as a verdict after, which is a record
// becoming judgeable rather than changing its mind.
const verdictName = (v) => (v === null ? "no verdict" : v ? "client rendered" : "server rendered");

for (const c of flipped) {
	const was = c.meta.noJsText ?? "none";
	process.stdout.write(
		`    ${c.hash}  ${String(was).padStart(5)} → ${String(c.value).padStart(5)} rows   ${verdictName(c.before)} → ${verdictName(c.after)}\n`,
	);
}

if (dryRun) {
	process.stdout.write("\n  Dry run — nothing written. Re-run without --dry-run to apply.\n\n");
	process.exit(0);
}

for (const c of changed) {
	fs.writeFileSync(c.file, `${JSON.stringify({ ...c.meta, noJsText: c.value }, null, 2)}\n`);
}

process.stdout.write(`\n  Wrote ${changed.length} screenshot.json files. Commit them, then rebuild.\n\n`);
