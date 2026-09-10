#!/usr/bin/env node
/**
 * Delete stored filmstrips that the config no longer grants.
 *
 * `ResultStore.writeFilmstrip` leaves what is on disk alone when a run produces
 * no frames — deliberately, so a failed run does not throw away the last good
 * pictures. The cost is that lowering a category to "primary" or "none", or
 * narrowing the perfect-score exception, stops *writing* strips without
 * removing the ones already there. They keep taking space and keep appearing on
 * site pages and at /compare/, which is how a category set to "none" can still
 * be offering filmstrips months later.
 *
 * This is the sweep for that. For every stored site whose resolved
 * `screenshots` mode is not "filmstrip", it deletes:
 *   - frames/
 *   - filmstrip.json
 *
 * Nothing else. The header screenshot and the no-JS capture belong to the other
 * two modes and are left where they are, as is every measurement record.
 *
 * Sites the config no longer lists at all are reported and skipped: an
 * unconfigured directory is a whole orphaned history rather than a stale
 * picture, and scripts/purge-excluded.mjs is where that decision lives.
 *
 *   node scripts/prune-filmstrips.mjs --dry-run   # show what would go
 *   node scripts/prune-filmstrips.mjs             # delete it
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../lib/config.js";
import { readAliases, resolveHistoryUrls, resolveCurrentUrl } from "../lib/aliases.js";
import { urlHash } from "../lib/hash.js";

const { values: flags } = parseArgs({
	options: { "dry-run": { type: "boolean" } },
	strict: false,
});

const RESULTS_DIR = process.env.SPEEDLIFY_RESULTS_DIR || "results";
const dryRun = Boolean(flags["dry-run"]);

const config = await loadConfig();

/*
 * Resolved mode per stored directory name.
 *
 * `loadConfig` has already done the resolution this depends on: site over
 * category over top level, and the richer of the two when a URL is in two
 * categories. Reading `site.screenshots` here rather than re-deriving it from
 * groups is what keeps this script from disagreeing with the runner about which
 * sites are supposed to have strips.
 *
 * Every address a site's pictures could be under, not just the configured one.
 * A confirmed redirect stores them at the destination, and the aliases run both
 * ways round: `resolveCurrentUrl` follows the move forward to where the site
 * lives now, `resolveHistoryUrls` walks back from there over everything that
 * redirects into it. Either alone leaves directories looking unconfigured —
 * creativitas.dev is configured without a www, redirects to one, and kept a
 * filmstrip its category had switched off because the history walk only ever
 * looked backwards.
 */
const { aliases } = readAliases(RESULTS_DIR);
const MODE_ORDER = ["none", "primary", "filmstrip"];

const modeByHash = new Map();
for (let site of config.sites) {
	const current = resolveCurrentUrl(site.url, aliases);
	const urls = new Set([site.url, ...resolveHistoryUrls(current, aliases, site.previousUrls)]);
	for (let url of urls) {
		const hash = urlHash(url);
		const seen = modeByHash.get(hash);
		// Two sites sharing a stored directory is not supposed to happen, but if
		// it does the richer mode has to win, or one site's setting would delete
		// the other's pictures.
		if (seen === undefined || MODE_ORDER.indexOf(site.screenshots) > MODE_ORDER.indexOf(seen)) {
			modeByHash.set(hash, site.screenshots);
		}
	}
}

function directorySize(dir) {
	let bytes = 0;
	let files = 0;
	for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const inner = directorySize(full);
			bytes += inner.bytes;
			files += inner.files;
		} else {
			bytes += fs.statSync(full).size;
			files += 1;
		}
	}
	return { bytes, files };
}

const doomed = [];
const unconfigured = [];

for (let name of fs.readdirSync(RESULTS_DIR)) {
	const dir = path.join(RESULTS_DIR, name);
	if (!fs.statSync(dir).isDirectory()) continue;

	const framesDir = path.join(dir, "frames");
	const manifest = path.join(dir, "filmstrip.json");
	const hasFrames = fs.existsSync(framesDir);
	const hasManifest = fs.existsSync(manifest);
	if (!hasFrames && !hasManifest) continue;

	// Not in the config at all — a different problem, and a destructive one to
	// get wrong. See the note at the top.
	if (!modeByHash.has(name)) {
		unconfigured.push(name);
		continue;
	}

	if (modeByHash.get(name) === "filmstrip") continue;

	const size = hasFrames ? directorySize(framesDir) : { bytes: 0, files: 0 };
	if (hasManifest) {
		size.bytes += fs.statSync(manifest).size;
		size.files += 1;
	}

	let url = null;
	try {
		url = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")).url;
	} catch {
		// A directory with pictures and no meta.json is still safe to sweep: the
		// hash matched a configured site, which is the only thing that matters.
	}

	doomed.push({ dir, framesDir, manifest, hasFrames, hasManifest, name, url, mode: modeByHash.get(name), ...size });
}

if (unconfigured.length) {
	process.stdout.write(
		`\n  Skipped ${unconfigured.length} director${unconfigured.length === 1 ? "y" : "ies"} not in the config.\n` +
			`  Those are orphaned histories rather than stale pictures — see scripts/purge-excluded.mjs.\n`
	);
}

if (!doomed.length) {
	process.stdout.write("\n  No stale filmstrips. Every stored strip belongs to a site whose mode still asks for one.\n\n");
	process.exit(0);
}

doomed.sort((a, b) => b.bytes - a.bytes);

const byMode = {};
for (let d of doomed) byMode[d.mode] = (byMode[d.mode] || 0) + 1;

process.stdout.write(
	`\n  ${dryRun ? "Would delete" : "Deleting"} ${doomed.length} stale filmstrip${doomed.length === 1 ? "" : "s"} ` +
		`(${Object.entries(byMode).map(([m, n]) => `${n} × ${m}`).join(", ")}):\n\n`
);

for (let d of doomed.slice(0, 20)) {
	process.stdout.write(
		`    ${d.name}  ${String(d.files).padStart(3)} file(s)  ${String((d.bytes / 1024).toFixed(0)).padStart(5)} kB  ${d.url || "(no meta.json)"}\n`
	);
}
if (doomed.length > 20) process.stdout.write(`    … and ${doomed.length - 20} more\n`);

const totalBytes = doomed.reduce((s, d) => s + d.bytes, 0);
const totalFiles = doomed.reduce((s, d) => s + d.files, 0);
process.stdout.write(`\n    total: ${totalFiles} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB\n`);

if (dryRun) {
	process.stdout.write("\n  Dry run — nothing deleted. Re-run without --dry-run to proceed.\n\n");
	process.exit(0);
}

for (let d of doomed) {
	if (d.hasFrames) fs.rmSync(d.framesDir, { recursive: true, force: true });
	if (d.hasManifest) fs.rmSync(d.manifest, { force: true });
}

process.stdout.write(`\n  Pruned. Re-run \`npm run report\` to rebuild.\n\n`);
