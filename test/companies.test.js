import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexCompanies, companyFor, auditCompanies } from "../lib/companies.js";
import companies from "../config/companies.js";
import config from "../config/sites.js";

const COMPANY_GROUPS = ["big-tech", "hosts", "builders"];
const siteUrls = COMPANY_GROUPS.flatMap((g) => (config.groups[g]?.sites ?? []).map((s) => s.url));

describe("indexCompanies", () => {
	test("indexes every URL a company owns", () => {
		const { byUrl } = indexCompanies([
			{ name: "Microsoft", employees: 228000, urls: ["https://a.example/", "https://b.example/"] },
		]);
		assert.equal(byUrl.get("https://a.example/").name, "Microsoft");
		assert.equal(byUrl.get("https://b.example/").name, "Microsoft");
	});

	test("reports a URL two companies both claim", () => {
		const { duplicates } = indexCompanies([
			{ name: "One", employees: 1, urls: ["https://x.example/"] },
			{ name: "Two", employees: 2, urls: ["https://x.example/"] },
		]);
		assert.equal(duplicates.length, 1);
		assert.deepEqual(
			{ held: duplicates[0].held, also: duplicates[0].also },
			{ held: "One", also: "Two" },
		);
	});

	test("keeps the first claim rather than the last", () => {
		const { byUrl } = indexCompanies([
			{ name: "One", employees: 1, urls: ["https://x.example/"] },
			{ name: "Two", employees: 2, urls: ["https://x.example/"] },
		]);
		assert.equal(byUrl.get("https://x.example/").name, "One");
	});
});

describe("companyFor", () => {
	// The two config files are hand-maintained separately, so one writing a
	// trailing slash and the other not is the expected kind of drift.
	test("matches across trailing-slash differences", () => {
		const index = indexCompanies([{ name: "Co", employees: 5, urls: ["https://ex.example/a/"] }]);
		assert.equal(companyFor(index, "https://ex.example/a")?.name, "Co");
	});

	test("returns null for a site no company claims", () => {
		const index = indexCompanies([{ name: "Co", employees: 5, urls: ["https://ex.example/"] }]);
		assert.equal(companyFor(index, "https://other.example/"), null);
	});
});

describe("auditCompanies", () => {
	test("names sites with no company and companies with no site", () => {
		const audit = auditCompanies(
			[{ name: "Co", employees: 5, urls: ["https://gone.example/"] }],
			["https://new.example/"],
		);
		assert.deepEqual(audit.unmapped, ["https://new.example/"]);
		assert.deepEqual(audit.stale, ["https://gone.example/"]);
	});

	test("separates a null headcount from a missing entry", () => {
		const audit = auditCompanies(
			[{ name: "Private Co", employees: null, urls: ["https://p.example/"] }],
			["https://p.example/"],
		);
		assert.deepEqual(audit.unmapped, []);
		assert.deepEqual(audit.missing, ["Private Co"]);
	});
});

describe("config/companies.js", () => {
	test("covers every site in the three company categories", () => {
		const { unmapped } = auditCompanies(companies, siteUrls);
		assert.deepEqual(unmapped, [], `${unmapped.length} site(s) have no company entry`);
	});

	test("lists no URL that has left the config", () => {
		const { stale } = auditCompanies(companies, siteUrls);
		assert.deepEqual(stale, [], `${stale.length} company URL(s) match no configured site`);
	});

	test("gives each site exactly one company", () => {
		const { duplicates } = indexCompanies(companies);
		assert.deepEqual(duplicates, []);
	});

	// urls[0] is what the chart plots, so its order is load-bearing rather than
	// cosmetic. This does not know which site is the flagship; it catches the
	// regression that matters, a deep product URL sorted ahead of a root one.
	test("lists the canonical site first", () => {
		for (const company of companies) {
			if (company.urls.length < 2) continue;
			const depth = (u) => new URL(u).pathname.replace(/\/$/, "").split("/").length;
			for (const other of company.urls.slice(1)) {
				assert.ok(
					depth(company.urls[0]) <= depth(other),
					`${company.name} lists ${other} ahead of a barer URL`,
				);
			}
		}
	});

	test("dates and sources every headcount it publishes", () => {
		for (const company of companies) {
			assert.ok(company.source, `${company.name} has no source`);
			if (company.employees === null) continue;
			assert.ok(company.employees > 0, `${company.name} has a non-positive headcount`);
			// A number with no date cannot be checked or aged out, and the chart's
			// whole defense is that its figures are attributable.
			assert.match(company.asOf ?? "", /^\d{4}-\d{2}$/, `${company.name} has no usable asOf`);
		}
	});
});
