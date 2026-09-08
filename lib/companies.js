import { normalizeUrl } from "./hash.js";

/**
 * Indexes config/companies.js by site URL.
 *
 * Keyed on `normalizeUrl` so a trailing slash written one way in one file and
 * the other way in the other still matches — the two lists are maintained by
 * hand and independently, which is exactly where that drift comes from.
 */
export function indexCompanies(companies) {
	const byUrl = new Map();
	const duplicates = [];

	for (const company of companies) {
		for (const url of company.urls) {
			const key = normalizeUrl(url);
			// A site claimed by two companies would otherwise resolve to whichever
			// happened to be later in the file, silently.
			if (byUrl.has(key)) duplicates.push({ url, held: byUrl.get(key).name, also: company.name });
			else byUrl.set(key, company);
		}
	}

	return { byUrl, duplicates };
}

/** The company that owns a site, or null. */
export function companyFor(index, url) {
	return index.byUrl.get(normalizeUrl(url)) ?? null;
}

/**
 * URLs listed in one file and not the other.
 *
 * Neither is an error — a site can be added to a category before anyone has
 * looked up who owns it — but both are worth printing, because the failure they
 * cause is a dot quietly missing from a chart rather than anything louder.
 */
export function auditCompanies(companies, siteUrls) {
	const { byUrl, duplicates } = indexCompanies(companies);
	const configured = new Set(siteUrls.map(normalizeUrl));

	const unmapped = [...configured].filter((u) => !byUrl.has(u));
	const stale = [...byUrl.keys()].filter((u) => !configured.has(u));
	const missing = companies.filter((c) => c.employees === null).map((c) => c.name);

	return { unmapped, stale, duplicates, missing };
}
