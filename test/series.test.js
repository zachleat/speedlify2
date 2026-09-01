import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	SERIES_FIELDS,
	SERIES_VERSION,
	projectPoint,
	hydratePoint,
	buildSeries,
	serializeSeries,
	upsertPoint,
} from "../lib/series.js";
import { ResultStore, isMeasurementFile } from "../lib/store.js";
import { SCORES, LAB_METRICS, WEIGHT_METRICS, HEALTH_METRICS, FIELD_METRICS } from "../src/_data/metrics.js";

const URL = "https://example.com/";

function record(overrides = {}) {
	return {
		url: URL,
		name: "Example",
		timestamp: Date.UTC(2026, 0, 1),
		date: "2026-01-01T00:00:00.000Z",
		completedRuns: 3,
		requestedRuns: 3,
		durationMs: 31000,
		error: null,
		variance: { spread: 2 },
		lab: {
			scores: { performance: 92, accessibility: 100, "best-practices": 100, seo: 100 },
			timings: { lcp: 1800, cls: 0.02, tbt: 40, fcp: 1200, si: 1500, ttfb: 300 },
			weight: { total: 500000, requests: 40 },
			thirdParty: { bytes: 12000, mainThreadMs: 30 },
			waste: { unusedJsBytes: 1000, unusedCssBytes: 200 },
			mainThread: { total: 900, longTasks: 2 },
			dom: { elements: 1200 },
			accessibility: { failingCount: 0, failingNodes: 0 },
			environment: { benchmarkIndex: 3800 },
		},
		field: null,
		...overrides,
	};
}

const tmpDirs = [];
function tmpStore() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-test-"));
	tmpDirs.push(dir);
	return new ResultStore(dir);
}

afterEach(() => {
	while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe("projectPoint", () => {
	test("captures every series field present on the record", () => {
		const p = projectPoint(record());

		assert.equal(p.t, Date.UTC(2026, 0, 1));
		assert.equal(p.performance, 92);
		assert.equal(p.lcp, 1800);
		assert.equal(p.cls, 0.02);
		assert.equal(p.total, 500000);
		assert.equal(p.bytes, 12000);
		assert.equal(p.elements, 1200);
		assert.equal(p.bench, 3800);
		assert.equal(p.spread, 2);
		assert.equal(p.runs, 3);
	});

	test("omits absent values instead of writing nulls", () => {
		const p = projectPoint(record({ field: null }));
		assert.ok(!("field-inp" in p), "an absent metric should not occupy a key");
		assert.ok(!("field-lcp" in p));
	});

	test("includes field metrics when CrUX data is present", () => {
		const p = projectPoint(
			record({ field: { metrics: { lcp: { p75: 2400 }, inp: { p75: 180 }, cls: { p75: 0.05 } } } })
		);
		assert.equal(p["field-lcp"], 2400);
		assert.equal(p["field-inp"], 180);
		assert.equal(p["field-cls"], 0.05);
	});

	test("records failures as points, with the failure count", () => {
		const p = projectPoint(record({ error: "timeout", consecutiveFailures: 3, lab: null }));
		assert.equal(p.error, "timeout");
		assert.equal(p.fails, 3);
		assert.ok(!("performance" in p));
	});

	test("keeps a real zero rather than dropping it", () => {
		const r = record();
		r.lab.timings.tbt = 0;
		assert.equal(projectPoint(r).tbt, 0, "0 is data, not absence");
	});
});

describe("hydratePoint", () => {
	test("restores the field names the report expects", () => {
		const h = hydratePoint(projectPoint(record()));
		assert.equal(h.timestamp, Date.UTC(2026, 0, 1));
		assert.equal(h.date, "2026-01-01T00:00:00.000Z");
		assert.equal(h.error, null);
		assert.equal(h.completedRuns, 3);
		assert.equal(h.durationMs, 31000);
	});
});

describe("serializeSeries", () => {
	test("writes one point per line so commits diff cleanly", () => {
		const series = buildSeries(URL, [record(), record({ timestamp: Date.UTC(2026, 0, 2) })]);
		const text = serializeSeries(series);
		const lines = text.trim().split("\n");

		// header + 2 points + closing bracket
		assert.equal(lines.length, 4);
		assert.ok(lines[1].startsWith("{"), "each point begins its own line");
	});

	test("roundtrips through JSON.parse", () => {
		const series = buildSeries(URL, [record()]);
		const parsed = JSON.parse(serializeSeries(series));

		assert.equal(parsed.version, SERIES_VERSION);
		assert.equal(parsed.url, URL);
		assert.equal(parsed.points.length, 1);
		assert.equal(parsed.points[0].performance, 92);
	});

	test("handles an empty series", () => {
		const parsed = JSON.parse(serializeSeries({ version: 1, url: URL, updated: "x", points: [] }));
		assert.deepEqual(parsed.points, []);
	});
});

describe("upsertPoint", () => {
	test("replaces a point with the same timestamp rather than duplicating", () => {
		let series = buildSeries(URL, [record()]);
		series = upsertPoint(series, projectPoint(record({ lab: { ...record().lab, scores: { performance: 50 } } })));

		assert.equal(series.points.length, 1);
		assert.equal(series.points[0].performance, 50);
	});

	test("keeps points ordered oldest first", () => {
		let series = buildSeries(URL, [record({ timestamp: 300 })]);
		series = upsertPoint(series, projectPoint(record({ timestamp: 100 })));
		series = upsertPoint(series, projectPoint(record({ timestamp: 200 })));

		assert.deepEqual(series.points.map((p) => p.t), [100, 200, 300]);
	});
});

describe("isMeasurementFile", () => {
	test("accepts timestamped records and rejects every sidecar", () => {
		assert.equal(isMeasurementFile("2026-08-16T15-27-12-185Z.json"), true);
		assert.equal(isMeasurementFile("series.json"), false);
		assert.equal(isMeasurementFile("meta.json"), false);
		assert.equal(isMeasurementFile("field-history.json"), false);
	});
});

describe("ResultStore series integration", () => {
	test("writing a measurement updates the series", () => {
		const store = tmpStore();
		store.write(record());
		store.write(record({ timestamp: Date.UTC(2026, 0, 2) }));

		const points = store.series(URL);
		assert.equal(points.length, 2);
		assert.equal(points[0].performance, 92);
		assert.ok(fs.existsSync(store.seriesFile(URL)));
	});

	test("series.json is not counted as a measurement", () => {
		const store = tmpStore();
		store.write(record());

		assert.equal(store.count(URL), 1, "sidecars must not inflate the measurement count");
	});

	test("rebuilds a missing series from the raw records", () => {
		const store = tmpStore();
		store.write(record());
		store.write(record({ timestamp: Date.UTC(2026, 0, 2) }));

		fs.unlinkSync(store.seriesFile(URL));
		assert.equal(store.readSeries(URL), null);

		const points = store.series(URL);
		assert.equal(points.length, 2, "a deleted cache must heal itself");
		assert.ok(fs.existsSync(store.seriesFile(URL)));
	});

	test("rebuilds when raw records have moved ahead of the series", () => {
		const store = tmpStore();
		store.write(record());

		// Simulate a record restored from backup without its series entry.
		const stale = JSON.parse(fs.readFileSync(store.seriesFile(URL), "utf8"));
		stale.points = [];
		fs.writeFileSync(store.seriesFile(URL), JSON.stringify(stale));

		assert.equal(store.series(URL).length, 1);
	});

	test("pruning raw records does not erase their series points", () => {
		const store = tmpStore();
		for (let day = 1; day <= 5; day++) store.write(record({ timestamp: Date.UTC(2026, 0, day) }));
		assert.equal(store.series(URL).length, 5);

		// Delete the three oldest raw records, as prune() would.
		for (let file of store.filenames(URL).slice(0, 3)) {
			fs.unlinkSync(path.join(store.dirFor(URL), file));
		}

		const points = store.series(URL);
		assert.equal(points.length, 5, "the series outlives the archive it was built from");
		assert.equal(store.count(URL), 2, "and the raw records really are gone");
	});

	test("a hard rebuild drops points whose records are gone", () => {
		const store = tmpStore();
		for (let day = 1; day <= 3; day++) store.write(record({ timestamp: Date.UTC(2026, 0, day) }));
		fs.unlinkSync(path.join(store.dirFor(URL), store.filenames(URL)[0]));

		store.rebuildSeries(URL, { replace: true });
		assert.equal(store.series(URL).length, 2);
	});

	test("rebuilds when the projection version changes", () => {
		const store = tmpStore();
		store.write(record());

		const old = JSON.parse(fs.readFileSync(store.seriesFile(URL), "utf8"));
		old.version = 0;
		fs.writeFileSync(store.seriesFile(URL), JSON.stringify(old));

		assert.equal(store.series(URL).length, 1);
	});

	test("treats a corrupt series as missing", () => {
		const store = tmpStore();
		store.write(record());
		fs.writeFileSync(store.seriesFile(URL), "{ not json");

		assert.equal(store.series(URL).length, 1);
	});

	test("failed measurements appear in the series", () => {
		const store = tmpStore();
		store.write(record({ error: "timeout", consecutiveFailures: 2, lab: null }));

		const points = store.series(URL);
		assert.equal(points.length, 1);
		assert.equal(points[0].error, "timeout");
	});
});

describe("metric definitions", () => {
	test("every charted metric has a series field to read from", () => {
		const displayed = [
			...SCORES.map((m) => m.key),
			...LAB_METRICS.map((m) => m.key),
			...WEIGHT_METRICS.map((m) => m.key),
			...HEALTH_METRICS.map((m) => m.key),
			...FIELD_METRICS.map((m) => `field-${m.key}`),
		];

		const missing = displayed.filter((key) => !(key in SERIES_FIELDS));
		assert.deepEqual(
			missing,
			[],
			`these metrics are displayed but not captured in series.json: ${missing.join(", ")}`
		);
	});
});

describe("rebuilding a series after records are deleted", () => {
	const tmp = [];
	afterEach(() => {
		while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
	});

	const record = (day, performance) => ({
		url: "https://example.com/",
		name: "Example",
		group: "g",
		timestamp: Date.UTC(2026, 0, day),
		date: new Date(Date.UTC(2026, 0, day)).toISOString(),
		completedRuns: 1,
		requestedRuns: 1,
		durationMs: 1000,
		error: null,
		lab: { scores: { performance }, timings: {}, weight: { byType: {} } },
	});

	function store() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-series-"));
		tmp.push(dir);
		const s = new ResultStore(path.join(dir, "results"));
		s.write(record(1, 80));
		s.write(record(2, 90));
		return s;
	}

	const files = (s) =>
		fs.readdirSync(s.dirFor("https://example.com/")).filter((f) => /^\d{4}-/.test(f));

	test("merging keeps a point whose record has been deleted", () => {
		const s = store();
		fs.rmSync(path.join(s.dirFor("https://example.com/"), files(s)[0]));

		const series = s.rebuildSeries("https://example.com/");

		// The default, and deliberate: pruning deletes old records on purpose and
		// the series is what outlives them.
		assert.equal(series.points.length, 2, "the pruned point survives");
	});

	test("--replace drops it", () => {
		const s = store();
		fs.rmSync(path.join(s.dirFor("https://example.com/"), files(s)[0]));

		const series = s.rebuildSeries("https://example.com/", { replace: true });

		assert.equal(series.points.length, 1, "only points with a record behind them");
		assert.equal(series.points[0].t, Date.UTC(2026, 0, 2));
	});

	test("replace on an intact archive changes nothing", () => {
		const s = store();
		const before = s.rebuildSeries("https://example.com/").points.length;

		assert.equal(s.rebuildSeries("https://example.com/", { replace: true }).points.length, before);
	});
});
