import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchFieldData, fetchFieldHistory, rate } from "../lib/crux.js";

/**
 * The CrUX client is tested against mocked responses in the documented v1
 * shape, because hitting the real API needs a key and would make the suite
 * depend on the network and on a specific site's traffic.
 */

const realFetch = globalThis.fetch;
let lastBody = null;

function mockResponse(payload, status = 200) {
	globalThis.fetch = async (url, opts) => {
		lastBody = JSON.parse(opts.body);
		return {
			ok: status === 200,
			status,
			// Real responses carry headers, and the client reads Retry-After from
			// them. Zero so a throttling test exhausts its retries immediately
			// rather than sitting through the real backoff.
			headers: { get: (name) => (name.toLowerCase() === "retry-after" ? "0" : null) },
			json: async () => payload,
		};
	};
}

const CURRENT = {
	record: {
		key: { formFactor: "PHONE", origin: "https://example.com" },
		metrics: {
			largest_contentful_paint: {
				percentiles: { p75: 2300 },
				histogram: [{ density: 0.7 }, { density: 0.2 }, { density: 0.1 }],
			},
			// The API returns CLS percentiles as a string while timings are numbers.
			cumulative_layout_shift: {
				percentiles: { p75: "0.05" },
				histogram: [{ density: 0.9 }, { density: 0.07 }, { density: 0.03 }],
			},
			interaction_to_next_paint: {
				percentiles: { p75: 210 },
				histogram: [{ density: 0.6 }, { density: 0.3 }, { density: 0.1 }],
			},
		},
		collectionPeriod: {
			firstDate: { year: 2026, month: 7, day: 1 },
			lastDate: { year: 2026, month: 7, day: 28 },
		},
	},
};

beforeEach(() => { lastBody = null; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("fetchFieldData", () => {
	test("parses percentiles, ratings and distributions", async () => {
		mockResponse(CURRENT);
		const r = await fetchFieldData("https://example.com/", { apiKey: "k", scope: "origin" });

		assert.equal(r.metrics.lcp.p75, 2300);
		assert.equal(r.metrics.lcp.rating, "good");
		assert.deepEqual(r.metrics.lcp.distribution, { good: 70, needsImprovement: 20, poor: 10 });
		assert.equal(r.collectionPeriod.last, "2026-07-28");
		assert.equal(r.scope, "origin");
	});

	test("coerces the string CLS percentile to a number", async () => {
		mockResponse(CURRENT);
		const r = await fetchFieldData("https://example.com/", { apiKey: "k", scope: "origin" });

		assert.equal(typeof r.metrics.cls.p75, "number");
		assert.equal(r.metrics.cls.p75, 0.05);
		assert.ok(!Number.isNaN(r.metrics.cls.p75));
	});

	test("failing Core Web Vitals is false, not null", async () => {
		mockResponse(CURRENT); // INP 210 is above the 200 "good" threshold
		const r = await fetchFieldData("https://example.com/", { apiKey: "k", scope: "origin" });

		assert.equal(r.cwvPass, false, "a site that fails CWV must be distinguishable from one with no data");
		assert.equal(r.cwvAssessed, 3);
	});

	test("passes all three when every metric is good", async () => {
		const good = structuredClone(CURRENT);
		good.record.metrics.interaction_to_next_paint.percentiles.p75 = 150;
		mockResponse(good);

		const r = await fetchFieldData("https://example.com/", { apiKey: "k", scope: "origin" });
		assert.equal(r.cwvPass, true);
	});

	test("sends the requested form factor", async () => {
		mockResponse(CURRENT);
		await fetchFieldData("https://example.com/", { apiKey: "k", scope: "origin", formFactor: "DESKTOP" });
		assert.equal(lastBody.formFactor, "DESKTOP");
	});

	test("404 means not enough traffic, so returns null rather than throwing", async () => {
		mockResponse({ error: { message: "not found" } }, 404);
		const r = await fetchFieldData("https://tiny.example/", { apiKey: "k" });
		assert.equal(r, null);
	});

	test("falls back from URL scope to origin scope", async () => {
		let call = 0;
		globalThis.fetch = async (url, opts) => {
			lastBody = JSON.parse(opts.body);
			call++;
			// First attempt (URL-level) has no data; second (origin-level) does.
			if (call === 1) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => CURRENT };
		};

		const r = await fetchFieldData("https://example.com/deep/page", { apiKey: "k" });
		assert.equal(call, 2);
		assert.equal(r.scope, "origin");
		assert.equal(lastBody.origin, "https://example.com");
	});

	test("requires an API key", async () => {
		await assert.rejects(() => fetchFieldData("https://example.com/", {}), /API key/);
	});

	test("propagates non-404 errors once retries are exhausted", async () => {
		// A 429 is retried first — see the pacing suite — but persistent
		// throttling still has to surface rather than being swallowed.
		mockResponse({ error: { message: "quota exceeded" } }, 429);
		await assert.rejects(() => fetchFieldData("https://example.com/", { apiKey: "k" }), /quota exceeded/);
	});

	test("a non-retryable error surfaces immediately", async () => {
		mockResponse({ error: { message: "API key not valid" } }, 403);
		await assert.rejects(() => fetchFieldData("https://example.com/", { apiKey: "k" }), /API key not valid/);
	});
});

describe("the origin beside a page's own record", () => {
	/** A URL-scoped record CrUX could not rate INP for: too few interactions. */
	const URL_NO_INP = {
		record: {
			key: { formFactor: "PHONE", url: "https://example.com/page/" },
			metrics: {
				largest_contentful_paint: { percentiles: { p75: 2300 }, histogram: [{ density: 0.7 }, { density: 0.2 }, { density: 0.1 }] },
				cumulative_layout_shift: { percentiles: { p75: "0.05" }, histogram: [{ density: 0.9 }, { density: 0.07 }, { density: 0.03 }] },
			},
			collectionPeriod: { firstDate: { year: 2026, month: 7, day: 1 }, lastDate: { year: 2026, month: 7, day: 28 } },
		},
	};

	/** The whole site, which has plenty of interactions and a poor INP. */
	const ORIGIN_WITH_INP = {
		record: {
			key: { formFactor: "PHONE", origin: "https://example.com" },
			metrics: {
				largest_contentful_paint: { percentiles: { p75: 9000 }, histogram: [{ density: 0.1 }, { density: 0.2 }, { density: 0.7 }] },
				interaction_to_next_paint: { percentiles: { p75: 640 }, histogram: [{ density: 0.2 }, { density: 0.3 }, { density: 0.5 }] },
			},
			collectionPeriod: { firstDate: { year: 2026, month: 7, day: 1 }, lastDate: { year: 2026, month: 7, day: 28 } },
		},
	};

	/** Answer each request by which key it carries, as the real API does. */
	function mockByScope(urlPayload, originPayload) {
		const bodies = [];
		globalThis.fetch = async (endpoint, opts) => {
			const body = JSON.parse(opts.body);
			bodies.push(body);
			const payload = body.origin ? originPayload : urlPayload;
			return {
				ok: Boolean(payload),
				status: payload ? 200 : 404,
				headers: { get: () => null },
				json: async () => payload ?? { error: { code: 404 } },
			};
		};
		return bodies;
	}

	test("attaches the origin's record without merging it in", async () => {
		mockByScope(URL_NO_INP, ORIGIN_WITH_INP);
		const r = await fetchFieldData("https://example.com/page/", { apiKey: "k" });

		assert.equal(r.scope, "url");
		// The page still has no INP of its own — the origin's 640 sits beside it.
		assert.equal(r.metrics.inp, undefined);
		assert.equal(r.origin.scope, "origin");
		assert.equal(r.origin.metrics.inp.p75, 640);
		assert.deepEqual(r.originCovers, ["inp"]);
	});

	test("leaves the page's own values untouched", async () => {
		mockByScope(URL_NO_INP, ORIGIN_WITH_INP);
		const r = await fetchFieldData("https://example.com/page/", { apiKey: "k" });

		// The origin's LCP is 9000 and fails; the page's own 2300 is the answer.
		assert.equal(r.metrics.lcp.p75, 2300);
		assert.equal(r.metrics.lcp.scope, undefined);
	});

	test("the verdict stays the page's own, over the metrics it has", async () => {
		mockByScope(URL_NO_INP, ORIGIN_WITH_INP);
		const r = await fetchFieldData("https://example.com/page/", { apiKey: "k" });

		// Two good metrics, both the page's. The origin's poor INP is not a
		// failure of this URL, and the origin carries its own verdict.
		assert.equal(r.cwvAssessed, 2);
		assert.equal(r.cwvPass, true);
		assert.equal(r.origin.cwvPass, false);
	});

	test("asks the origin whenever it could fill a gap", async () => {
		const bodies = mockByScope(CURRENT, ORIGIN_WITH_INP);
		await fetchFieldData("https://example.com/page/", { apiKey: "k" });

		// CURRENT has all three vitals but no TTFB, FCP or RTT, any of which the
		// origin may carry — so it is still worth the second request.
		assert.equal(bodies.length, 2);
		assert.ok(bodies[0].url);
		assert.ok(bodies[1].origin);
	});

	test("asks nothing further for a page with no gaps at all", async () => {
		const complete = {
			record: {
				key: { formFactor: "PHONE", url: "https://example.com/page/" },
				metrics: {
					largest_contentful_paint: { percentiles: { p75: 2300 }, histogram: [] },
					cumulative_layout_shift: { percentiles: { p75: "0.05" }, histogram: [] },
					interaction_to_next_paint: { percentiles: { p75: 210 }, histogram: [] },
					first_contentful_paint: { percentiles: { p75: 1200 }, histogram: [] },
					experimental_time_to_first_byte: { percentiles: { p75: 600 }, histogram: [] },
					round_trip_time: { percentiles: { p75: 90 }, histogram: [] },
				},
				collectionPeriod: { firstDate: { year: 2026, month: 7, day: 1 }, lastDate: { year: 2026, month: 7, day: 28 } },
			},
		};

		const bodies = mockByScope(complete, ORIGIN_WITH_INP);
		const r = await fetchFieldData("https://example.com/page/", { apiKey: "k" });

		assert.equal(bodies.length, 1);
		assert.equal(r.origin, undefined);
	});

	test("keeps the page's own answer when the origin request fails", async () => {
		globalThis.fetch = async (endpoint, opts) => {
			const body = JSON.parse(opts.body);
			if (body.origin) throw new Error("network");
			return { ok: true, status: 200, headers: { get: () => null }, json: async () => URL_NO_INP };
		};

		const r = await fetchFieldData("https://example.com/page/", { apiKey: "k" });
		assert.equal(r.metrics.lcp.p75, 2300);
		assert.equal(r.metrics.inp, undefined);
		assert.equal(r.origin, undefined);
	});

	test("an origin-scoped record gets no origin of its own", async () => {
		const bodies = mockByScope(null, ORIGIN_WITH_INP);
		const r = await fetchFieldData("https://example.com/page/", { apiKey: "k" });

		// URL 404s, origin answers, and no third request follows despite the
		// origin record having no CLS.
		assert.equal(r.scope, "origin");
		assert.equal(bodies.length, 2);
		assert.equal(r.metrics.cls, undefined);
	});
});

describe("a front door that redirects", () => {
	const LANDING = {
		record: {
			key: { formFactor: "PHONE", url: "https://www.example.com/en.html" },
			metrics: {
				largest_contentful_paint: { percentiles: { p75: 2050 }, histogram: [] },
				cumulative_layout_shift: { percentiles: { p75: "0.12" }, histogram: [] },
				interaction_to_next_paint: { percentiles: { p75: 329 }, histogram: [] },
				first_contentful_paint: { percentiles: { p75: 1100 }, histogram: [] },
				experimental_time_to_first_byte: { percentiles: { p75: 704 }, histogram: [] },
				round_trip_time: { percentiles: { p75: 80 }, histogram: [] },
			},
			collectionPeriod: { firstDate: { year: 2026, month: 10, day: 14 }, lastDate: { year: 2026, month: 11, day: 10 } },
		},
	};

	function mock(byUrl) {
		const bodies = [];
		globalThis.fetch = async (endpoint, opts) => {
			const body = JSON.parse(opts.body);
			bodies.push(body);
			const payload = body.url ? byUrl[body.url] : byUrl.origin;
			return {
				ok: Boolean(payload),
				status: payload ? 200 : 404,
				headers: { get: () => null },
				json: async () => payload ?? { error: { code: 404 } },
			};
		};
		return bodies;
	}

	test("asks about the page it landed on, not the address it asked for", async () => {
		const bodies = mock({ "https://www.example.com/en.html": LANDING });
		const r = await fetchFieldData("https://www.example.com/", {
			apiKey: "k",
			landingUrl: "https://www.example.com/en.html",
		});

		assert.equal(bodies.length, 1);
		assert.equal(bodies[0].url, "https://www.example.com/en.html");
		assert.equal(r.scope, "landing");
		// The record says which URL it is about, since it is not the site's own.
		assert.equal(r.url, "https://www.example.com/en.html");
		assert.equal(r.metrics.cls.p75, 0.12);
		assert.equal(r.cwvAssessed, 3);
	});

	test("the bare URL is never asked about once a landing URL is known", async () => {
		const bodies = mock({ origin: null });
		await fetchFieldData("https://www.example.com/", {
			apiKey: "k",
			landingUrl: "https://www.example.com/en.html",
		});

		// The landing URL, then the origin. Asking for `/` in between would spend
		// a request on an address CrUX files nothing under.
		assert.deepEqual(bodies.map((b) => b.url ?? b.origin), [
			"https://www.example.com/en.html",
			"https://www.example.com",
		]);
	});

	test("a landing URL the same as the site's own changes nothing", async () => {
		const bodies = mock({ "https://www.example.com/": CURRENT });
		const r = await fetchFieldData("https://www.example.com/", {
			apiKey: "k",
			landingUrl: "https://www.example.com/",
		});

		assert.equal(bodies[0].url, "https://www.example.com/");
		assert.equal(r.scope, "url");
		assert.equal(r.url, undefined);
	});

	test("history follows the landing URL too", async () => {
		const bodies = [];
		globalThis.fetch = async (endpoint, opts) => {
			bodies.push(JSON.parse(opts.body));
			return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ error: { code: 404 } }) };
		};

		await fetchFieldHistory("https://www.example.com/", {
			apiKey: "k",
			landingUrl: "https://www.example.com/en.html",
		});

		assert.equal(bodies[0].url, "https://www.example.com/en.html");
	});
});

describe("fetchFieldHistory", () => {
	const HISTORY = {
		record: {
			collectionPeriods: [
				{ firstDate: { year: 2026, month: 1, day: 1 }, lastDate: { year: 2026, month: 1, day: 28 } },
				{ firstDate: { year: 2026, month: 1, day: 8 }, lastDate: { year: 2026, month: 2, day: 4 } },
			],
			metrics: {
				largest_contentful_paint: {
					percentilesTimeseries: { p75s: [2400, 2600] },
					histogramTimeseries: [
						{ densities: [0.7, 0.65] },
						{ densities: [0.2, 0.22] },
						{ densities: [0.1, 0.13] },
					],
				},
				cumulative_layout_shift: { percentilesTimeseries: { p75s: ["0.04", "0.12"] } },
			},
		},
	};

	test("transposes Google's metric-major series into one row per week", async () => {
		mockResponse(HISTORY);
		const h = await fetchFieldHistory("https://example.com/", { apiKey: "k", scope: "origin" });

		assert.equal(h.series.length, 2);
		assert.equal(h.series[0].metrics.lcp.p75, 2400);
		assert.equal(h.series[1].metrics.lcp.p75, 2600);
		assert.equal(h.series[1].date, "2026-02-04");
		assert.equal(h.series[1].metrics.lcp.distribution.poor, 13);
	});

	test("coerces string CLS values across the series", async () => {
		mockResponse(HISTORY);
		const h = await fetchFieldHistory("https://example.com/", { apiKey: "k", scope: "origin" });

		assert.equal(h.series[1].metrics.cls.p75, 0.12);
		assert.equal(h.series[1].metrics.cls.rating, "needs-improvement");
	});

	test("tolerates a metric with no histogram series", async () => {
		mockResponse(HISTORY);
		const h = await fetchFieldHistory("https://example.com/", { apiKey: "k", scope: "origin" });
		assert.equal(h.series[0].metrics.cls.distribution, null);
	});
});

describe("rate", () => {
	test("treats threshold boundaries as good", () => {
		assert.equal(rate("lcp", 2500), "good");
		assert.equal(rate("lcp", 2501), "needs-improvement");
		assert.equal(rate("cls", 0.1), "good");
		assert.equal(rate("inp", 200), "good");
	});

	test("classifies the poor band", () => {
		assert.equal(rate("lcp", 4001), "poor");
		assert.equal(rate("inp", 501), "poor");
		assert.equal(rate("cls", 0.3), "poor");
	});

	test("returns null for missing values and unknown metrics", () => {
		assert.equal(rate("lcp", null), null);
		assert.equal(rate("lcp", undefined), null);
		assert.equal(rate("nonsense", 100), null);
	});
});

describe("request pacing", () => {
	/**
	 * CrUX allows 150 queries a minute per project. A sequential loop is not slow
	 * enough on its own — the API answers in a couple of hundred milliseconds, so
	 * an unpaced run exceeds the quota within about thirty seconds and then fails
	 * for the rest of its duration.
	 */
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function stubFetch(responses) {
		const calls = [];
		globalThis.fetch = async () => {
			const at = Date.now();
			const next = responses.shift() ?? { ok: true, body: {} };
			calls.push({ at, status: next.ok ? 200 : next.status });
			return {
				ok: next.ok,
				status: next.ok ? 200 : next.status,
				headers: { get: () => next.retryAfter ?? null },
				json: async () => next.body ?? {},
			};
		};
		return calls;
	}

	test("leaves a gap between consecutive requests", async () => {
		const calls = stubFetch([{ ok: true }, { ok: true }, { ok: true }]);

		await fetchFieldData("https://a.example/", { apiKey: "k" }).catch(() => {});
		await fetchFieldData("https://b.example/", { apiKey: "k" }).catch(() => {});

		assert.ok(calls.length >= 2, "made at least two requests");
		const gap = calls[1].at - calls[0].at;
		// Allow a little slack for timer resolution; the point is that it waited.
		assert.ok(gap >= 300, `expected a pause between requests, got ${gap}ms`);
	});

	test("retries after a 429 rather than dropping the site", async () => {
		// Being throttled says nothing about the site — only about how fast we
		// asked — so the request is worth repeating.
		const calls = stubFetch([
			{ ok: false, status: 429, retryAfter: "1" },
			{ ok: true, body: { record: { metrics: {} } } },
		]);

		await fetchFieldData("https://c.example/", { apiKey: "k" }).catch(() => {});
		assert.ok(calls.length >= 2, `expected a retry, saw ${calls.length} request(s)`);
		assert.equal(calls[0].status, 429);
	});

	test("gives up after repeated throttling instead of looping forever", async () => {
		const calls = stubFetch(Array.from({ length: 10 }, () => ({ ok: false, status: 429, retryAfter: "0" })));

		await assert.rejects(() => fetchFieldData("https://d.example/", { apiKey: "k" }));
		assert.ok(calls.length <= 5, `bounded retries, saw ${calls.length}`);
	});
});
