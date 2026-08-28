/**
 * Turning a pile of measurements into comparisons.
 *
 * Two axes matter here and they answer different questions:
 *   - over time: "is this site getting worse?"  → trend()
 *   - across sites: "who is fastest?"           → rank()
 */

/** Metrics where a lower number is better. Everything else: higher is better. */
const LOWER_IS_BETTER = new Set([
	"lcp", "fcp", "si", "tbt", "tti", "cls", "ttfb", "maxPotentialFid",
	"serverResponseTime", "networkRtt", "total", "requests", "elements",
	"unusedJsBytes", "unusedCssBytes", "legacyJsBytes", "renderBlockingMs",
	"mainThreadTotal", "bytes", "mainThreadMs", "longTasks", "failingCount",
	"failingNodes", "poorlyCachedBytes", "inp", "rtt", "axeViolations",
]);

export function lowerIsBetter(key) {
	return LOWER_IS_BETTER.has(key);
}

/** Pull a dotted path out of a record, tolerating gaps. */
export function get(obj, path) {
	return path.split(".").reduce((acc, k) => (acc === null || acc === undefined ? acc : acc[k]), obj);
}

/**
 * Change between two values, with direction interpreted for the metric.
 *
 * `better` is the useful field: for CLS a decrease is better, for the
 * performance score an increase is. Templates shouldn't have to know which.
 */
export function delta(key, current, previous) {
	if (typeof current !== "number" || typeof previous !== "number") return null;

	const change = current - previous;
	const pct = previous === 0 ? null : (change / Math.abs(previous)) * 100;

	return {
		current,
		previous,
		change: round(change, 3),
		pct: pct === null ? null : round(pct, 1),
		better: change === 0 ? null : lowerIsBetter(key) ? change < 0 : change > 0,
		unchanged: change === 0,
	};
}

/**
 * A metric's series over time, plus the headline comparisons.
 *
 * `sinceFirst` is what makes this a *comparison over time* tool rather than a
 * dashboard: the week-over-week delta is usually noise, while drift from the
 * first recorded value is the thing you actually want to catch.
 */
export function trend(history, path, key = path.split(".").pop()) {
	const points = history
		.filter((h) => !h.error)
		.map((h) => ({ date: h.date, timestamp: h.timestamp, value: get(h, path) }))
		.filter((p) => typeof p.value === "number");

	if (!points.length) return null;

	const values = points.map((p) => p.value);
	const current = values[values.length - 1];
	const previous = values.length > 1 ? values[values.length - 2] : null;

	return {
		key,
		path,
		points,
		current,
		previous,
		first: values[0],
		min: Math.min(...values),
		max: Math.max(...values),
		mean: round(values.reduce((a, b) => a + b, 0) / values.length, 2),
		median: median(values),
		count: values.length,
		vsPrevious: previous === null ? null : delta(key, current, previous),
		sinceFirst: values.length > 1 ? delta(key, current, values[0]) : null,
		// Median of the last N, which is far more stable than the last value
		// when you're deciding whether something genuinely regressed.
		recentMedian: median(values.slice(-5)),
		lowerIsBetter: lowerIsBetter(key),
	};
}

/**
 * Rank sites by a metric. Ties share a rank, as they should — three sites at
 * 100 are all first, not first/second/third.
 */
export function rank(entries, valueFn, { lowerBetter = false } = {}) {
	const scored = entries
		.map((entry) => ({ entry, value: valueFn(entry) }))
		.filter((s) => typeof s.value === "number");

	scored.sort((a, b) => (lowerBetter ? a.value - b.value : b.value - a.value));

	let lastValue = null;
	let lastRank = 0;

	return scored.map((s, i) => {
		const rank = s.value === lastValue ? lastRank : i + 1;
		lastValue = s.value;
		lastRank = rank;
		return { ...s, rank };
	});
}

/**
 * Is a change real, or is it run-to-run noise?
 *
 * Lab metrics jitter. Comparing a single new measurement against a single old
 * one produces a stream of phantom regressions, which is how a performance
 * dashboard trains people to ignore it. We only call something significant if
 * it moves more than the series' own observed noise floor.
 */
export function isSignificant(trendData, { minPct = 5, noiseMultiplier = 1.5 } = {}) {
	if (!trendData?.vsPrevious || trendData.count < 3) return false;

	const { pct } = trendData.vsPrevious;
	if (pct === null || Math.abs(pct) < minPct) return false;

	// Typical absolute step between consecutive points = the noise floor.
	const values = trendData.points.map((p) => p.value);
	const steps = values.slice(1).map((v, i) => Math.abs(v - values[i]));
	const noise = median(steps);

	return Math.abs(trendData.vsPrevious.change) > noise * noiseMultiplier;
}

/**
 * Did the measuring machine change speed? Lighthouse's benchmarkIndex scores
 * the host CPU. A big swing means CPU-bound metrics (TBT, TTI) moved for
 * reasons that have nothing to do with the site — worth flagging in the UI so
 * nobody spends an afternoon chasing it.
 */
/*
 * How far off the project median a measurement has to land before the machine
 * behind it is called unusual.
 *
 * Chosen on magnitude rather than on rarity, because that is what the notice
 * claims: CPU-bound metrics moved. A percentile band would be symmetric in how
 * often it fires and wildly asymmetric in how much distortion it takes to fire
 * — these machines vary by running fast, not slow, so its lower edge sat about
 * 8% below the median, where nothing has meaningfully moved.
 *
 * 25% also lands mid-plateau: anywhere from 24% to 30% flags much the same set,
 * so the exact figure is not fitted to the measurements we happen to hold.
 *
 * The consequence, accepted: nothing has ever measured 25% slow — the slowest
 * run on record is 23.8% under — so in practice this fires on fast machines.
 * It stays armed for a slow one.
 */
export const DRIFT_THRESHOLD = 0.25;

export function environmentDrift(history, { threshold = DRIFT_THRESHOLD, baseline = null } = {}) {
	const points = history
		// Accepts either a series point (`bench`) or a full record.
		.map((h) => (typeof h.bench === "number" ? h.bench : h.lab?.environment?.benchmarkIndex))
		.filter((v) => typeof v === "number");

	if (!points.length) return null;

	const current = points[points.length - 1];

	/*
	 * Two baselines are possible, and which one is in use changes what the
	 * finding means.
	 *
	 * Given one — the project-wide median — the question is whether this
	 * measurement came off a machine that was unusual for the fleet, and it can
	 * be asked of a site's very first measurement. Without one we fall back to
	 * the site's own prior median, which needs two measurements and instead asks
	 * whether the machine was unusual for this site.
	 */
	const against = baseline ?? (points.length > 1 ? median(points.slice(0, -1)) : null);
	if (!against) return null;

	const ratio = (current - against) / against;

	return {
		current,
		baseline: round(against, 1),
		ratio: round(ratio, 3),
		// Slower machine than usual → CPU metrics inflate → false regressions.
		suspect: Math.abs(ratio) > threshold,
		direction: ratio < 0 ? "slower" : "faster",
		// Which comparison was made, so the page can say so rather than leave
		// the reader to assume it was this site's own history.
		scope: baseline ? "fleet" : "site",
	};
}

/** Compare lab against field for the same metric — the divergence is the story. */
export function labVsField(record, metric = "lcp") {
	const lab = record?.lab?.timings?.[metric];
	const field = record?.field?.metrics?.[metric]?.p75;
	if (typeof lab !== "number" || typeof field !== "number") return null;

	return {
		lab,
		field,
		diff: round(field - lab, 1),
		// Lab over field: how many times the synthetic number is the real one.
		// Above 1x the lab is the slower of the two and real users are doing
		// better than the test says; below 1x the test is flattering the site.
		ratio: field === 0 ? null : round(lab / field, 1),
		// Real users slower than the lab is the common and important case: your
		// synthetic test is more optimistic than reality.
		fieldWorse: field > lab,
	};
}

function median(values) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2, 3);
}

function round(v, places = 0) {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	const f = 10 ** places;
	return Math.round(v * f) / f;
}
