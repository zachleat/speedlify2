#!/usr/bin/env node
/**
 * Import the ranked sites from the Astro Showcase, https://astro.build/showcase.
 *
 * Writes `config/astro-showcase.json`, which `config/sites.js` reads. Re-run it
 * whenever the upstream list changes; the file is generated, not hand-edited.
 *
 *   node scripts/import-astro-showcase.mjs
 *
 * Only entries with a `featured` rank are imported. The showcase sorts those
 * first and shuffles the rest on every build, so the ranked set is the only part
 * of the list with an order to follow. Kept in that order: lowest rank first,
 * ties by file name.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeUrl } from "../lib/hash.js";

const REPO = process.env.ASTRO_SHOWCASE_REPO || "withastro/astro.build";
const REF = process.env.ASTRO_SHOWCASE_REF || "main";
const DIR = process.env.ASTRO_SHOWCASE_DIR || "src/content/showcase";
const OUT = process.env.ASTRO_SHOWCASE_OUT || "config/astro-showcase.json";

/** Fetch the repository tarball; one request, no token, always cleaned up. */
function fetchTree() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astro-showcase-"));
	const tarball = path.join(tmp, "repo.tar.gz");
	const url = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}`;

	execFileSync("curl", ["-fsSL", "-o", tarball, url], { stdio: ["ignore", "ignore", "inherit"] });
	// Only the showcase directory; GitHub names the root `<repo>-<ref>`.
	const member = `${REPO.split("/")[1]}-${REF}/${DIR}`;
	execFileSync("tar", ["-xzf", tarball, "-C", tmp, member], { stdio: ["ignore", "ignore", "inherit"] });

	const root = fs
		.readdirSync(tmp, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => path.join(tmp, e.name))[0];

	if (!root) throw new Error(`Nothing extracted from ${url}`);
	return { tmp, entries: path.join(root, DIR) };
}

/**
 * The top-level scalars of one entry, which is all the showcase uses.
 * Folded continuation lines are joined; list items (`categories`) are skipped.
 */
function parseEntry(source) {
	const data = {};
	let key;
	for (let line of source.split(/\r?\n/)) {
		const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (top) {
			key = top[1];
			// A block scalar's indicator (`>-`, `|`) is not part of its value.
			data[key] = /^[>|][-+]?$/.test(top[2]) ? "" : top[2];
		} else if (key && /^\s+\S/.test(line) && !/^\s*- /.test(line)) {
			data[key] = `${data[key]} ${line.trim()}`.trim();
		} else {
			key = undefined;
		}
	}
	for (let [k, v] of Object.entries(data)) {
		if (/^'.*'$/s.test(v)) data[k] = v.slice(1, -1).replace(/''/g, "'");
		else if (/^".*"$/s.test(v)) {
			// YAML escapes with no JSON equivalent.
			const json = v
				.replace(/\\U([0-9a-fA-F]{8})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
				.replace(/\\_/g, " ");
			try {
				data[k] = JSON.parse(json);
			} catch {
				data[k] = json.slice(1, -1);
			}
		}
	}
	return data;
}

let tmp;
let entriesDir;

try {
	({ tmp, entries: entriesDir } = fetchTree());
} catch (error) {
	process.stderr.write(`\n  Could not fetch ${REPO}: ${error.message}\n\n`);
	process.exit(1);
}

if (!fs.existsSync(entriesDir)) {
	fs.rmSync(tmp, { recursive: true, force: true });
	process.stderr.write(`\n  ${REPO} has no ${DIR}/ directory — has its layout changed?\n\n`);
	process.exit(1);
}

const files = fs.readdirSync(entriesDir).filter((f) => f.endsWith(".yml")).sort();

const ranked = [];
const skipped = { unranked: 0, invalid: 0, duplicate: 0, nonHttp: 0 };

for (let file of files) {
	const entry = parseEntry(fs.readFileSync(path.join(entriesDir, file), "utf8"));

	const rank = Number(entry.featured);
	if (!entry.featured || !Number.isFinite(rank)) {
		skipped.unranked++;
		continue;
	}

	let url;
	try {
		url = new URL(entry.url);
	} catch {
		skipped.invalid++;
		continue;
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		skipped.nonHttp++;
		continue;
	}

	ranked.push({ url: normalizeUrl(url.toString()), title: entry.title || "", rank });
}

fs.rmSync(tmp, { recursive: true, force: true });

if (!ranked.length) {
	process.stderr.write(`\n  Found no ranked entries in ${REPO}/${DIR} — refusing to write an empty list.\n\n`);
	process.exit(1);
}

// Stable, so ties keep file-name order.
ranked.sort((a, b) => a.rank - b.rank);

const seen = new Set();
const sites = ranked.filter((s) => {
	if (seen.has(s.url)) {
		skipped.duplicate++;
		return false;
	}
	seen.add(s.url);
	return true;
});
const urls = sites.map((s) => s.url);

// Read the previous list before overwriting it, since this file is rewritten rather than merged.
const previous = fs.existsSync(OUT)
	? (() => {
			try {
				return new Set((JSON.parse(fs.readFileSync(OUT, "utf8")).urls || []).map(normalizeUrl));
			} catch {
				return null;
			}
		})()
	: null;

const current = new Set(urls);
const removed = previous ? [...previous].filter((u) => !current.has(u)).sort() : [];
const added = previous ? urls.filter((u) => !previous.has(u)) : [];

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(
	OUT,
	JSON.stringify(
		{
			generated: new Date().toISOString(),
			source: `https://github.com/${REPO}/tree/${REF}/${DIR}`,
			note: "Generated by scripts/import-astro-showcase.mjs — do not edit by hand.",
			entries: files.length,
			sites,
			urls,
		},
		null,
		2,
	) + "\n",
);

process.stdout.write(
	`\n  wrote ${OUT}\n` +
		`  ${urls.length} ranked sites, from ${files.length} entries\n` +
		`  skipped: ${skipped.unranked} unranked, ${skipped.duplicate} duplicate, ` +
		`${skipped.invalid} unparseable, ${skipped.nonHttp} non-HTTP\n` +
		(previous === null
			? `  no previous list to compare against\n`
			: `  changes: +${added.length} added, -${removed.length} removed\n`) +
		"\n",
);

if (removed.length) {
	process.stdout.write(`  REMOVED UPSTREAM — ${removed.length}\n`);
	for (let url of removed) process.stdout.write(`    ${url}\n`);
	process.stdout.write("\n");
}
if (added.length) {
	process.stdout.write(`  ADDED — ${added.length}\n`);
	for (let url of added.slice(0, 25)) process.stdout.write(`    ${url}\n`);
	if (added.length > 25) process.stdout.write(`    …and ${added.length - 25} more\n`);
	process.stdout.write("\n");
}
