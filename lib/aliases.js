import fs from "node:fs";
import path from "node:path";
import { normalizeUrl } from "./hash.js";
import { confirmRedirect, isLandingRedirect } from "./redirect.js";

/**
 * Learned URL aliases.
 *
 * When a site moves, its old URL keeps redirecting and its history is stranded
 * under the old key. This file records confirmed moves so the report can stitch
 * the two halves back together — automatically, without anyone having to
 * remember that nuxt.com became nuxt.new eight months ago.
 *
 * Stored in `results/aliases.json` rather than in `config/sites.js` on purpose.
 * The config is hand-written and reviewed; this is observed state, derived from
 * measurements and rebuildable from them. Keeping the two apart means a
 * transient redirect can never silently rewrite something you wrote.
 *
 * `previousUrls` in the config is the manual equivalent and always wins.
 */

export const ALIASES_VERSION = 1;

export function aliasesFile(resultsDir) {
	return path.join(resultsDir, "aliases.json");
}

export function readAliases(resultsDir) {
	const file = aliasesFile(resultsDir);
	if (!fs.existsSync(file)) return { version: ALIASES_VERSION, aliases: [] };

	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return Array.isArray(parsed?.aliases) ? parsed : { version: ALIASES_VERSION, aliases: [] };
	} catch {
		return { version: ALIASES_VERSION, aliases: [] };
	}
}

/**
 * Write the alias list deterministically.
 *
 * Two properties matter, and both are about this file being committed from
 * several parallel CI shards at once:
 *
 *  - **No timestamp.** An `updated` field changed on every run even when the
 *    aliases did not, so every shard produced a different file and every run
 *    committed one. The mtime is git's job, not the payload's.
 *  - **Sorted.** Identical knowledge must serialize to identical bytes,
 *    otherwise two shards that learned the same thing still conflict.
 *
 * Together these mean the common case — nothing new learned — is a no-op that
 * git sees no change in at all.
 */
export function writeAliases(resultsDir, aliases) {
	fs.mkdirSync(resultsDir, { recursive: true });

	const sorted = [...aliases].sort((a, b) =>
		a.from === b.from ? String(a.to).localeCompare(String(b.to)) : String(a.from).localeCompare(String(b.from)),
	);

	fs.writeFileSync(
		aliasesFile(resultsDir),
		JSON.stringify({ version: ALIASES_VERSION, aliases: sorted }, null, 2) + "\n"
	);
}

/**
 * Scan every site's series for a confirmed move and record it.
 *
 * Only writes an alias when the same permanent destination has been observed on
 * N consecutive successful measurements — see `confirmRedirect` for why both
 * conditions are needed.
 */
export function learnAliases(store, urls, { resultsDir, confirmations = 3, now = new Date() } = {}) {
	const existing = readAliases(resultsDir);
	const byPair = new Map(existing.aliases.map((a) => [`${a.from} -> ${a.to}`, a]));

	const learned = [];

	for (let url of urls) {
		const points = store.series(url, { rebuild: false });
		if (!points.length) continue;

		const verdict = confirmRedirect(points, { confirmations });
		if (!verdict.confirmed) continue;

		const from = normalizeUrl(url);
		const to = normalizeUrl(verdict.target);
		if (from === to) continue;

		// A site's front door pointing at the page it serves there is not a move,
		// however permanently and consistently it is served. Re-keying the site
		// onto a locale landing path would fork its history and rename it after an
		// implementation detail — see `isLandingRedirect`.
		if (isLandingRedirect(from, to)) continue;

		const key = `${from} -> ${to}`;
		if (byPair.has(key)) {
			// Refresh the evidence without disturbing when it was first seen.
			byPair.get(key).observations = verdict.observations;
			byPair.get(key).lastSeen = now.toISOString();
			continue;
		}

		const alias = {
			from,
			to,
			confirmedAt: now.toISOString(),
			lastSeen: now.toISOString(),
			observations: verdict.observations,
			since: verdict.since || null,
			source: "detected",
		};

		byPair.set(key, alias);
		learned.push(alias);
	}

	const aliases = [...byPair.values()].sort((a, b) => a.from.localeCompare(b.from));
	writeAliases(resultsDir, aliases);

	return { aliases, learned };
}

/**
 * All URLs whose history belongs to `url`, following alias chains backwards.
 *
 * Returns oldest-origin first, ending with the current URL, so a merged series
 * reads chronologically. Cycles are broken rather than followed — a redirect
 * loop is a site bug, not a reason to hang the build.
 */
export function resolveHistoryUrls(url, aliases, previousUrls = []) {
	const current = normalizeUrl(url);

	// Manual declarations are treated exactly like detected ones, so a config
	// entry works whether or not the redirect was ever observed.
	const edges = [
		...aliases.map((a) => ({ from: normalizeUrl(a.from), to: normalizeUrl(a.to) })),
		...previousUrls.map((p) => ({ from: normalizeUrl(p), to: current })),
	];

	const seen = new Set([current]);
	const ordered = [];
	const queue = [current];

	while (queue.length) {
		const target = queue.shift();
		for (let edge of edges) {
			if (edge.to !== target || seen.has(edge.from)) continue;
			seen.add(edge.from);
			ordered.unshift(edge.from);
			queue.push(edge.from);
		}
	}

	return [...ordered, current];
}

/**
 * Follow confirmed moves *forward* to where a URL lives now.
 *
 * `resolveHistoryUrls` walks backwards to collect a site's past; this walks the
 * other way to answer "given what the config says, what should we actually be
 * measuring today?".
 *
 * This is what makes a site move need no config edit. Once a redirect has been
 * confirmed — permanent, and stable across several runs — measurement follows
 * it on its own, and the old address becomes history rather than a task.
 *
 * Cycles are broken rather than followed: a redirect loop is a site bug, not a
 * reason to hang.
 */
export function resolveCurrentUrl(url, aliases) {
	const forward = new Map();
	for (let alias of aliases) {
		const from = normalizeUrl(alias.from);
		// First alias wins if a URL somehow has two destinations; a stable answer
		// matters more than picking the "best" one.
		if (!forward.has(from)) forward.set(from, normalizeUrl(alias.to));
	}

	let current = normalizeUrl(url);
	const seen = new Set([current]);

	while (forward.has(current)) {
		const next = forward.get(current);
		if (seen.has(next)) break;
		seen.add(next);
		current = next;
	}

	return current;
}

/**
 * Rewrite a site list so each entry points at where it lives now.
 *
 * The configured URL is not lost — it moves into `previousUrls`, which is what
 * stitches the old history onto the new address.
 */
export function applyAliases(sites, aliases, hashFn) {
	if (!aliases.length) return sites;

	const moved = sites.map((site) => {
		const current = resolveCurrentUrl(site.url, aliases);
		if (current === site.url) return site;

		return {
			...site,
			url: current,
			hash: hashFn(current),
			// Keep the whole chain, oldest first, so nothing is orphaned.
			previousUrls: [...new Set([...(site.previousUrls || []), site.url])],
			// Recorded so the UI can say the move happened without being asked to.
			movedAutomatically: true,
			configuredUrl: site.url,
		};
	});

	// A move can land on a URL that is already configured in its own right —
	// two contacts converging on one site, or a redirect to something already in
	// the list. Measuring it twice would fork the history and hit that server
	// twice as often, so the entries are merged.
	const byUrl = new Map();

	for (let site of moved) {
		const existing = byUrl.get(site.url);
		if (!existing) {
			byUrl.set(site.url, site);
			continue;
		}

		// Prefer the entry that was configured at this URL directly — it is the
		// one whose name and group the author actually chose.
		const winner = existing.movedAutomatically && !site.movedAutomatically ? site : existing;
		const loser = winner === existing ? site : existing;

		byUrl.set(site.url, {
			...winner,
			previousUrls: [...new Set([...(winner.previousUrls || []), ...(loser.previousUrls || [])])],
			mergedFrom: [...(winner.mergedFrom || []), loser.configuredUrl || loser.url],
		});
	}

	return [...byUrl.values()];
}

/** Aliases pointing at a URL that isn't measured anywhere — the "update your config" case. */
export function danglingAliases(aliases, configuredUrls) {
	const configured = new Set(configuredUrls.map(normalizeUrl));
	return aliases.filter((a) => configured.has(normalizeUrl(a.from)) && !configured.has(normalizeUrl(a.to)));
}
