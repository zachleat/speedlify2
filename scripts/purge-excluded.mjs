#!/usr/bin/env node
/**
 * Delete stored data for URLs that are no longer in the config.
 *
 * Removing a URL from `config/sites.js` normally *keeps* its history — that is
 * deliberate, so an accidental edit does not destroy months of measurements,
 * and the home page lists it as "orphaned" instead.
 *
 * This script is the opposite intent, for when a URL should be gone: excluding
 * a contact tagged Problematic means their site should leave no trace, not sit
 * in `results/` as an orphan.
 *
 * Deletes, for each orphaned URL:
 *   - every stored measurement
 *   - series.json, meta.json, field-history.json
 *   - any learned redirect alias mentioning the URL
 *
 *   node scripts/purge-excluded.mjs --dry-run   # show what would go
 *   node scripts/purge-excluded.mjs             # delete it
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../lib/config.js";
import { ResultStore } from "../lib/store.js";
import { readAliases, writeAliases } from "../lib/aliases.js";
import { urlHash } from "../lib/hash.js";

const { values: flags } = parseArgs({
	options: { "dry-run": { type: "boolean" }, yes: { type: "boolean" } },
	strict: false,
});

const RESULTS_DIR = process.env.SPEEDLIFY_RESULTS_DIR || "results";
const dryRun = Boolean(flags["dry-run"]);

const config = await loadConfig();
const store = new ResultStore(RESULTS_DIR);

/*
 * Every hash the config still accounts for — the same currency the report's
 * `findOrphans` counts in, and for the same reason: a directory is named for
 * the hash of a normalized URL, so comparing hashes is the only comparison that
 * cannot be thrown off by a trailing slash or a capital letter in a hostname.
 * Comparing raw config strings against normalized stored ones is what this
 * script used to do, and it read a configured site as unconfigured whenever the
 * two spellings differed.
 *
 * Predecessors included: a confirmed site move folds their history into a
 * current entry, which makes it live data under an old name.
 */
const known = new Set();
for (let site of config.sites) {
	known.add(urlHash(site.url));
	for (let previous of site.previousUrls) known.add(urlHash(previous));
}

/*
 * A learned redirect makes both of its ends load-bearing, so knowing either end
 * keeps the other.
 *
 * Both directions, because the two cases look nothing alike and only one of
 * them used to be handled. A configured URL that redirects somewhere is
 * measured and *stored* at its destination — Cloudflare Pages is configured as
 * pages.cloudflare.com and files its results under www.cloudflare.com/products/
 * pages — so the destination is this month's data, not a leftover. Read the
 * other way, a source that has left the config is the old name whose history
 * the destination is still carrying.
 *
 * Looped to a fixed point so a chain (a → b → c) keeps its middle.
 */
const { aliases } = readAliases(RESULTS_DIR);
for (let changed = true; changed; ) {
	changed = false;
	for (let alias of aliases) {
		const from = urlHash(alias.from);
		const to = urlHash(alias.to);
		if (known.has(from) === known.has(to)) continue;
		known.add(from);
		known.add(to);
		changed = true;
	}
}

const doomed = [];

for (let hash of store.hashes()) {
	const dir = path.join(RESULTS_DIR, hash);
	const metaFile = path.join(dir, "meta.json");

	// The directory name decides its fate; meta.json only says what to print.
	// A history with no meta at all used to be unidentifiable and so doomed by
	// default — by hash it is identified as well as any other.
	if (known.has(hash)) continue;

	let url = null;
	if (fs.existsSync(metaFile)) {
		try {
			url = JSON.parse(fs.readFileSync(metaFile, "utf8")).url || null;
		} catch {
			// Unreadable meta: the listing below says "(no meta.json)".
		}
	}

	const files = fs.readdirSync(dir);
	const measurements = files.filter((f) => /^\d{4}-/.test(f)).length;
	const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);

	doomed.push({ hash, dir, url, measurements, files: files.length, bytes });
}

if (!doomed.length) {
	process.stdout.write("\n  Nothing to purge — every stored history belongs to a configured URL.\n\n");
	process.exit(0);
}

const totalBytes = doomed.reduce((s, d) => s + d.bytes, 0);
const totalFiles = doomed.reduce((s, d) => s + d.files, 0);

process.stdout.write(`\n  ${dryRun ? "Would delete" : "Deleting"} ${doomed.length} stored histor${doomed.length === 1 ? "y" : "ies"}:\n\n`);
for (let d of doomed) {
	process.stdout.write(
		`    ${d.hash}  ${String(d.measurements).padStart(3)} measurement(s)  ${String((d.bytes / 1024).toFixed(0)).padStart(5)} kB  ${d.url || "(no meta.json)"}\n`
	);
}
process.stdout.write(`\n    total: ${totalFiles} files, ${(totalBytes / 1024).toFixed(0)} kB\n`);

if (dryRun) {
	process.stdout.write("\n  Dry run — nothing deleted. Re-run without --dry-run to proceed.\n\n");
	process.exit(0);
}

for (let d of doomed) fs.rmSync(d.dir, { recursive: true, force: true });

// Drop learned aliases that pointed at anything just removed, so they cannot
// resurrect the URL by merging it into some other site later.
const purged = new Set(doomed.map((d) => d.hash));
const keptAliases = aliases.filter((a) => !purged.has(urlHash(a.from)) && !purged.has(urlHash(a.to)));

if (keptAliases.length !== aliases.length) {
	writeAliases(RESULTS_DIR, keptAliases);
	process.stdout.write(`  removed ${aliases.length - keptAliases.length} redirect alias(es)\n`);
}

process.stdout.write(`\n  Purged. Re-run \`npm run report\` to rebuild.\n\n`);
