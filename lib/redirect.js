/**
 * Redirect detection.
 *
 * A site moving to a new URL is normally invisible to a synthetic monitor:
 * Lighthouse follows the redirect, measures the new page, and files the result
 * under the old URL. The metrics change and nothing says why.
 *
 * Every record already carries the requested and final URLs. This module
 * compares them, works out whether the move looks permanent, and produces the
 * evidence the alias layer needs before it will carry history across.
 */

import { normalizeUrl } from "./hash.js";

/** Status codes that mean "this moved, update your links". */
const PERMANENT_STATUS = new Set([301, 308]);

/**
 * Destinations that mean the site is gone rather than moved.
 *
 * A domain landing on a registrar's for-sale page has not relocated — it has
 * lapsed, and someone is now selling the name. The normal redirect machinery
 * would treat that as a move in progress, wait several runs to see whether it
 * is permanent, and meanwhile keep measuring a parking page and filing the
 * numbers under the site that used to be there. There is nothing to wait for,
 * so these retire on sight.
 *
 * Matched on host, including subdomains, because the path is where the parking
 * page puts the domain being sold and varies per site.
 */
const RETIRED_HOSTS = ["forsale.godaddy.com"];

/**
 * Is this redirect destination a parking page rather than a new address?
 *
 * Host-only, deliberately: matching more than that invites false positives, and
 * the cost of a wrong answer here is a live site dropped from the leaderboard.
 */
export function isRetiredDestination(url) {
	let host;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}

	return RETIRED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Is this the site's front door pointing at the page it serves there?
 *
 * A root origin redirecting to a path on its own host — `/index.html`,
 * `/en.html`, `/us`, `/content/www/us/en/homepage.html` — has not moved. That
 * is a CMS landing path or a locale negotiation, and the address of the site is
 * still the origin: it is what the site's own links, its embeds, and everyone
 * else point at.
 *
 * Following one looks harmless and is not. It re-keys the site to a path that
 * is usually locale-dependent, so its identity comes to depend on where the
 * measurement ran; it forks the history at the moment of confirmation even
 * though every earlier run measured this same page through this same redirect;
 * and it drops the redirect hop out of the measurement, which is part of what
 * visitors actually pay for.
 *
 * Narrow on purpose. The source path must be exactly `/` — a configured deep
 * path that starts redirecting elsewhere is a real move — and the host must be
 * unchanged, since `www.example.com` and `example.com` are separate sites here.
 */
export function isLandingRedirect(from, to) {
	try {
		const a = new URL(from);
		const b = new URL(to);
		if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
		if (a.pathname !== "/" || a.search) return false;
		return b.pathname !== "/" || Boolean(b.search);
	} catch {
		return false;
	}
}

/** How the URL changed — used to judge whether a move is real. */
export function classifyChange(from, to) {
	let a, b;
	try {
		a = new URL(from);
		b = new URL(to);
	} catch {
		return "invalid";
	}

	const changed = [];
	if (a.protocol !== b.protocol) changed.push("scheme");
	if (a.hostname !== b.hostname) changed.push("host");
	if (a.pathname !== b.pathname) changed.push("path");
	if (a.search !== b.search) changed.push("query");

	if (!changed.length) return "none";
	return changed.length === 1 ? changed[0] : changed.join("+");
}

/** Is this only an http -> https upgrade of the same URL? */
function isSchemeUpgrade(from, to) {
	try {
		const a = new URL(from);
		const b = new URL(to);
		return (
			a.protocol === "http:" &&
			b.protocol === "https:" &&
			a.hostname === b.hostname &&
			a.pathname === b.pathname &&
			a.search === b.search
		);
	} catch {
		return false;
	}
}

/**
 * Pull the redirect chain out of a Lighthouse result.
 *
 * Returns null when the requested URL is where we ended up — the common case,
 * and cheaper to check than to describe.
 */
export function extractRedirect(lhr) {
	const from = lhr?.requestedUrl;
	const to = lhr?.finalDisplayedUrl ?? lhr?.mainDocumentUrl ?? lhr?.finalUrl;
	if (!from || !to) return null;

	// Compare normalized: a trailing slash is not a site move.
	if (normalizeUrl(from) === normalizeUrl(to)) return null;

	// The redirects audit lists the hops in order, ending at the final URL.
	const hops = (lhr.audits?.redirects?.details?.items || [])
		.map((i) => i.url)
		.filter(Boolean);

	// Status codes live in network-requests, keyed by URL.
	const statusByUrl = new Map();
	for (let req of lhr.audits?.["network-requests"]?.details?.items || []) {
		if (req?.url && typeof req.statusCode === "number" && !statusByUrl.has(req.url)) {
			statusByUrl.set(req.url, req.statusCode);
		}
	}

	const urls = hops.length >= 2 ? hops : [from, to];
	const chain = urls.map((url) => ({ url, status: statusByUrl.get(url) ?? null }));

	// Every hop except the destination should be a redirect status.
	const redirectStatuses = chain.slice(0, -1).map((h) => h.status).filter((s) => typeof s === "number");

	const allPermanent =
		redirectStatuses.length > 0 && redirectStatuses.every((s) => PERMANENT_STATUS.has(s));

	// Chrome reports an HSTS upgrade as an internal 307, but an http -> https
	// move of the same URL is as permanent as a move gets — treating it as
	// temporary would mean never carrying history across the most common
	// migration there is.
	const schemeUpgrade = isSchemeUpgrade(from, to);

	return {
		from: normalizeUrl(from),
		to: normalizeUrl(to),
		chain,
		statuses: redirectStatuses,
		change: classifyChange(from, to),
		permanent: allPermanent || schemeUpgrade,
		schemeUpgrade,
		hops: chain.length - 1,
	};
}

/**
 * Should a detected redirect be trusted enough to carry history across?
 *
 * Two guards, and both matter:
 *
 *  - **Permanence.** A 302/303/307 is the site telling you this is temporary.
 *    Maintenance pages, geo splits and A/B tests all look like redirects.
 *  - **Stability.** The same destination must be seen on N consecutive
 *    successful measurements. This is the guard that actually catches A/B
 *    tests and load-balancer quirks, which are permanent-looking but
 *    inconsistent.
 *
 * `points` are series points, oldest first.
 */
export function confirmRedirect(points, { confirmations = 3 } = {}) {
	const successes = points.filter((p) => !p.error);
	if (successes.length < confirmations) {
		return { confirmed: false, reason: "not-enough-measurements", observations: successes.length };
	}

	const window = successes.slice(-confirmations);

	// Every measurement in the window must have redirected to the same place.
	const targets = new Set(window.map((p) => p.to || null));
	if (targets.size !== 1) {
		return { confirmed: false, reason: "unstable", observations: window.length };
	}

	const target = [...targets][0];
	if (!target) {
		return { confirmed: false, reason: "no-redirect", observations: window.length };
	}

	// A temporary redirect anywhere in the window disqualifies it.
	if (window.some((p) => p.perm === 0)) {
		return { confirmed: false, reason: "temporary", target, observations: window.length };
	}

	return {
		confirmed: true,
		target,
		observations: window.length,
		since: window[0].date,
	};
}
