/**
 * The published `/api/` documents, built here so the per-site and per-group files share one projection.
 */

function lighthouse(lab) {
	return {
		performance: lab.scores.performance ?? null,
		accessibility: lab.scores.accessibility ?? null,
		bestPractices: lab.scores["best-practices"] ?? null,
		seo: lab.scores.seo ?? null,
	};
}

function cwv(entry) {
	if (!entry.cwv) return null;
	return {
		source: entry.cwv.source ?? null,
		pass: entry.cwv.pass ?? null,
		parts: (entry.cwv.parts || []).map((p) => ({ key: p.key, value: p.value ?? null, rating: p.rating ?? null })),
	};
}

function rank(entry) {
	return entry.ranks?.overall || null;
}

/** `/api/site/<slug>.json`. */
export function siteApi(entry) {
	const out = {
		url: entry.url,
		name: entry.displayUrl,
		page: `/site/${entry.slug}/`,
		measured: Boolean(entry.latest),
		updated: entry.latest?.date ?? null,
		stale: Boolean(entry.dataStale),
		rank: rank(entry),
		group: entry.groupName,
	};
	if (!entry.latest) return out;

	const lab = entry.latest.lab;
	return {
		...out,
		total: entry.lighthouseTotal ?? null,
		lighthouse: lighthouse(lab),
		metrics: {
			lcp: lab.timings.lcp ?? null,
			cls: lab.timings.cls ?? null,
			tbt: lab.timings.tbt ?? null,
			weight: lab.weight.total ?? null,
			requests: lab.weight.requests ?? null,
		},
		axe: entry.axeViolations ?? null,
		cwv: cwv(entry),
		// Detections only: a presumed generator comes from the listing, not the page.
		generator: entry.generator?.name ?? null,
		host: entry.host?.name ?? null,
	};
}

/** One row of `/api/group/<slug>.json`, the same values as that site's own file. */
export function groupSiteApi(entry, groupId) {
	const site = siteApi(entry);
	return {
		url: site.url,
		// As written in this group's source list; a site moved here by a generator rule falls back to its first listing.
		requestedUrl: entry.listedUrls?.[groupId] ?? Object.values(entry.listedUrls ?? {})[0] ?? entry.configuredUrl ?? entry.url,
		slug: entry.slug,
		page: site.page,
		measured: site.measured,
		stale: site.stale,
		rank: site.rank,
		total: site.total ?? null,
		lighthouse: site.lighthouse ?? null,
		axe: site.axe ?? null,
		cwv: site.cwv ?? null,
	};
}

/** `/api/group/<slug>.json`: every site in the group, ranked first, unranked last. */
export function groupApi(group) {
	const updated = group.entries.reduce((newest, e) => {
		const date = e.latest?.date;
		return date && (!newest || date > newest) ? date : newest;
	}, null);
	const sites = group.entries
		.map((entry) => groupSiteApi(entry, group.id))
		// Stable, so unranked sites keep the leaderboard's order among themselves.
		.sort((a, b) => (a.rank === null) - (b.rank === null) || (a.rank ?? 0) - (b.rank ?? 0));

	return {
		group: group.name,
		slug: group.id,
		updated,
		count: sites.length,
		sites,
	};
}

/** `/api/groups.json`. */
export function groupsApi(groups) {
	return groups.map((group) => ({
		group: group.name,
		slug: group.id,
		count: group.entries.length,
		api: `/api/group/${group.id}.json`,
	}));
}
