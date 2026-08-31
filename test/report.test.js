import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildReport, REPORT_VERSION, rankClimb } from "../lib/report.js";
import { shortHash } from "../lib/hash.js";
import { ResultStore } from "../lib/store.js";

/**
 * The report is the contract between measurement and rendering: if a field the
 * templates read stops being emitted, the site renders blanks rather than
 * failing. These tests pin the shape.
 */

const tmp = [];
afterEach(() => {
	while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
});

function fixture({ sites = 1, points = 4, url = (i) => `https://site${i}.example/`, performance = (p) => 80 + p, axe = null, field = null, generator = () => null, error = () => null, consecutiveFailures = 0 } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-report-"));
	tmp.push(dir);

	const store = new ResultStore(path.join(dir, "results"));

	for (let s = 0; s < sites; s++) {
		for (let p = 0; p < points; p++) {
			store.write({
				url: url(s),
				name: `Site ${s}`,
				group: "g",
				timestamp: Date.UTC(2026, 0, p + 1),
				date: new Date(Date.UTC(2026, 0, p + 1)).toISOString(),
				completedRuns: 3,
				requestedRuns: 3,
				durationMs: 30000,
				error: error(p),
				consecutiveFailures: error(p) ? consecutiveFailures : 0,
				variance: { spread: 1 },
				lab: {
					requestedUrl: url(s),
					finalUrl: url(s),
					redirect: null,
					scores: { performance: performance(p, s), accessibility: 100, "best-practices": 100, seo: 100 },
					timings: { lcp: 2000 - p * 50, cls: 0.01, tbt: 30, fcp: 1000, si: 1200, ttfb: 200 },
					weight: { total: 500000, requests: 40, byType: { script: { bytes: 1000, requests: 2 } } },
					thirdParty: { count: 0, bytes: 0, mainThreadMs: 0, top: [] },
					waste: { unusedJsBytes: 0, unusedCssBytes: 0 },
					mainThread: { total: 900, longTasks: 1, byGroup: { scriptEvaluation: 500 } },
					dom: { elements: 1000, depth: 10, maxChildren: 5 },
					accessibility: { failingCount: 0, applicableCount: 30, failingNodes: 0, failing: [] },
					hygiene: { https: 1, protocol: "h2", consoleErrors: 0 },
					environment: { benchmarkIndex: 3800, lighthouseVersion: "13.4.1" },
					lcpBreakdown: { timeToFirstByte: 100 },
				},
				field,
				// The generator tag rides on the axe record, which is where the
				// measurement step puts it.
				axe: generator(p) ? { ...(axe ?? {}), generator: generator(p) } : axe,
			});
		}
	}

	const configFile = path.join(dir, "sites.js");
	const entries = Array.from({ length: sites }, (_, s) => `{ name: "Site ${s}", url: "${url(s)}" }`).join(",");
	fs.writeFileSync(
		configFile,
		`export default { runs: 3, formFactor: "mobile", groups: { g: { name: "Group", sites: [${entries}] } } };`
	);

	return { dir, resultsDir: path.join(dir, "results"), configFile };
}

describe("buildReport", () => {
	test("emits the top-level shape the templates read", async () => {
		const f = fixture();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		for (let key of [
			"version", "config", "metrics", "entries", "groups", "orphans",
			"moving", "moved", "stats", "coverage", "generated",
			"hasFieldData", "cruxEnabled", "cwvAvailable",
		]) {
			assert.ok(key in r, `report is missing "${key}"`);
		}
		assert.equal(r.version, REPORT_VERSION);
	});

	test("is JSON round-trippable without loss", async () => {
		const f = fixture({ sites: 2 });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		const round = JSON.parse(JSON.stringify(r));
		assert.equal(round.entries.length, r.entries.length);
		assert.deepEqual(round.entries[0].trends.performance.values, r.entries[0].trends.performance.values);
	});

	test("entries carry the fields the site page renders", async () => {
		const f = fixture();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });
		const e = r.entries[0];

		for (let key of [
			"url", "name", "hash", "group", "groupName", "history", "historyCount",
			"totalCount", "latest", "currentlyFailing", "trends", "ranks",
			"groupRanks", "stale", "neverMeasured", "previousUrls", "redirectTo",
		]) {
			assert.ok(key in e, `entry is missing "${key}"`);
		}

		// The detail panels come from the one full record.
		assert.ok(e.latest.lab.weight.byType, "latest must keep nested detail");
		assert.ok(e.latest.lab.hygiene);
	});

	test("trends keep values but not the duplicated point objects", async () => {
		const f = fixture({ points: 5 });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });
		const t = r.entries[0].trends.lcp;

		assert.deepEqual(t.values, [2000, 1950, 1900, 1850, 1800]);
		assert.ok(!("points" in t), "full point objects must not be serialized 26x per site");
		assert.ok(!("path" in t), "internal lookup path is not needed by consumers");
		assert.ok(!("note" in t), "per-metric prose is emitted once under report.metrics");

		// Fields the templates do read.
		assert.equal(t.current, 1800);
		assert.equal(t.lowerIsBetter, true);
		assert.equal(typeof t.significant, "boolean");
		assert.ok(t.vsPrevious);
	});

	test("history is capped to the log rows the table renders", async () => {
		const f = fixture({ points: 50 });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });
		const e = r.entries[0];

		assert.equal(e.history.length, 30, "emitted history is bounded");
		assert.equal(e.historyCount, 50, "but the trend window is reported honestly");
		assert.equal(e.totalCount, 50);
		// Trends were computed over the whole window, not the emitted slice.
		assert.equal(e.trends.performance.values.length, 50);
	});

	test("carries the metric definitions so the report renders standalone", async () => {
		const f = fixture();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.ok(Array.isArray(r.metrics.LAB_METRICS));
		const lcp = r.metrics.LAB_METRICS.find((m) => m.key === "lcp");
		assert.equal(lcp.unit, "ms");
		assert.ok(lcp.label);
	});

	test("ranks globally and within the group separately", async () => {
		const f = fixture({ sites: 3 });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		for (let e of r.entries) {
			assert.ok(e.ranks.performance >= 1);
			// Group ranks are keyed by group id, so a site in several categories
			// carries a separate rank in each.
			assert.ok(e.groupRanks.g.performance >= 1);
		}
	});

	test("omits Core Web Vitals when CrUX is not configured", async () => {
		const f = fixture();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, cruxEnabled: false });

		assert.equal(r.cwvAvailable, false);
		assert.equal(r.entries[0].cwv, null);
	});

	test("offers the lab approximation when CrUX is configured", async () => {
		const f = fixture();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, cruxEnabled: true });

		assert.equal(r.entries[0].cwv.source, "lab");
	});

	test("reports coverage over an empty results directory", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-empty-"));
		tmp.push(dir);
		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { groups: { g: { name: "G", sites: [{ name: "A", url: "https://a.example/" }] } } };`
		);

		const r = await buildReport({ resultsDir: path.join(dir, "results"), configFile });

		assert.equal(r.entries.length, 1);
		assert.equal(r.entries[0].latest, null);
		assert.equal(r.entries[0].neverMeasured, true);
		assert.equal(r.coverage.never, 1);
		assert.equal(r.stats.measured, 0);
	});

	test("is deterministic for the same inputs", async () => {
		const f = fixture({ sites: 2 });
		const now = Date.UTC(2026, 5, 1);

		const a = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, now });
		const b = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, now });

		// `generated` is a wall-clock stamp; everything else must match.
		delete a.generated;
		delete b.generated;
		assert.deepEqual(a, b);
	});
});

describe("generator-driven reclassification", () => {
	/**
	 * A curated list records what was submitted, which drifts from what is true.
	 * `requireGenerator` moves the drifted entries into an emeritus category at
	 * report time, from what measurement actually found.
	 */
	function generatorFixture(generators, pinned = []) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-emeritus-"));
		tmp.push(dir);
		const store = new ResultStore(path.join(dir, "results"));

		generators.forEach((generator, i) => {
			store.write({
				url: `https://site${i}.example/`,
				name: `Site ${i}`,
				group: "curated",
				timestamp: Date.UTC(2026, 0, 1),
				date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
				completedRuns: 3,
				requestedRuns: 3,
				durationMs: 1000,
				error: null,
				lab: {
					requestedUrl: `https://site${i}.example/`,
					finalUrl: `https://site${i}.example/`,
					scores: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 },
					timings: { lcp: 1000, cls: 0, tbt: 0, fcp: 500, si: 600, ttfb: 100 },
					weight: { total: 1000, requests: 1, byType: {} },
					environment: { benchmarkIndex: 3800, lighthouseVersion: "13.4.1" },
				},
				// `raw` is what the report re-derives detection from.
				axe: generator ? { generator: { raw: generator }, headers: {} } : null,
				field: null,
			});
		});

		const entries = generators.map((_, i) => `{ url: "https://site${i}.example/" }`).join(",");
		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { pinned: ${JSON.stringify(pinned)}, groups: {
				curated: { name: "Curated", requireGenerator: ["eleventy", "build-awesome"], emeritusGroup: "past", sites: [${entries}] },
				past: { name: "Emeritus", sites: [] },
			} };`,
		);

		return { resultsDir: path.join(dir, "results"), configFile };
	}

	const groupOf = (report, id) => report.groups.find((g) => g.id === id);

	test("moves a site measured as a different generator", async () => {
		const f = generatorFixture(["Astro v5.0.0"]);
		const r = await buildReport(f);

		assert.equal(groupOf(r, "curated").entries.length, 0);
		assert.equal(groupOf(r, "past").entries.length, 1);
		assert.equal(r.emeritus.length, 1);
		assert.equal(r.emeritus[0].generator, "Astro");
		assert.equal(r.emeritus[0].to, "past");
	});

	test("a pinned site is exempt from the rule", async () => {
		// The escape hatch for detection that reads the page correctly and still
		// gets the answer wrong — a stale generator tag, a proxy stamping its own.
		// Without it, a category change made by hand is undone on the next build.
		const f = generatorFixture(["Astro v5.0.0"], ["https://site0.example/"]);
		const r = await buildReport(f);

		assert.equal(groupOf(r, "curated").entries.length, 1, "stays where the config puts it");
		assert.equal(groupOf(r, "past").entries.length, 0);
		assert.equal(r.emeritus.length, 0, "and is not reported as reclassified");
	});

	test("pinning one site does not exempt the others", async () => {
		const f = generatorFixture(["Astro v5.0.0", "Astro v5.0.0"], ["https://site0.example/"]);
		const r = await buildReport(f);

		assert.equal(groupOf(r, "curated").entries.length, 1);
		assert.equal(groupOf(r, "past").entries.length, 1);
		assert.equal(r.emeritus[0].url, "https://site1.example/");
	});

	test("keeps a site with no generator detected", async () => {
		// The normal case for a static site. Absence is not evidence.
		const r = await buildReport(generatorFixture([null]));
		assert.equal(groupOf(r, "curated").entries.length, 1);
		assert.equal(r.emeritus.length, 0);
	});

	test("keeps every accepted generator, including the rename", async () => {
		// Build Awesome reports under its own id, so it qualifies only because
		// the category lists it — the transitional and bare tags both count.
		const r = await buildReport(
			generatorFixture(["Eleventy v3.1.6", "Build Awesome v4.0.0", "Eleventy (Build Awesome) v4.0.0", "11ty"]),
		);
		assert.equal(groupOf(r, "curated").entries.length, 4);
		assert.equal(r.emeritus.length, 0);
	});

	test("a rename the category does not list is still moved out", async () => {
		// Guards the mechanism itself: qualifying is by explicit id, not by
		// sharing a brand mark with the required generator.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-emeritus-strict-"));
		tmp.push(dir);
		const f = generatorFixture(["Build Awesome v4.0.0"]);
		const config = fs.readFileSync(f.configFile, "utf8").replace('"eleventy", "build-awesome"', '"eleventy"');
		fs.writeFileSync(f.configFile, config);

		const r = await buildReport(f);
		assert.equal(groupOf(r, "past").entries.length, 1);
		assert.equal(r.emeritus[0].generator, "Build Awesome");
	});

	test("updates the entry's own group fields, not just the group listing", async () => {
		const r = await buildReport(generatorFixture(["Hugo 0.150.0"]));
		const entry = r.entries[0];
		assert.deepEqual(entry.groups, ["past"]);
		assert.equal(entry.group, "past");
		assert.equal(entry.groupName, "Emeritus");
	});

	test("does nothing to a group that declares no rule", async () => {
		const f = fixture({ sites: 2 });
		const r = await buildReport(f);
		assert.equal(r.emeritus.length, 0);
		assert.equal(groupOf(r, "g").entries.length, 2);
	});
});

describe("presumed generators", () => {
	/**
	 * A curated list is a claim about what built a site. Where nothing was
	 * detected, that claim is worth showing — but it must never behave like a
	 * measurement, and it must vanish the moment one contradicts it.
	 */
	function presumedFixture(generator) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-presumed-"));
		tmp.push(dir);
		const store = new ResultStore(path.join(dir, "results"));
		store.write({
			url: "https://site.example/",
			name: "Site",
			group: "curated",
			timestamp: Date.UTC(2026, 0, 1),
			date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
			completedRuns: 3,
			requestedRuns: 3,
			durationMs: 1000,
			error: null,
			lab: {
				requestedUrl: "https://site.example/",
				finalUrl: "https://site.example/",
				scores: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 },
				timings: { lcp: 1000, cls: 0, tbt: 0, fcp: 500, si: 600, ttfb: 100 },
				weight: { total: 1000, requests: 1, byType: {} },
				environment: { benchmarkIndex: 3800, lighthouseVersion: "13.4.1" },
			},
			axe: generator ? { generator: { raw: generator }, headers: {} } : null,
			field: null,
		});

		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { groups: {
				curated: {
					name: "Curated",
					requireGenerator: ["eleventy", "build-awesome"],
					emeritusGroup: "past",
					presumedGenerator: "build-awesome",
					sites: [{ url: "https://site.example/" }],
				},
				past: { name: "Emeritus", sites: [] },
			} };`,
		);
		return { resultsDir: path.join(dir, "results"), configFile };
	}

	test("stands in when nothing was detected", async () => {
		const r = await buildReport(presumedFixture(null));
		const entry = r.entries[0];
		assert.equal(entry.generator, null);
		assert.equal(entry.presumedGenerator.name, "Build Awesome");
		assert.equal(entry.presumedGenerator.presumed, true);
	});

	test("disappears once a real generator is detected", async () => {
		// The question this whole design turns on: nothing is stored, so the
		// presumption is simply not recomputed once evidence exists.
		const r = await buildReport(presumedFixture("Eleventy v3.1.6"));
		const entry = r.entries[0];
		assert.equal(entry.generator.name, "Eleventy");
		assert.equal(entry.presumedGenerator, undefined);
	});

	test("is never handed to a site on its way out of the category", async () => {
		// Detected as something else: it belongs to Emeritus, and must not pick up
		// the category's claim as it leaves.
		const r = await buildReport(presumedFixture("Astro v5.0.0"));
		const entry = r.entries[0];
		assert.deepEqual(entry.groups, ["past"]);
		assert.equal(entry.presumedGenerator, undefined);
	});

	test("never counts toward the Built with tally", async () => {
		// Otherwise every undetected site would inflate the numbers with guesses.
		const r = await buildReport(presumedFixture(null));
		assert.equal(r.stacks.generators.detected, 0);
		assert.equal(r.stacks.generators.unknown, 1);
	});
});

describe("returning to a category", () => {
	/**
	 * `11ty Emeritus` is defined by what a site *used* to be built with. One
	 * measuring as that thing again has come back, so leaving it there would
	 * state the opposite of the truth — the mirror image of requireGenerator.
	 */
	function emeritusFixture(generator) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-return-"));
		tmp.push(dir);
		const store = new ResultStore(path.join(dir, "results"));
		store.write({
			url: "https://site.example/",
			name: "Site",
			group: "past",
			timestamp: Date.UTC(2026, 0, 1),
			date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
			completedRuns: 3,
			requestedRuns: 3,
			durationMs: 1000,
			error: null,
			lab: {
				requestedUrl: "https://site.example/",
				finalUrl: "https://site.example/",
				scores: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 },
				timings: { lcp: 1000, cls: 0, tbt: 0, fcp: 500, si: 600, ttfb: 100 },
				weight: { total: 1000, requests: 1, byType: {} },
				environment: { benchmarkIndex: 3800, lighthouseVersion: "13.4.1" },
			},
			axe: generator ? { generator: { raw: generator }, headers: {} } : null,
			field: null,
		});

		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { groups: {
				current: {
					name: "Current",
					requireGenerator: ["eleventy", "build-awesome"],
					emeritusGroup: "past",
					sites: [],
				},
				past: {
					name: "Past",
					rejectGenerator: ["eleventy", "build-awesome"],
					rejectGroup: "current",
					sites: [{ url: "https://site.example/" }],
				},
			} };`,
		);
		return { resultsDir: path.join(dir, "results"), configFile };
	}

	const groupOf = (r, id) => r.groups.find((g) => g.id === id);

	test("a site rebuilt on the original generator moves back", async () => {
		const r = await buildReport(emeritusFixture("Eleventy v3.1.6"));
		assert.deepEqual(r.entries[0].groups, ["current"]);
		assert.equal(groupOf(r, "past").entries.length, 0);
		assert.equal(r.emeritus[0].to, "current");
	});

	test("the newer branding counts as a return too", async () => {
		const r = await buildReport(emeritusFixture("Build Awesome v4.0.0"));
		assert.deepEqual(r.entries[0].groups, ["current"]);
	});

	test("a site built with something else stays put", async () => {
		const r = await buildReport(emeritusFixture("Astro v5.0.0"));
		assert.deepEqual(r.entries[0].groups, ["past"]);
		assert.equal(r.emeritus.length, 0);
	});

	test("an undetected generator is not evidence of a return", async () => {
		const r = await buildReport(emeritusFixture(null));
		assert.deepEqual(r.entries[0].groups, ["past"]);
	});

	test("the two rules cannot bounce a site between them", async () => {
		// Whichever order they run in, a site the first rule moves has a generator
		// the second does not accept.
		for (let generator of ["Eleventy v3.1.6", "Astro v5.0.0"]) {
			const r = await buildReport(emeritusFixture(generator));
			assert.equal(r.entries[0].groups.length, 1, generator);
			assert.ok(r.emeritus.length <= 1, generator);
		}
	});
});

describe("fleet weight history", () => {
	/**
	 * The daily average is only meaningful once enough days exist. Over a short
	 * window the fleet's rolling schedule moves the line more than the sites do,
	 * so the report withholds the series rather than drawing a shape that is
	 * mostly sampling noise.
	 */
	function daysFixture(dayCount) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-weight-"));
		tmp.push(dir);
		const store = new ResultStore(path.join(dir, "results"));

		for (let d = 0; d < dayCount; d++) {
			store.write({
				url: "https://site.example/",
				name: "Site",
				group: "g",
				timestamp: Date.UTC(2026, 0, d + 1),
				date: new Date(Date.UTC(2026, 0, d + 1)).toISOString(),
				completedRuns: 3,
				requestedRuns: 3,
				durationMs: 1000,
				error: null,
				lab: {
					requestedUrl: "https://site.example/",
					finalUrl: "https://site.example/",
					scores: { performance: 90, accessibility: 100, "best-practices": 100, seo: 100 },
					timings: { lcp: 1000, cls: 0, tbt: 0, fcp: 500, si: 600, ttfb: 100 },
					weight: { total: 500000 + d * 1000, requests: 10, byType: {} },
					environment: { benchmarkIndex: 3800, lighthouseVersion: "13.4.1" },
				},
				field: null,
			});
		}

		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { historyLimit: null, groups: { g: { name: "G", sites: [{ url: "https://site.example/" }] } } };`,
		);
		return { resultsDir: path.join(dir, "results"), configFile };
	}

	test("is withheld below the minimum", async () => {
		const r = await buildReport(daysFixture(5));
		assert.deepEqual(r.stats.weightHistory, []);
	});

	test("appears once there is enough history", async () => {
		const r = await buildReport(daysFixture(14));
		assert.equal(r.stats.weightHistory.length, 14);
	});

	test("each point carries its date, average and sample size", async () => {
		const r = await buildReport(daysFixture(14));
		const first = r.stats.weightHistory[0];
		assert.match(first.date, /^\d{4}-\d{2}-\d{2}$/);
		assert.equal(first.avgWeight, 500000);
		assert.equal(first.sites, 1);
		// One measurement a day, ascending, so the series must ascend too.
		const values = r.stats.weightHistory.map((p) => p.avgWeight);
		assert.deepEqual(values, [...values].sort((a, b) => a - b));
	});

	test("is ordered oldest first, so a sparkline reads left to right", async () => {
		const r = await buildReport(daysFixture(14));
		const dates = r.stats.weightHistory.map((p) => p.date);
		assert.deepEqual(dates, [...dates].sort());
	});
});

describe("unlisted flag", () => {
	/**
	 * `requireGenerator` doubles as the statement "this category is the register
	 * of sites built with these things", so anything built with one and absent
	 * from the category is missing from the register. A category pulled *out* of
	 * that register is the exception: it is listed, just presented elsewhere.
	 */
	function registerFixture(extraGroups = "", groupsForSite = "") {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-unlisted-"));
		tmp.push(dir);
		const store = new ResultStore(path.join(dir, "results"));
		store.write({
			url: "https://site.example/",
			name: "Site",
			group: "other",
			timestamp: Date.UTC(2026, 0, 1),
			date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
			completedRuns: 3,
			requestedRuns: 3,
			durationMs: 1000,
			error: null,
			lab: {
				requestedUrl: "https://site.example/",
				finalUrl: "https://site.example/",
				scores: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 },
				timings: { lcp: 1000, cls: 0, tbt: 0, fcp: 500, si: 600, ttfb: 100 },
				weight: { total: 1000, requests: 1, byType: {} },
				environment: { benchmarkIndex: 3800, lighthouseVersion: "13.4.1" },
			},
			axe: { generator: { raw: "Eleventy v3.1.6" }, headers: {} },
			field: null,
		});

		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { groups: {
				register: { name: "Register", requireGenerator: ["eleventy"], sites: [] },
				other: { name: "Other"${groupsForSite}, sites: [{ url: "https://site.example/" }] },
				${extraGroups}
			} };`,
		);
		return { resultsDir: path.join(dir, "results"), configFile };
	}

	test("flags a site built with the register's generator but absent from it", async () => {
		const r = await buildReport(registerFixture());
		assert.equal(r.entries[0].unlisted.group, "register");
		assert.equal(r.entries[0].unlisted.generator, "Eleventy");
	});

	test("does not flag a category that declares it is listed there", async () => {
		// Filtered out of the register, not missing from it — telling someone to
		// submit an already-submitted site is worse than saying nothing.
		const r = await buildReport(registerFixture("", `, listedIn: "register"`));
		assert.equal(r.entries[0].unlisted, undefined);
	});

	test("a stale listedIn pointing nowhere flags as normal", async () => {
		// Naming a category that does not exist must not silently suppress the
		// flag — the site really is absent from every register.
		const r = await buildReport(registerFixture("", `, listedIn: "nonexistent"`));
		assert.equal(r.entries[0].unlisted.group, "register");
	});
});

describe("perfect scores", () => {
	/**
	 * "Perfect" is the home page's headline claim, and it is three conditions,
	 * not one: full marks in every Lighthouse category, a clean axe run, and no
	 * Core Web Vital failing real users. Lighthouse's accessibility category
	 * samples a subset of the rules axe runs in full, and its timings are one
	 * simulated load, so 100 with violations or with failing field data is
	 * ordinary — which is exactly why the other two conditions exist.
	 *
	 * The two treat absence differently, and these tests are where that is
	 * pinned: axe runs every time, so a missing result is a failed check and
	 * disqualifies; CrUX only samples sites with enough traffic, so a missing
	 * result is not evidence and does not.
	 */
	const clean = { violations: 0, violationRules: 0, error: null };
	const dirty = { violations: 3, violationRules: 2, error: null };

	/** A real CrUX response, rated the way the API rates it. */
	const crux = (rating) => ({
		metrics: {
			lcp: { p75: 1800, rating },
			inp: { p75: 120, rating },
			cls: { p75: 0.02, rating },
		},
		collectionPeriod: { first: "2025-12-01", last: "2025-12-28" },
		scope: "origin",
	});

	test("counts a site with full marks and a clean axe run", async () => {
		const f = fixture({ performance: () => 100, axe: clean });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.equal(r.entries[0].lighthouseTotal, 400);
		assert.equal(r.entries[0].perfect, true);
		assert.equal(r.stats.perfect, 1);
	});

	test("does not count full marks with axe violations", async () => {
		const f = fixture({ performance: () => 100, axe: dirty });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.equal(r.entries[0].lighthouseTotal, 400, "still a perfect Lighthouse total");
		assert.equal(r.entries[0].perfect, false);
		assert.equal(r.stats.perfect, 0);
	});

	test("does not count a site axe never ran against", async () => {
		const f = fixture({ performance: () => 100, axe: null });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		// Unchecked is not clean: null means the run failed, and assuming zero
		// would quietly promote every site the axe step skipped.
		assert.equal(r.entries[0].axeViolations, null);
		assert.equal(r.entries[0].perfect, false);
		assert.equal(r.stats.perfect, 0);
	});

	test("counts a site CrUX has no sample for", async () => {
		const f = fixture({ performance: () => 100, axe: clean });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		// No field data at all — the ring is gray, not red. Most of the corpus is
		// too small to appear in CrUX, and that measures traffic, not quality.
		assert.equal(r.entries[0].cwvFailures, null);
		assert.equal(r.entries[0].perfect, true);
		assert.equal(r.stats.perfect, 1);
	});

	test("counts a site whose field data is all good", async () => {
		const f = fixture({ performance: () => 100, axe: clean, field: crux("good") });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.equal(r.entries[0].cwvFailures, 0);
		assert.equal(r.entries[0].perfect, true);
		assert.equal(r.stats.perfect, 1);
	});

	test("does not count a site failing Core Web Vitals for real users", async () => {
		const f = fixture({ performance: () => 100, axe: clean, field: crux("poor") });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.equal(r.entries[0].lighthouseTotal, 400, "the lab still says perfect");
		assert.equal(r.entries[0].cwvFailures, 3);
		assert.equal(r.entries[0].perfect, false);
		assert.equal(r.stats.perfect, 0);
	});

	test("does not count amber Core Web Vitals either", async () => {
		const f = fixture({ performance: () => 100, axe: clean, field: crux("needs-improvement") });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.equal(r.entries[0].cwvFailures, 3);
		assert.equal(r.entries[0].perfect, false);
	});

	test("does not count an imperfect Lighthouse total, however clean", async () => {
		const f = fixture({ performance: () => 99, axe: clean });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.equal(r.entries[0].perfect, false);
		assert.equal(r.stats.perfect, 0);
	});
});

/*
 * These assert against the real config/legacy-api-urls.json — the contract is
 * with hashes deployed on pages we do not control, so a fixture would only be
 * asserting our own arithmetic. `npm run reset` deletes that file, and a fork
 * without the compatibility data has nothing here to test.
 */
const hasLegacyData = fs.existsSync(new URL("../config/legacy-api-urls.json", import.meta.url));

describe("legacy API filenames", { skip: hasLegacyData ? false : "no legacy API data in this instance" }, () => {
	/**
	 * The compatibility route is a contract with pages we do not control: a
	 * deployed <speedlify-score> hardcodes this hash in its markup. The original
	 * hashed the URL exactly as its config wrote it, with no normalizing, so our
	 * normalized form is the wrong filename for any deeper path.
	 *
	 * Checked against the live original: https://www.zachleat.com/about/ is
	 * served as 803cb8c3.json there, and 6bd2054c.json — our normalized hash —
	 * is a 404 there.
	 */
	test("keys a normalized path the way the original spelled it", async () => {
		const f = fixture({ url: () => "https://www.zachleat.com/about/" });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });
		const entry = r.entries[0];

		assert.equal(entry.url, "https://www.zachleat.com/about", "stored normalized");
		assert.deepEqual(entry.compatUrls, [
			{ url: "https://www.zachleat.com/about/", hash: "803cb8c3" },
		]);
	});

	test("publishes nothing for a URL the original never had", async () => {
		// The routes exist for embeds deployed against that instance. A URL it
		// never served has no such embed, so a file for it is one nothing asks for.
		const f = fixture({ url: () => "https://not-in-the-snapshot.example/" });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.deepEqual(r.entries[0].compatUrls, []);
		assert.deepEqual(r.compatRoutes, []);
	});

	test("emits one form for a root URL, which we do not normalize", async () => {
		const f = fixture({ url: () => "https://www.zachleat.com/" });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		// The value published in the component's own README.
		assert.deepEqual(r.entries[0].compatUrls, [
			{ url: "https://www.zachleat.com/", hash: "bbfa43c1" },
		]);
	});

	test("every route gets a distinct filename", async () => {
		const urls = ["https://astro.build/", "https://docusaurus.io/", "https://eslint.org/"];
		const f = fixture({ sites: 3, url: (i) => urls[i] });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		const names = r.compatRoutes.map((route) => route.hash);
		assert.equal(names.length, 3);
		assert.equal(new Set(names).size, names.length, "a collision would overwrite a file");
	});

	test("the index and the files are the same list", async () => {
		// Both are generated from compatRoutes, and this is the property that
		// makes that worth doing: a key naming a file we never wrote is a 404.
		const f = fixture({ url: () => "https://astro.build/" });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		for (let route of r.compatRoutes) {
			assert.ok(route.url, "every route carries the spelling it is keyed by");
			assert.equal(route.hash, shortHash(route.url));
		}
	});

	test("carries the four scores the component renders", async () => {
		const f = fixture({ url: () => "https://astro.build/" });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.deepEqual(Object.keys(r.compatRoutes[0].lighthouse).sort(), [
			"accessibility", "bestPractices", "performance", "seo",
		]);
	});

	/**
	 * The legacy API is 0–1, not 0–100: Lighthouse reports fractions and the
	 * original passed them through, so the component renders
	 * `parseInt(value * 100, 10)`. Our 0–100 number displayed as 10000.
	 */
	test("emits scores on the 0-1 scale the old component expects", async () => {
		const f = fixture({ performance: () => 100, url: () => "https://astro.build/" });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });
		const { lighthouse } = r.compatRoutes[0];

		assert.equal(lighthouse.performance, 1);
		assert.equal(lighthouse.seo, 1);
	});
});

describe("generator history", () => {
	/**
	 * When a site changed what built it, derived from the tag recorded with each
	 * measurement rather than from a note written when a category reassignment
	 * happened. The stored-note version would record when *we noticed* — which
	 * depends on when the site came up in a rolling schedule, is unknowable for
	 * anything measured before the feature existed, and cannot be corrected by
	 * re-running the report.
	 */
	test("records the measurement a change first appeared in", async () => {
		const f = fixture({
			points: 4,
			generator: (p) => (p < 2 ? "Eleventy v3.0.0" : "Astro v4.16.18"),
		});
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });
		const changes = r.entries[0].generatorHistory;

		assert.equal(changes.length, 1);
		assert.equal(changes[0].from, "Eleventy");
		assert.equal(changes[0].to, "Astro");
		assert.equal(changes[0].leftEleventy, true);
		assert.equal(changes[0].returnedToEleventy, false);
		// The third measurement, which is the first that saw Astro.
		assert.equal(changes[0].date, r.entries[0].history[2].date);
	});

	test("a rename is not a migration", async () => {
		// "Build Awesome" is Eleventy's newer branding. The tag changes, the
		// project does not, and flagging it would move the site to Emeritus.
		const f = fixture({
			points: 2,
			generator: (p) => (p < 1 ? "Eleventy v3.0.0" : "Eleventy (Build Awesome) v4.0.0"),
		});
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });
		const changes = r.entries[0].generatorHistory;

		assert.equal(changes.length, 1, "the change is still recorded");
		assert.equal(changes[0].leftEleventy, false, "but it is not a departure");
	});

	test("notices a site coming back", async () => {
		const f = fixture({ points: 2, generator: (p) => (p < 1 ? "Astro v4.16.18" : "Eleventy v3.0.0") });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.equal(r.entries[0].generatorHistory[0].returnedToEleventy, true);
	});

	test("a steady generator is not a change", async () => {
		const f = fixture({ points: 4, generator: () => "Eleventy v3.0.0" });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.deepEqual(r.entries[0].generatorHistory, []);
	});

	test("says nothing for a site that emits no tag", async () => {
		// The common case: most static sites have no generator meta at all, and
		// absence must not read as a migration to nothing.
		const f = fixture({ points: 4 });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.deepEqual(r.entries[0].generatorHistory, []);
	});

	test("a measurement that dropped the tag does not split the run", async () => {
		// One page load missing the meta — a failed run, a partial render — is not
		// evidence of anything, so points without a tag are skipped rather than
		// counted as a change to and from nothing.
		const f = fixture({
			points: 4,
			generator: (p) => (p === 2 ? null : "Eleventy v3.0.0"),
		});
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.deepEqual(r.entries[0].generatorHistory, []);
	});
});

describe("automatic archiving", () => {
	/**
	 * A site that has failed for long enough stops being ranked, without anyone
	 * editing a list.
	 *
	 * Derived from the stored failure count rather than written back into
	 * config/archived.json, which is what makes it reversible: a successful
	 * measurement resets the count and the site is simply back. Writing to the
	 * config would be a decision the data could no longer take back.
	 */
	const failing = (n) => ({ points: 1, error: () => "ECONNREFUSED", consecutiveFailures: n });

	test("archives a site past the threshold", async () => {
		const f = fixture(failing(14));
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.equal(r.archived.length, 1);
		assert.equal(r.archived[0].reason, "failing");
		assert.equal(r.archived[0].consecutiveFailures, 14);
		assert.equal(r.entries.length, 0, "and out of the ranked set");
	});

	test("leaves a site one short of it alone", async () => {
		const f = fixture(failing(13));
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.deepEqual(r.archived, []);
		assert.equal(r.entries.length, 1);
		assert.equal(r.entries[0].currentlyFailing, true, "still visibly failing, just not archived");
	});

	test("a site that recovers is not archived", async () => {
		// The newest measurement succeeded, so the streak is zero however bad the
		// run of failures before it was.
		const f = fixture({ points: 2, error: (p) => (p === 0 ? "ECONNREFUSED" : null), consecutiveFailures: 99 });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.deepEqual(r.archived, []);
		assert.equal(r.entries.length, 1);
	});

	test("can be turned off with a zero threshold", async () => {
		const f = fixture(failing(99));
		fs.writeFileSync(
			f.configFile,
			fs.readFileSync(f.configFile, "utf8").replace("export default {", "export default { archiveAfterFailures: 0,"),
		);
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile });

		assert.deepEqual(r.archived, []);
		assert.equal(r.entries.length, 1);
	});
});

describe("rank movement", () => {
	const site = (perf, axe, si = 1000) => ({
		latest: {
			lab: {
				scores: { performance: perf, accessibility: 100, "best-practices": 100, seo: 100 },
				timings: { si, ttfb: 100, tbt: 0 },
				weight: { byType: { document: 1000, stylesheet: 1000, script: 1000 } },
			},
			axe: { violations: axe },
		},
	});

	test("a climb is reported when a scored input improved", () => {
		const entry = { ...site(100, 0), previous: site(50, 0).latest };
		assert.equal(rankClimb(entry, 12), 12);
	});

	test("stays silent when nothing scored changed", () => {
		// Same scores, different Speed Index: the board is dense enough that this
		// alone moves a site, but nothing about it actually improved.
		const entry = { ...site(100, 0, 900), previous: site(100, 0, 1100).latest };
		assert.equal(rankClimb(entry, 40), null);
	});

	test("counts an axe change as a scored input", () => {
		const entry = { ...site(100, 0), previous: site(100, 9).latest };
		assert.equal(rankClimb(entry, 5), 5);
	});

	test("never reports a fall", () => {
		const entry = { ...site(50, 0), previous: site(100, 0).latest };
		assert.equal(rankClimb(entry, -30), null);
	});

	test("ignores moves of one or two places", () => {
		const entry = { ...site(100, 0), previous: site(99, 0).latest };
		assert.equal(rankClimb(entry, 2), null);
		assert.equal(rankClimb(entry, 3), 3);
	});

	test("a site measured once has not moved", () => {
		assert.equal(rankClimb({ ...site(100, 0), previous: null }, 9), null);
	});
});

describe("newly perfect window", () => {
	// The last point is perfect, the one before it is not — the transition the
	// card reports. Points are written on 2026-01-01 and 2026-01-02.
	const flipped = () =>
		fixture({ points: 2, performance: (p) => (p === 0 ? 99 : 100), axe: { violations: 0, passes: 30 } });
	const LAST_POINT = Date.UTC(2026, 0, 2);
	const HOUR = 3600 * 1000;

	test("lists a site that turned perfect inside the window", async () => {
		const f = flipped();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, now: LAST_POINT + 24 * HOUR });

		assert.equal(r.stats.newlyPerfect.length, 1);
		assert.equal(r.stats.newlyPerfect[0].displayUrl, "site0.example");
	});

	test("drops it once it is older than the window", async () => {
		const f = flipped();
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, now: LAST_POINT + 72 * HOUR });

		assert.equal(r.stats.newlyPerfect.length, 0);
	});

	test("the boundary is inclusive", async () => {
		const f = flipped();
		const at = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, now: LAST_POINT + 48 * HOUR });
		const past = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, now: LAST_POINT + 48 * HOUR + 1 });

		assert.equal(at.stats.newlyPerfect.length, 1, "exactly 48h old still counts");
		assert.equal(past.stats.newlyPerfect.length, 0, "a millisecond later does not");
	});

	test("recently measured yields its rows to the list below", async () => {
		// Fourteen sites so the twelve-row cap actually binds, of which only the
		// first four turn perfect — the rest stay a point short on both runs.
		const f = fixture({
			sites: 14,
			points: 2,
			performance: (p, s) => (s < 4 && p === 1 ? 100 : 99),
			axe: { violations: 0, passes: 30 },
		});
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, now: LAST_POINT + 24 * HOUR });

		assert.equal(r.stats.newlyPerfect.length, 4);
		// Twelve rows between them, so four perfect rows leave room for eight.
		assert.equal(r.stats.recentlyMeasured.length, 8);
	});

	test("recently measured disappears when the list below fills the card", async () => {
		const f = fixture({ sites: 14, points: 2, performance: (p) => (p === 0 ? 99 : 100), axe: { violations: 0, passes: 30 } });
		const r = await buildReport({ resultsDir: f.resultsDir, configFile: f.configFile, now: LAST_POINT + 24 * HOUR });

		assert.equal(r.stats.newlyPerfect.length, 14);
		// Not one row, and not a negative slice: the section is simply absent.
		assert.equal(r.stats.recentlyMeasured.length, 0);
	});
});

describe("embed opt-in", () => {
	/** Two categories, only one of which asks for the embed section. */
	function embedFixture({ showEmbed = undefined, second = null } = {}) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-embed-"));
		tmp.push(dir);

		const store = new ResultStore(path.join(dir, "results"));
		for (const url of ["https://a.example/", "https://b.example/"]) {
			store.write({
				url,
				name: url,
				group: "one",
				timestamp: Date.UTC(2026, 0, 1),
				date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
				completedRuns: 3,
				requestedRuns: 3,
				durationMs: 1000,
				error: null,
				variance: { spread: 1 },
				lab: {
					requestedUrl: url,
					finalUrl: url,
					redirect: null,
					scores: { performance: 90, accessibility: 100, "best-practices": 100, seo: 100 },
					timings: { lcp: 2000, cls: 0.01, tbt: 30, fcp: 1000, si: 1200, ttfb: 200 },
					weight: { total: 1000, requests: 10, byType: {} },
					thirdParty: { count: 0, bytes: 0, mainThreadMs: 0, top: [] },
					waste: { unusedJsBytes: 0, unusedCssBytes: 0 },
					mainThread: { total: 100, longTasks: 0, byGroup: {} },
					dom: { elements: 100, depth: 5, maxChildren: 3 },
					accessibility: { failingCount: 0, applicableCount: 10, failingNodes: 0, failing: [] },
					hygiene: { https: 1, protocol: "h2", consoleErrors: 0 },
					environment: { benchmarkIndex: 3000, lighthouseVersion: "13.4.1" },
					lcpBreakdown: { timeToFirstByte: 100 },
				},
			});
		}

		const flag = showEmbed === undefined ? "" : `showEmbed: ${showEmbed},`;
		const configFile = path.join(dir, "sites.js");
		fs.writeFileSync(
			configFile,
			`export default { runs: 3, formFactor: "mobile", groups: {
				one: { name: "One", ${flag} sites: [{ url: "https://a.example/" }, { url: "https://b.example/" }] },
				${second ? `two: { name: "Two", ${second}, sites: [{ url: "https://b.example/" }] },` : ""}
			} };`,
		);

		return { resultsDir: path.join(dir, "results"), configFile };
	}

	const bySite = (r) => Object.fromEntries(r.entries.map((e) => [e.displayUrl, e.showEmbed]));

	test("a category has to ask for it", async () => {
		const f = embedFixture();
		const r = await buildReport(f);

		// Opt-in: silence is off, not on.
		assert.deepEqual(bySite(r), { "a.example": false, "b.example": false });
	});

	test("showEmbed: true turns it on for that category's sites", async () => {
		const f = embedFixture({ showEmbed: true });
		const r = await buildReport(f);

		assert.deepEqual(bySite(r), { "a.example": true, "b.example": true });
	});

	test("membership in any opted-in category is enough", async () => {
		const f = embedFixture({ showEmbed: false, second: "showEmbed: true" });
		const r = await buildReport(f);

		// b is in both; only the second category asks, which carries it.
		assert.deepEqual(bySite(r), { "a.example": false, "b.example": true });
	});

	test("only an exact true counts, not any truthy value", async () => {
		const f = embedFixture({ showEmbed: '"yes"' });
		const r = await buildReport(f);

		assert.deepEqual(bySite(r), { "a.example": false, "b.example": false });
	});
});
