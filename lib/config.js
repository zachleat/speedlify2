import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeUrl, urlHash } from "./hash.js";

/**
 * Settings a group or an individual site may override.
 *
 * All three are cadences, and all are "smaller is stricter" — a lower
 * `freshnessHours` means measured more often, a lower `staleAfterHours` means
 * flagged as old sooner, a lower `retryErrorsAfterHours` means a failure is
 * re-attempted sooner. That matters because a URL can belong to several
 * categories: when two disagree, the strictest wins, so listing a site in a
 * fast-refresh category cannot be undone by also listing it in a slow one.
 */
const OVERRIDABLE = ["freshnessHours", "staleAfterHours", "retryErrorsAfterHours"];

/**
 * How much of a site's pictures to keep, cheapest first.
 *
 * - "none" keeps only the header screenshot every site page needs.
 * - "primary" adds the no-JS capture beside it, which is what the Without
 *   JavaScript section compares against — a second viewport shot, and no more.
 * - "filmstrip" adds Lighthouse's loading filmstrip on top, which is the
 *   expensive part: every distinct frame of the load.
 *
 * Ordered, and read as an order — `richestScreenshots` compares by index, so a
 * site in two categories gets the more complete of the two.
 *
 * Everything is captured either way; this is about what goes in the repository,
 * since `results/` is committed: measure and publish are separate workflows on
 * separate checkouts, and git is the only channel between them.
 *
 * Worth knowing what that costs. A deduplicated strip measured 19–84 KB per
 * site across this corpus against roughly 30 KB for the no-JS capture, and
 * every site is re-measured at least weekly, so filmstrips everywhere means
 * roughly 75 MB in the tree and the same again written into history each week.
 * "primary" is the middle lever for a category that wants the comparison but
 * not the strip.
 */
const SCREENSHOT_MODES = ["none", "primary", "filmstrip"];

function resolveScreenshots(site, group, config) {
	const value = site.screenshots ?? group.screenshots ?? config.screenshots ?? "filmstrip";
	// A typo here would silently stop collecting, or silently collect 5x more
	// than intended. Neither shows up until the repository has grown.
	if (!SCREENSHOT_MODES.includes(value)) {
		throw new Error(`Unknown screenshots mode ${JSON.stringify(value)} — expected one of ${SCREENSHOT_MODES.join(", ")}`);
	}
	return value;
}

/** The more complete of two modes: a site in two categories gets the richer one. */
function richestScreenshots(a, b) {
	return SCREENSHOT_MODES.indexOf(a) >= SCREENSHOT_MODES.indexOf(b) ? a : b;
}

/** site > group > top level, for one setting. */
function resolveOverride(key, site, group, config) {
	return site[key] ?? group[key] ?? config[key];
}

/** The stricter of two cadences, tolerating either being absent. */
function strictest(a, b) {
	if (typeof a !== "number") return b;
	if (typeof b !== "number") return a;
	return Math.min(a, b);
}

const DEFAULTS = {
	runs: 3,
	formFactor: "mobile",
	freshnessHours: 20,
	batchSize: null,
	staleAfterHours: 48,
	historyLimit: 120,
	redirectConfirmations: 3,
	retryErrorsAfterHours: 0,
	failureBackoff: false,
	/*
	 * Consecutive failed measurements before a site is archived automatically.
	 *
	 * With `failureBackoff` on, retries settle to roughly daily, so this is
	 * about "down for a fortnight" rather than a number of runs. Long enough
	 * that a bad week — an expired certificate, a host migration, a fortnight of
	 * downtime — does not take a live site off the board.
	 *
	 * Set to 0 to turn it off entirely.
	 */
	archiveAfterFailures: 14,
	logRows: 30,
	ranking: { useFieldData: true, fieldDataTier: "afterTotal" },
	groups: {},
};

/** Load config/sites.js and flatten it into a list of measurable sites. */
export async function loadConfig(file = "config/sites.js") {
	const abs = path.resolve(file);
	const mod = await import(pathToFileURL(abs).href);
	const config = { ...DEFAULTS, ...(mod.default || {}) };

	/**
	 * URLs taken out of circulation, normalized so the list can be written the
	 * way a person would type it rather than the way we store it.
	 *
	 * Marked rather than removed: a site dropped from the config here would
	 * leave its stored history with nothing claiming it, which the report would
	 * then report as an orphan. Archiving is the opposite of losing the record.
	 */
	const archived = new Set((config.archived || []).map(normalizeUrl));

	/**
	 * URLs exempt from the generator rules — see `config.pinned`.
	 *
	 * A site is normally reclassified by what its page says built it, which is
	 * right almost always and wrong in the cases a person has to override by
	 * hand: a stale generator tag, a proxy that stamps its own, a site that
	 * reports one thing and is built with another. Listing a URL here says
	 * "leave this one where the config puts it".
	 */
	const pinned = new Set((config.pinned || []).map(normalizeUrl));

	/**
	 * One entry per URL, however many categories it appears in.
	 *
	 * A URL may be listed in several groups, or tagged with `groups: [...]`, but
	 * it is still measured once and stored once — group membership is a
	 * presentation concern. Two entries for one URL would write two histories
	 * into the same directory, interleave them, and double the traffic to that
	 * server.
	 */
	/**
	 * Categories switched off with `enabled: false`.
	 *
	 * A disabled category is inert rather than deleted: its sites keep their
	 * stored history, and re-enabling it picks that history straight back up.
	 * What it loses is its membership — so a site listed only there stops being
	 * measured, and its history reads as orphaned until the category returns.
	 */
	const disabled = new Set(
		Object.entries(config.groups)
			.filter(([, group]) => group.enabled === false)
			.map(([id]) => id),
	);

	const byUrl = new Map();

	for (let [groupId, group] of Object.entries(config.groups)) {
		if (disabled.has(groupId)) continue;

		for (let site of group.sites || []) {
			const url = normalizeUrl(site.url);

			// A site may name additional categories rather than being listed again.
			// A membership naming a disabled category is dropped here rather than
			// rejected below: switching a category off should not turn every site
			// that references it into a config error.
			const memberships = [groupId, ...(site.groups || [])].filter((id) => !disabled.has(id));

			const existing = byUrl.get(url);
			if (existing) {
				for (let id of memberships) {
					if (!existing.groups.includes(id)) existing.groups.push(id);
				}
				// A later listing may carry detail the first one omitted.
				if (!existing.name && site.name) existing.name = site.name;
				existing.previousUrls = [
					...new Set([...existing.previousUrls, ...(site.previousUrls || []).map(normalizeUrl)]),
				];
				existing.rateLimit = existing.rateLimit || site.rateLimit || group.rateLimit || config.rateLimit || null;
				existing.screenshots = richestScreenshots(existing.screenshots, resolveScreenshots(site, group, config));
				// Another category's cadence applies too, and the stricter one wins.
				for (let key of OVERRIDABLE) {
					existing[key] = strictest(existing[key], resolveOverride(key, site, group, config));
				}
				continue;
			}

			byUrl.set(url, {
				...site,
				url,
				hash: urlHash(url),
				name: site.name || new URL(url).hostname,
				// Not measured, not ranked, not linked — see `config.archived`.
				archived: archived.has(url),
				// Held in the categories the config lists it in, whatever its
				// generator turns out to be. `site.pinGroup` is spread in above, so
				// a hand-written entry can set it directly; this is the list form,
				// for URLs that come from a generated file and cannot carry a flag.
				pinGroup: pinned.has(url) || site.pinGroup === true,
				// Every category this URL belongs to. `group` below is the first,
				// used wherever a single primary is needed.
				groups: [...new Set(memberships)],
				// Explicit predecessors, whose history merges into this site's.
				previousUrls: (site.previousUrls || []).map(normalizeUrl),
				// Politeness, inherited from the group unless the site overrides it.
				rateLimit: site.rateLimit || group.rateLimit || config.rateLimit || null,
				// How much of the loading filmstrip to keep, same inheritance.
				screenshots: resolveScreenshots(site, group, config),
				// Cadences, inherited site → group → top level. Spread from the same
				// list the merge path above uses, so adding a setting to
				// OVERRIDABLE cannot reach one branch and miss the other.
				...Object.fromEntries(
					OVERRIDABLE.map((key) => [key, resolveOverride(key, site, group, config)]),
				),
			});
		}
	}

	const sites = [...byUrl.values()];

	// A rule pointing at a category that is switched off has nowhere to send
	// anything, so it is dropped rather than left to fail at report time.
	const groups = Object.fromEntries(
		Object.entries(config.groups)
			.filter(([id]) => !disabled.has(id))
			.map(([id, group]) => [
				id,
				{
					...group,
					emeritusGroup: disabled.has(group.emeritusGroup) ? undefined : group.emeritusGroup,
					rejectGroup: disabled.has(group.rejectGroup) ? undefined : group.rejectGroup,
				},
			]),
	);
	config.groups = groups;

	// Resolve group names once, and reject memberships that name no real group —
	// a typo would otherwise just make a site quietly vanish from a table.
	for (let site of sites) {
		for (let id of site.groups) {
			if (!config.groups[id]) {
				throw new Error(`${site.url} lists group "${id}", which is not defined in config/sites.js`);
			}
		}
		site.group = site.groups[0];
		site.groupName = config.groups[site.group].name || site.group;
		site.groupNames = site.groups.map((id) => config.groups[id].name || id);
	}

	// A URL that is both measured in its own right and claimed as another site's
	// predecessor would have its history counted twice, in two different places.
	const measured = new Set(sites.map((s) => s.url));
	for (let site of sites) {
		for (let previous of site.previousUrls) {
			if (measured.has(previous)) {
				throw new Error(
					`${previous} is listed as a previousUrl of ${site.url}, but is also measured as its own site. ` +
						`Remove one of the two.`
				);
			}
			if (previous === site.url) {
				throw new Error(`${site.url} lists itself as a previousUrl.`);
			}
		}
	}

	return { ...config, sites };
}

/** Filter the site list from CLI flags. */
export function selectSites(sites, { group, url, filter } = {}) {
	let out = sites;

	if (group) {
		const groups = new Set(group.split(",").map((g) => g.trim()));
		// Match any membership, not just the primary one.
		out = out.filter((s) => (s.groups || [s.group]).some((id) => groups.has(id)));
	}

	if (url) {
		const target = normalizeUrl(url);
		out = out.filter((s) => s.url === target);
	}

	if (filter) {
		const needle = filter.toLowerCase();
		out = out.filter(
			(s) => s.name.toLowerCase().includes(needle) || s.url.toLowerCase().includes(needle)
		);
	}

	return out;
}
