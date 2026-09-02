import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { asBotCheckFailure, labLooksChallenged, throttleWait, hostOf } from "../lib/runner.js";
import { challengedAxe } from "../lib/stack.js";

/**
 * Pacing rules for measuring other people's servers. Pure, so these run
 * instantly and without launching a browser.
 */

const NOW = 1_000_000;
const limit = { delayMs: 3000, hostCooldownMs: 60000 };

describe("throttleWait", () => {
	test("no rate limit means no wait", () => {
		assert.equal(throttleWait({ rateLimit: null, now: NOW, lastFinishedAt: NOW - 1 }), 0);
	});

	test("the first site is never delayed", () => {
		assert.equal(throttleWait({ rateLimit: limit, host: "a.example", now: NOW, lastFinishedAt: null }), 0);
	});

	test("waits out the remainder of the between-site delay", () => {
		// 1s since the last measurement finished, 3s required.
		const wait = throttleWait({ rateLimit: limit, host: "a.example", now: NOW, lastFinishedAt: NOW - 1000 });
		assert.equal(wait, 2000);
	});

	test("no wait once the delay has already elapsed", () => {
		const wait = throttleWait({ rateLimit: limit, host: "a.example", now: NOW, lastFinishedAt: NOW - 5000 });
		assert.equal(wait, 0);
	});

	test("holds off a host that was touched recently", () => {
		// Between-site delay satisfied, but this host was hit 10s ago.
		const lastHostAt = new Map([["a.example", NOW - 10000]]);
		const wait = throttleWait({
			rateLimit: limit,
			host: "a.example",
			now: NOW,
			lastFinishedAt: NOW - 5000,
			lastHostAt,
		});
		assert.equal(wait, 50000, "the host cooldown still has 50s to run");
	});

	test("a different host is unaffected by another host's cooldown", () => {
		const lastHostAt = new Map([["a.example", NOW - 10]]);
		const wait = throttleWait({
			rateLimit: limit,
			host: "b.example",
			now: NOW,
			lastFinishedAt: NOW - 5000,
			lastHostAt,
		});
		assert.equal(wait, 0);
	});

	test("the longer of the two limits wins", () => {
		const lastHostAt = new Map([["a.example", NOW - 59000]]);
		// Between-site delay wants 2000ms; host cooldown wants 1000ms.
		const wait = throttleWait({
			rateLimit: limit,
			host: "a.example",
			now: NOW,
			lastFinishedAt: NOW - 1000,
			lastHostAt,
		});
		assert.equal(wait, 2000);
	});

	test("never returns a negative wait", () => {
		const wait = throttleWait({
			rateLimit: limit,
			host: "a.example",
			now: NOW,
			lastFinishedAt: NOW - 999999,
			lastHostAt: new Map([["a.example", NOW - 999999]]),
		});
		assert.equal(wait, 0);
	});

	test("either limit can be configured alone", () => {
		const delayOnly = throttleWait({
			rateLimit: { delayMs: 3000 },
			host: "a.example",
			now: NOW,
			lastFinishedAt: NOW - 1000,
			lastHostAt: new Map([["a.example", NOW - 1]]),
		});
		assert.equal(delayOnly, 2000, "host cooldown is off, so only the delay applies");

		const hostOnly = throttleWait({
			rateLimit: { hostCooldownMs: 60000 },
			host: "a.example",
			now: NOW,
			lastFinishedAt: NOW - 1,
			lastHostAt: new Map([["a.example", NOW - 30000]]),
		});
		assert.equal(hostOnly, 30000, "delay is off, so only the cooldown applies");
	});

	test("an unparseable URL still respects the between-site delay", () => {
		const wait = throttleWait({ rateLimit: limit, host: null, now: NOW, lastFinishedAt: NOW - 1000 });
		assert.equal(wait, 2000);
	});
});

describe("hostOf", () => {
	test("extracts the hostname", () => {
		assert.equal(hostOf("https://example.com/some/path"), "example.com");
		assert.equal(hostOf("http://sub.example.com:8080/"), "sub.example.com");
	});

	test("returns null rather than throwing on junk", () => {
		assert.equal(hostOf("not a url"), null);
		assert.equal(hostOf(undefined), null);
	});
});

describe("bot checks are per page load", () => {
	// Both challenged sites in this corpus look like this: the Lighthouse runs
	// measured the real page and only the separate accessibility pass was
	// served a waiting room.
	const realPage = { weight: { requests: 72 }, dom: { elements: 1164 }, scores: { performance: 65 } };
	const waitingRoom = { weight: { requests: 4 }, dom: { elements: 18 }, scores: { performance: 99 } };

	test("a challenged probe does not condemn the Lighthouse runs", () => {
		assert.equal(labLooksChallenged(realPage), false);
	});

	test("a lab run the size of a waiting room is recognized as one", () => {
		assert.equal(labLooksChallenged(waitingRoom), true);
	});

	test("a small but real page is not called a bot check on size alone", () => {
		// jakebeamish.com: 526 bytes and three elements, and entirely real. It is
		// only ever tested at all when its probe was already challenged, but the
		// request count is what keeps it out.
		assert.equal(labLooksChallenged({ weight: { requests: 12 }, dom: { elements: 3 } }), false);
	});

	test("missing numbers are never read as a bot check", () => {
		assert.equal(labLooksChallenged(null), false);
		assert.equal(labLooksChallenged({ weight: {}, dom: {} }), false);
	});

	test("a challenged axe pass keeps the host and drops the findings", () => {
		const axe = {
			interstitial: "Vercel Security Checkpoint",
			generator: { name: "Next.js" },
			host: { id: "vercel", name: "Vercel" },
			headers: { server: "Vercel" },
			violations: 1,
			passes: 39,
			incomplete: 0,
			violationRules: 1,
			top: [{ id: "page-has-heading-one" }],
		};

		const out = challengedAxe(axe);

		// The checkpoint's accessibility is not this site's, and null reads as
		// "not judged" downstream rather than as a clean result.
		assert.equal(out.violations, null);
		assert.equal(out.passes, null);
		assert.deepEqual(out.top, []);
		assert.equal(out.generator, null, "read out of the challenge page's markup");

		// A challenge is served by whatever sits in front of the site, so this
		// stays true.
		assert.deepEqual(out.host, axe.host);
		assert.deepEqual(out.headers, axe.headers);
		assert.equal(out.interstitial, "Vercel Security Checkpoint");
	});

	test("a measurement challenged on every load is stored as a failure", () => {
		const record = {
			url: "https://example.com/",
			timestamp: 1,
			axe: { interstitial: "Just a moment..." },
			field: { metrics: { lcp: { p75: 1200 } } },
			pageShots: { js: "buffer" },
			screenshots: ["frame"],
			lab: waitingRoom,
			variance: { spread: 2 },
		};

		const out = asBotCheckFailure(record);

		// A waiting room has no images and no third parties, so it scores well —
		// keeping its numbers ranks a page nobody served.
		assert.equal(out.lab, undefined);
		assert.equal(out.variance, undefined);
		assert.equal(out.completedRuns, 0);
		assert.equal(out.error, "bot check: Just a moment...");
		assert.equal(out.botCheck, "Just a moment...");

		// CrUX came from real users of the real site and never touched our request.
		assert.deepEqual(out.field, record.field);
		assert.equal(out.screenshots, undefined, "eight frames of a spinner");
	});
});
