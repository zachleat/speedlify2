import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	extractRedirect,
	confirmRedirect,
	classifyChange,
	isRetiredDestination,
	isLandingRedirect,
} from "../lib/redirect.js";
import { resolveHistoryUrls, danglingAliases, resolveCurrentUrl, applyAliases } from "../lib/aliases.js";

/** Minimal LHR with a redirect chain and per-hop status codes. */
function lhr(from, to, statuses = [301]) {
	const urls = Array.isArray(to) ? [from, ...to] : [from, to];
	return {
		requestedUrl: from,
		finalDisplayedUrl: urls[urls.length - 1],
		audits: {
			redirects: { details: { items: urls.map((url) => ({ url })) } },
			"network-requests": {
				details: {
					items: urls.map((url, i) => ({
						url,
						statusCode: i < urls.length - 1 ? statuses[i] ?? statuses[0] : 200,
					})),
				},
			},
		},
	};
}

describe("extractRedirect", () => {
	test("returns null when the requested URL is where we landed", () => {
		assert.equal(extractRedirect(lhr("https://a.com/", "https://a.com/")), null);
	});

	test("ignores cosmetic differences that are not a move", () => {
		const r = extractRedirect({
			requestedUrl: "https://a.com",
			finalDisplayedUrl: "https://a.com/",
			audits: {},
		});
		assert.equal(r, null, "a trailing slash is not a site move");
	});

	test("detects a permanent host change", () => {
		const r = extractRedirect(lhr("https://old.com/", "https://new.com/", [301]));
		assert.equal(r.from, "https://old.com/");
		assert.equal(r.to, "https://new.com/");
		assert.equal(r.change, "host");
		assert.equal(r.permanent, true);
		assert.equal(r.hops, 1);
	});

	test("treats 308 as permanent", () => {
		assert.equal(extractRedirect(lhr("https://old.com/", "https://new.com/", [308])).permanent, true);
	});

	test("treats 302 as temporary", () => {
		const r = extractRedirect(lhr("https://a.com/", "https://b.com/", [302]));
		assert.equal(r.permanent, false);
	});

	test("treats an http to https upgrade as permanent despite a 307", () => {
		// Chrome reports HSTS upgrades as an internal 307. Calling that temporary
		// would mean never carrying history across the commonest migration there is.
		const r = extractRedirect(lhr("http://a.com/", "https://a.com/", [307]));
		assert.equal(r.schemeUpgrade, true);
		assert.equal(r.permanent, true);
		assert.equal(r.change, "scheme");
	});

	test("does not treat a 307 to a different host as permanent", () => {
		const r = extractRedirect(lhr("http://a.com/", "https://b.com/", [307]));
		assert.equal(r.schemeUpgrade, false);
		assert.equal(r.permanent, false);
	});

	test("follows a multi-hop chain", () => {
		const r = extractRedirect(lhr("http://a.com/", ["https://a.com/", "https://b.com/"], [301, 301]));
		assert.equal(r.hops, 2);
		assert.equal(r.to, "https://b.com/");
		assert.equal(r.permanent, true);
	});

	test("a mixed chain with any temporary hop is not permanent", () => {
		const r = extractRedirect(lhr("http://a.com/", ["https://a.com/", "https://b.com/"], [301, 302]));
		assert.equal(r.permanent, false);
	});
});

describe("classifyChange", () => {
	test("names what changed", () => {
		assert.equal(classifyChange("http://a.com/", "https://a.com/"), "scheme");
		assert.equal(classifyChange("https://a.com/", "https://b.com/"), "host");
		assert.equal(classifyChange("https://a.com/x", "https://a.com/y"), "path");
		assert.equal(classifyChange("https://a.com/x", "https://b.com/y"), "host+path");
		assert.equal(classifyChange("https://a.com/", "https://a.com/"), "none");
	});
});

describe("confirmRedirect", () => {
	const point = (t, to, perm = 1) => ({ t, date: new Date(t).toISOString(), error: null, to, perm });

	test("needs enough measurements before confirming", () => {
		const v = confirmRedirect([point(1, "https://b.com/"), point(2, "https://b.com/")], { confirmations: 3 });
		assert.equal(v.confirmed, false);
		assert.equal(v.reason, "not-enough-measurements");
	});

	test("confirms a stable permanent destination", () => {
		const points = [1, 2, 3].map((t) => point(t, "https://b.com/"));
		const v = confirmRedirect(points, { confirmations: 3 });
		assert.equal(v.confirmed, true);
		assert.equal(v.target, "https://b.com/");
	});

	test("rejects an inconsistent destination", () => {
		// The A/B test case: permanent-looking, but not the same place twice.
		const points = [point(1, "https://b.com/"), point(2, "https://c.com/"), point(3, "https://b.com/")];
		const v = confirmRedirect(points, { confirmations: 3 });
		assert.equal(v.confirmed, false);
		assert.equal(v.reason, "unstable");
	});

	test("rejects a temporary redirect even when stable", () => {
		const points = [1, 2, 3].map((t) => point(t, "https://b.com/", 0));
		const v = confirmRedirect(points, { confirmations: 3 });
		assert.equal(v.confirmed, false);
		assert.equal(v.reason, "temporary");
	});

	test("rejects when the redirect has stopped", () => {
		const points = [point(1, "https://b.com/"), point(2, null), point(3, null)];
		const v = confirmRedirect(points, { confirmations: 3 });
		assert.equal(v.confirmed, false);
	});

	test("only considers the most recent window", () => {
		// Redirected somewhere else long ago, but consistent lately.
		const points = [point(1, "https://old.com/"), ...[2, 3, 4].map((t) => point(t, "https://b.com/"))];
		const v = confirmRedirect(points, { confirmations: 3 });
		assert.equal(v.confirmed, true);
		assert.equal(v.target, "https://b.com/");
	});

	test("ignores failed measurements", () => {
		const points = [
			point(1, "https://b.com/"),
			{ t: 2, error: "timeout" },
			point(3, "https://b.com/"),
			point(4, "https://b.com/"),
		];
		assert.equal(confirmRedirect(points, { confirmations: 3 }).confirmed, true);
	});
});

describe("resolveHistoryUrls", () => {
	const alias = (from, to) => ({ from, to });

	test("returns just the URL when nothing moved", () => {
		assert.deepEqual(resolveHistoryUrls("https://a.com/", [], []), ["https://a.com/"]);
	});

	test("puts the predecessor before the current URL", () => {
		const out = resolveHistoryUrls("https://b.com/", [alias("https://a.com/", "https://b.com/")], []);
		assert.deepEqual(out, ["https://a.com/", "https://b.com/"]);
	});

	test("follows a chain of moves oldest first", () => {
		const aliases = [alias("https://a.com/", "https://b.com/"), alias("https://b.com/", "https://c.com/")];
		assert.deepEqual(resolveHistoryUrls("https://c.com/", aliases, []), [
			"https://a.com/",
			"https://b.com/",
			"https://c.com/",
		]);
	});

	test("accepts manually declared previousUrls", () => {
		const out = resolveHistoryUrls("https://b.com/", [], ["https://a.com/"]);
		assert.deepEqual(out, ["https://a.com/", "https://b.com/"]);
	});

	test("does not hang on a redirect loop", () => {
		const aliases = [alias("https://a.com/", "https://b.com/"), alias("https://b.com/", "https://a.com/")];
		const out = resolveHistoryUrls("https://a.com/", aliases, []);
		assert.ok(out.includes("https://a.com/"));
		assert.equal(new Set(out).size, out.length, "no URL should appear twice");
	});

	test("ignores aliases for other sites", () => {
		const aliases = [alias("https://x.com/", "https://y.com/")];
		assert.deepEqual(resolveHistoryUrls("https://a.com/", aliases, []), ["https://a.com/"]);
	});
});

describe("danglingAliases", () => {
	test("flags a move whose destination nobody measures", () => {
		const aliases = [{ from: "https://a.com/", to: "https://b.com/" }];
		assert.equal(danglingAliases(aliases, ["https://a.com/"]).length, 1);
		assert.equal(danglingAliases(aliases, ["https://a.com/", "https://b.com/"]).length, 0);
	});
});

describe("resolveCurrentUrl", () => {
	const alias = (from, to) => ({ from, to });

	test("returns the URL unchanged when nothing has moved", () => {
		assert.equal(resolveCurrentUrl("https://a.com/", []), "https://a.com/");
	});

	test("follows a confirmed move forward", () => {
		const out = resolveCurrentUrl("https://a.com/", [alias("https://a.com/", "https://b.com/")]);
		assert.equal(out, "https://b.com/");
	});

	test("follows a chain of moves to the end", () => {
		const aliases = [alias("https://a.com/", "https://b.com/"), alias("https://b.com/", "https://c.com/")];
		assert.equal(resolveCurrentUrl("https://a.com/", aliases), "https://c.com/");
	});

	test("does not hang on a redirect loop", () => {
		const aliases = [alias("https://a.com/", "https://b.com/"), alias("https://b.com/", "https://a.com/")];
		const out = resolveCurrentUrl("https://a.com/", aliases);
		assert.ok(out === "https://a.com/" || out === "https://b.com/");
	});
});

describe("applyAliases", () => {
	const hash = (u) => u.replace(/\W/g, "").slice(0, 12);
	const site = (url, extra = {}) => ({ url, hash: hash(url), previousUrls: [], name: url, ...extra });

	test("leaves untouched sites alone", () => {
		const sites = [site("https://a.com/")];
		assert.equal(applyAliases(sites, [], hash), sites, "no aliases means the same array back");
	});

	test("repoints a moved site and records where it came from", () => {
		const out = applyAliases(
			[site("https://old.com/")],
			[{ from: "https://old.com/", to: "https://new.com/" }],
			hash
		);

		assert.equal(out[0].url, "https://new.com/");
		assert.equal(out[0].hash, hash("https://new.com/"));
		assert.deepEqual(out[0].previousUrls, ["https://old.com/"], "old URL becomes history, not an orphan");
		assert.equal(out[0].movedAutomatically, true);
		assert.equal(out[0].configuredUrl, "https://old.com/");
	});

	test("keeps the group and name from the config entry", () => {
		const out = applyAliases(
			[site("https://old.com/", { group: "g", name: "Old Name" })],
			[{ from: "https://old.com/", to: "https://new.com/" }],
			hash
		);
		assert.equal(out[0].group, "g");
		assert.equal(out[0].name, "Old Name");
	});

	test("merges when a move lands on an already-configured URL", () => {
		// Measuring it twice would fork the history and double the traffic.
		const sites = [site("https://old.com/"), site("https://new.com/", { name: "Canonical" })];
		const out = applyAliases(sites, [{ from: "https://old.com/", to: "https://new.com/" }], hash);

		assert.equal(out.length, 1, "the two entries collapse into one");
		assert.equal(out[0].url, "https://new.com/");
		assert.equal(out[0].name, "Canonical", "the directly-configured entry wins");
		assert.ok(out[0].previousUrls.includes("https://old.com/"), "and absorbs the other's history");
	});

	test("two sites moving to the same destination also merge", () => {
		const sites = [site("https://a.com/"), site("https://b.com/")];
		const aliases = [
			{ from: "https://a.com/", to: "https://c.com/" },
			{ from: "https://b.com/", to: "https://c.com/" },
		];
		const out = applyAliases(sites, aliases, hash);

		assert.equal(out.length, 1);
		assert.equal(out[0].url, "https://c.com/");
		assert.equal(out[0].previousUrls.length, 2);
	});
});

describe("isLandingRedirect", () => {
	/**
	 * A root origin pointing at the page it serves there is not a move. Following
	 * one re-keys the site onto a locale path, forks its history, and renames it
	 * after a CMS detail — the case that put Intel at
	 * /site/www-intel-com-content-www-us-en-homepage-html/.
	 */
	test("recognizes a root origin pointing at its own landing path", () => {
		assert.equal(isLandingRedirect("https://www.sap.com/", "https://www.sap.com/index.html"), true);
		assert.equal(isLandingRedirect("https://www.amd.com/", "https://www.amd.com/en.html"), true);
		assert.equal(isLandingRedirect("https://www.samsung.com/", "https://www.samsung.com/us"), true);
		assert.equal(
			isLandingRedirect("https://www.intel.com/", "https://www.intel.com/content/www/us/en/homepage.html"),
			true
		);
	});

	test("covers a root that negotiates with a query string instead of a path", () => {
		assert.equal(isLandingRedirect("https://a.com/", "https://a.com/?locale=us"), true);
	});

	test("a configured deep path that relocates is still a move", () => {
		assert.equal(isLandingRedirect("https://a.com/docs", "https://a.com/guide"), false);
	});

	test("a different host is a move even from a root", () => {
		assert.equal(isLandingRedirect("https://a.com/", "https://b.com/en"), false);
		assert.equal(isLandingRedirect("https://a.com/", "https://www.a.com/en"), false, "www is a separate site here");
	});

	test("is false when nothing moved and for unparseable input", () => {
		assert.equal(isLandingRedirect("https://a.com/", "https://a.com/"), false);
		assert.equal(isLandingRedirect("not a url", "https://a.com/en"), false);
		assert.equal(isLandingRedirect(null, undefined), false);
	});

	test("a scheme upgrade onto a landing path is still not a move", () => {
		assert.equal(isLandingRedirect("http://a.com/", "https://a.com/en.html"), true);
	});
});

describe("isRetiredDestination", () => {
	/**
	 * A domain landing on a registrar's for-sale page has lapsed, not moved.
	 * Retiring on sight is only safe if the match is tight: a false positive
	 * drops a live site out of the leaderboard entirely.
	 */
	test("matches the parking host and its subdomains", () => {
		assert.equal(isRetiredDestination("https://forsale.godaddy.com/"), true);
		assert.equal(isRetiredDestination("https://forsale.godaddy.com/domain/example.com"), true);
		assert.equal(isRetiredDestination("https://www.forsale.godaddy.com/x"), true);
		assert.equal(isRetiredDestination("HTTPS://ForSale.GoDaddy.com/"), true, "host match is case-insensitive");
	});

	test("does not match the registrar's other hosts", () => {
		assert.equal(isRetiredDestination("https://godaddy.com/"), false);
		assert.equal(isRetiredDestination("https://www.godaddy.com/en-uk/"), false);
	});

	test("cannot be spoofed by a lookalike host", () => {
		// Suffix matching without the dot would accept this.
		assert.equal(isRetiredDestination("https://notforsale.godaddy.com.example/"), false);
		assert.equal(isRetiredDestination("https://forsale.godaddy.com.example/"), false);
	});

	test("is false for anything unparseable or absent", () => {
		assert.equal(isRetiredDestination("not a url"), false);
		assert.equal(isRetiredDestination(""), false);
		assert.equal(isRetiredDestination(null), false);
		assert.equal(isRetiredDestination(undefined), false);
	});
});
