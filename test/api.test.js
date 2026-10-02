import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildReport } from "../lib/report.js";
import { ResultStore } from "../lib/store.js";
import { siteApi, groupApi, groupsApi } from "../lib/api.js";

const tmp = [];
afterEach(() => {
	while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
});

// Three measured sites with different scores, one never measured, one listed with a trailing slash on a path.
async function report() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-api-"));
	tmp.push(dir);
	const store = new ResultStore(path.join(dir, "results"));

	const measured = ["https://a.example/", "https://b.example/", "https://c.example/docs"];
	measured.forEach((url, i) => {
		store.write({
			url,
			name: url,
			group: "g",
			timestamp: Date.UTC(2026, 0, i + 1),
			date: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
			completedRuns: 3,
			requestedRuns: 3,
			variance: { spread: 1 },
			lab: {
				requestedUrl: url,
				finalUrl: url,
				scores: { performance: 70 + i * 10, accessibility: 100, "best-practices": 100, seo: 100 },
				timings: { lcp: 2000, cls: 0.01, tbt: 30, fcp: 1000, si: 1200 },
				weight: { total: 500000, requests: 40, byType: {} },
			},
		});
	});

	const configFile = path.join(dir, "sites.js");
	fs.writeFileSync(
		configFile,
		`export default { groups: {
			g: { name: "Group", sites: [
				{ url: "https://a.example/" },
				{ url: "https://never.example/" },
				{ url: "https://b.example/" },
				{ url: "https://c.example/docs/" },
			] },
			other: { name: "Other", sites: [{ url: "https://a.example" }] },
		} };`,
	);

	return JSON.parse(JSON.stringify(await buildReport({ resultsDir: path.join(dir, "results"), configFile })));
}

describe("group API", () => {
	test("each group entry matches that site's /api/site/ file", async () => {
		const r = await report();
		const group = groupApi(r.groups.find((g) => g.id === "g"));

		assert.equal(group.sites.length, 4);
		for (let row of group.sites) {
			const entry = r.entries.find((e) => e.slug === row.slug);
			const site = siteApi(entry);
			assert.equal(row.page, `/site/${row.slug}/`);
			for (let key of ["url", "page", "measured", "stale", "rank", "total", "lighthouse", "axe", "cwv"]) {
				assert.deepEqual(row[key], site[key] ?? null, `${row.slug}: ${key}`);
			}
		}
	});

	test("sorts by rank with unmeasured sites last", async () => {
		const r = await report();
		const { sites, updated } = groupApi(r.groups.find((g) => g.id === "g"));

		assert.deepEqual(
			sites.map((s) => s.url),
			["https://c.example/docs", "https://b.example/", "https://a.example/", "https://never.example/"],
		);
		const last = sites.at(-1);
		assert.equal(last.measured, false);
		assert.equal(last.rank, null);
		assert.equal(last.lighthouse, null);
		assert.equal(updated, new Date(Date.UTC(2026, 0, 3)).toISOString());
	});

	test("requestedUrl is the URL as each group's list wrote it", async () => {
		const r = await report();
		const g = groupApi(r.groups.find((g) => g.id === "g"));
		const other = groupApi(r.groups.find((g) => g.id === "other"));

		assert.equal(g.sites.find((s) => s.url === "https://c.example/docs").requestedUrl, "https://c.example/docs/");
		assert.equal(other.sites[0].url, "https://a.example/");
		assert.equal(other.sites[0].requestedUrl, "https://a.example");
	});

	test("the index lists each group with its site count", async () => {
		const r = await report();
		assert.deepEqual(groupsApi(r.groups), [
			{ group: "Group", slug: "g", count: 4, api: "/api/group/g.json" },
			{ group: "Other", slug: "other", count: 1, api: "/api/group/other.json" },
		]);
	});
});
