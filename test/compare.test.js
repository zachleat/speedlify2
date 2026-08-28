import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { delta, trend, rank, isSignificant, environmentDrift, lowerIsBetter } from "../lib/compare.js";

/** Build a fake history: one record per performance/LCP pair. */
function history(pairs, { benchmarks = [] } = {}) {
	return pairs.map(([performance, lcp], i) => ({
		date: new Date(2026, 0, i + 1).toISOString(),
		timestamp: Date.UTC(2026, 0, i + 1),
		error: null,
		lab: {
			scores: { performance },
			timings: { lcp },
			environment: { benchmarkIndex: benchmarks[i] ?? 1000 },
		},
	}));
}

describe("delta", () => {
	test("knows which direction is better per metric", () => {
		// Higher score is better.
		assert.equal(delta("performance", 90, 80).better, true);
		assert.equal(delta("performance", 70, 80).better, false);
		// Lower LCP is better.
		assert.equal(delta("lcp", 1000, 2000).better, true);
		assert.equal(delta("lcp", 3000, 2000).better, false);
	});

	test("reports no direction for an unchanged value", () => {
		const d = delta("lcp", 2000, 2000);
		assert.equal(d.unchanged, true);
		assert.equal(d.better, null);
	});

	test("computes percentage change", () => {
		assert.equal(delta("lcp", 1500, 1000).pct, 50);
		assert.equal(delta("lcp", 500, 1000).pct, -50);
	});

	test("avoids dividing by a zero baseline", () => {
		const d = delta("cls", 0.1, 0);
		assert.equal(d.pct, null);
		assert.equal(d.change, 0.1);
	});

	test("returns null when either side is missing", () => {
		assert.equal(delta("lcp", 1000, null), null);
		assert.equal(delta("lcp", undefined, 1000), null);
	});
});

describe("trend", () => {
	test("summarizes a series", () => {
		const t = trend(history([[80, 2000], [85, 1800], [90, 1500]]), "lab.scores.performance", "performance");

		assert.equal(t.count, 3);
		assert.equal(t.current, 90);
		assert.equal(t.previous, 85);
		assert.equal(t.first, 80);
		assert.equal(t.min, 80);
		assert.equal(t.max, 90);
		assert.equal(t.vsPrevious.better, true);
		assert.equal(t.sinceFirst.change, 10);
	});

	test("marks lower-is-better metrics", () => {
		const t = trend(history([[80, 2000], [85, 1500]]), "lab.timings.lcp", "lcp");
		assert.equal(t.lowerIsBetter, true);
		assert.equal(t.vsPrevious.better, true, "LCP dropping is an improvement");
	});

	test("excludes failed measurements from the series", () => {
		const h = history([[80, 2000], [90, 1500]]);
		h.splice(1, 0, { date: "x", timestamp: 0, error: "timeout", lab: null });

		const t = trend(h, "lab.scores.performance", "performance");
		assert.equal(t.count, 2, "an errored run must not become a data point");
	});

	test("handles a single measurement", () => {
		const t = trend(history([[80, 2000]]), "lab.scores.performance", "performance");
		assert.equal(t.count, 1);
		assert.equal(t.vsPrevious, null);
		assert.equal(t.sinceFirst, null);
	});

	test("returns null when nothing was measured", () => {
		assert.equal(trend([], "lab.scores.performance"), null);
	});
});

describe("rank", () => {
	test("gives tied values the same rank and skips the next", () => {
		const entries = [{ n: "a", v: 100 }, { n: "b", v: 100 }, { n: "c", v: 90 }];
		const ranked = rank(entries, (e) => e.v);

		assert.deepEqual(ranked.map((r) => r.rank), [1, 1, 3]);
	});

	test("inverts for lower-is-better metrics", () => {
		const entries = [{ v: 3000 }, { v: 1000 }, { v: 2000 }];
		const ranked = rank(entries, (e) => e.v, { lowerBetter: true });

		assert.equal(ranked[0].value, 1000);
		assert.equal(ranked[0].rank, 1);
	});

	test("drops entries with no value", () => {
		const ranked = rank([{ v: 100 }, { v: null }, { v: undefined }], (e) => e.v);
		assert.equal(ranked.length, 1);
	});
});

describe("isSignificant", () => {
	test("ignores movement smaller than the series' own noise", () => {
		// Jitters by ~5 points every run; a final 5-point move is just more jitter.
		const t = trend(history([[80, 0], [85, 0], [80, 0], [85, 0], [80, 0]]), "lab.scores.performance", "performance");
		assert.equal(isSignificant(t), false);
	});

	test("flags a move well outside the noise floor", () => {
		// Rock steady at 90, then falls off a cliff.
		const t = trend(history([[90, 0], [90, 0], [90, 0], [90, 0], [60, 0]]), "lab.scores.performance", "performance");
		assert.equal(isSignificant(t), true);
	});

	test("stays silent until there is enough history to know the noise", () => {
		const t = trend(history([[90, 0], [60, 0]]), "lab.scores.performance", "performance");
		assert.equal(isSignificant(t), false, "two points cannot establish a noise floor");
	});

	test("ignores tiny percentage moves regardless of noise", () => {
		const t = trend(history([[90, 0], [90, 0], [90, 0], [91, 0]]), "lab.scores.performance", "performance");
		assert.equal(isSignificant(t), false);
	});
});

describe("environmentDrift", () => {
	test("flags a measurably slower runner", () => {
		const h = history([[90, 0], [90, 0], [90, 0]], { benchmarks: [1000, 1000, 500] });
		const drift = environmentDrift(h);

		assert.equal(drift.suspect, true);
		assert.equal(drift.direction, "slower");
		assert.equal(drift.baseline, 1000);
	});

	test("ignores small variation", () => {
		const h = history([[90, 0], [90, 0], [90, 0]], { benchmarks: [1000, 1000, 1050] });
		assert.equal(environmentDrift(h).suspect, false);
	});

	test("needs at least two measurements without a supplied baseline", () => {
		assert.equal(environmentDrift(history([[90, 0]])), null);
	});

	test("judges a first measurement against a supplied baseline", () => {
		const h = history([[90, 0]], { benchmarks: [500] });
		const drift = environmentDrift(h, { baseline: 1000 });

		assert.equal(drift.suspect, true);
		assert.equal(drift.direction, "slower");
		assert.equal(drift.baseline, 1000);
		assert.equal(drift.scope, "fleet");
	});

	test("prefers the supplied baseline over the site's own history", () => {
		// Steady on its own terms, and half the speed of the fleet: the site
		// baseline sees nothing, the project baseline sees a slow machine.
		const h = history([[90, 0], [90, 0], [90, 0]], { benchmarks: [500, 500, 500] });

		assert.equal(environmentDrift(h).suspect, false);
		assert.equal(environmentDrift(h).scope, "site");

		const drift = environmentDrift(h, { baseline: 1000 });
		assert.equal(drift.suspect, true);
		assert.equal(drift.direction, "slower");
		assert.equal(drift.scope, "fleet");
	});

	test("honours a custom threshold", () => {
		const h = history([[90, 0]], { benchmarks: [1300] });

		assert.equal(environmentDrift(h, { baseline: 1000 }).suspect, true);
		assert.equal(environmentDrift(h, { baseline: 1000, threshold: 0.5 }).suspect, false);
	});

	test("defaults to 25% off the baseline", () => {
		const drift = (bench) => environmentDrift(history([[90, 0]], { benchmarks: [bench] }), { baseline: 1000 });

		// The boundary is exclusive, so exactly 25% off is still ordinary.
		assert.equal(drift(1250).suspect, false);
		assert.equal(drift(1251).suspect, true);
		assert.equal(drift(750).suspect, false);
		assert.equal(drift(749).suspect, true);
		assert.equal(drift(749).direction, "slower");
	});

	test("returns null when there is nothing to measure", () => {
		assert.equal(environmentDrift([], { baseline: 1000 }), null);
	});

});

describe("lowerIsBetter", () => {
	test("classifies metrics correctly", () => {
		assert.equal(lowerIsBetter("lcp"), true);
		assert.equal(lowerIsBetter("cls"), true);
		assert.equal(lowerIsBetter("total"), true);
		assert.equal(lowerIsBetter("performance"), false);
		assert.equal(lowerIsBetter("accessibility"), false);
	});
});
