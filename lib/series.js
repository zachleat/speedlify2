/**
 * Compact per-site time series.
 *
 * A stored measurement is ~4 kB of nested detail — third-party tables,
 * accessibility node lists, resource breakdowns. The report needs all of that
 * for exactly one measurement per site (the newest successful one). For
 * charting and the history table it needs about two dozen scalars per point.
 *
 * `series.json` is that projection: an append-only list of flat points, roughly
 * 20x smaller than the records it summarizes. It is a derived cache — every
 * value can be recomputed from the raw records with `speedlify reindex` — which is
 * what makes it safe to change this shape later.
 *
 * The raw records remain the archive and are never rewritten.
 */

export const SERIES_VERSION = 1;

/**
 * Scalars kept per point: `key` in the series, dotted path in a full record.
 *
 * These keys are the vocabulary the whole report charts by — `src/_data/metrics.js`
 * maps the same keys to labels and units, and a test asserts the two agree.
 */
export const SERIES_FIELDS = {
	// Lighthouse categories
	performance: "lab.scores.performance",
	accessibility: "lab.scores.accessibility",
	"best-practices": "lab.scores.best-practices",
	seo: "lab.scores.seo",

	// Lab timings
	lcp: "lab.timings.lcp",
	cls: "lab.timings.cls",
	tbt: "lab.timings.tbt",
	fcp: "lab.timings.fcp",
	si: "lab.timings.si",
	ttfb: "lab.timings.ttfb",

	// Weight
	total: "lab.weight.total",
	requests: "lab.weight.requests",
	bytes: "lab.thirdParty.bytes",
	mainThreadMs: "lab.thirdParty.mainThreadMs",
	unusedJsBytes: "lab.waste.unusedJsBytes",
	unusedCssBytes: "lab.waste.unusedCssBytes",

	// Page health
	mainThreadTotal: "lab.mainThread.total",
	longTasks: "lab.mainThread.longTasks",
	elements: "lab.dom.elements",
	failingCount: "lab.accessibility.failingCount",
	failingNodes: "lab.accessibility.failingNodes",

	// Accessibility violations from the standalone axe run (violating nodes).
	axeViolations: "axe.violations",
	axePasses: "axe.passes",

	// Field data (CrUX)
	"field-lcp": "field.metrics.lcp.p75",
	"field-inp": "field.metrics.inp.p75",
	"field-cls": "field.metrics.cls.p75",
	"field-fcp": "field.metrics.fcp.p75",
	"field-ttfb": "field.metrics.ttfb.p75",
};

/**
 * Run metadata kept alongside the metrics, so the history table and the
 * environment-drift check never need to open a raw record either.
 */
const RUN_FIELDS = {
	bench: "lab.environment.benchmarkIndex",
	runs: "completedRuns",
	reqRuns: "requestedRuns",
	ms: "durationMs",
};

function get(obj, path) {
	return path.split(".").reduce((acc, k) => (acc === null || acc === undefined ? acc : acc[k]), obj);
}

/**
 * Project one stored record down to a series point.
 *
 * Absent values are omitted rather than written as null — over thousands of
 * points, the keys cost more than the values.
 */
export function projectPoint(record) {
	const point = { t: record.timestamp };

	if (record.error) {
		// Failures are points too: "this site was down on Tuesday" belongs on
		// the chart, and the scheduler's backoff reads this back.
		point.error = record.error;
		if (record.consecutiveFailures) point.fails = record.consecutiveFailures;
	}

	// Where this measurement actually landed, when that isn't the requested URL.
	// Kept per point rather than only on the newest record because confirming a
	// site move means checking that the destination held steady across runs.
	const redirect = record.lab?.redirect;
	if (redirect?.to) {
		point.to = redirect.to;
		point.perm = redirect.permanent ? 1 : 0;
	}

	/*
	 * The generator tag as it read at this measurement.
	 *
	 * Stored raw, and re-detected on the way out, for the same reason the entry
	 * does it: a rule added later then applies to history already on disk. The
	 * string is short and most sites emit none at all, so the cost across a
	 * series is close to nothing.
	 *
	 * This is what makes "when did this site stop being Eleventy" answerable.
	 * Without it the only record of a generator is the newest measurement, and
	 * the moment a site changes, the evidence that it ever was something else is
	 * gone.
	 */
	const generator = record.axe?.generator;
	if (typeof generator === "string" && generator.trim()) point.gen = generator.slice(0, 120);

	for (let [key, path] of Object.entries({ ...SERIES_FIELDS, ...RUN_FIELDS })) {
		const value = get(record, path);
		if (typeof value === "number" && Number.isFinite(value)) point[key] = value;
	}

	// Run-to-run spread of the performance score; drives the noise floor.
	const spread = record.variance?.spread;
	if (typeof spread === "number") point.spread = spread;

	return point;
}

/**
 * Expand a stored point for use by the report.
 *
 * `date` and `error` are hydrated here rather than stored, so the series file
 * stays compact while `trend()` and the templates see the same field names they
 * would on a full record.
 */
export function hydratePoint(point) {
	return {
		...point,
		timestamp: point.t,
		date: new Date(point.t).toISOString(),
		error: point.error || null,
		completedRuns: point.runs ?? null,
		requestedRuns: point.reqRuns ?? null,
		durationMs: point.ms ?? null,
	};
}

/** Build a whole series from raw records (oldest first). */
export function buildSeries(url, records) {
	return {
		version: SERIES_VERSION,
		url,
		updated: new Date().toISOString(),
		points: records.map(projectPoint).sort((a, b) => a.t - b.t),
	};
}

/**
 * Serialize with one point per line.
 *
 * These files are committed, so this matters: a new measurement appends a
 * single line and the diff shows exactly what changed. Pretty-printing every
 * point would multiply the file size; putting it all on one line would make
 * every commit look like a full rewrite.
 */
export function serializeSeries(series) {
	const header = [
		`{"version":${JSON.stringify(series.version ?? SERIES_VERSION)}`,
		`"url":${JSON.stringify(series.url)}`,
		`"updated":${JSON.stringify(series.updated)}`,
	].join(",");

	if (!series.points.length) return `${header},"points":[]}\n`;

	const lines = series.points.map((p) => JSON.stringify(p));
	return `${header},"points":[\n${lines.join(",\n")}\n]}\n`;
}

/** Insert a point, keeping the series ordered and free of duplicate timestamps. */
export function upsertPoint(series, point) {
	const points = series.points.filter((p) => p.t !== point.t);
	points.push(point);
	points.sort((a, b) => a.t - b.t);

	return { ...series, version: SERIES_VERSION, updated: new Date().toISOString(), points };
}
