import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { selectSiteOfTheDay } from "../lib/site-of-the-day.js";

// Every eligible perfect site is featured once before any is featured twice, recomputed rather than stored.

const pool = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ url: `https://site${from + i}.example/` }));
const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
const options = { start: day(0) };

const select = (poolFor, d, opts = options) =>
	selectSiteOfTheDay(typeof poolFor === "function" ? poolFor : () => poolFor, d, opts);
const run = (poolFor, days, from = 0) => Array.from({ length: days }, (_, i) => select(poolFor, day(from + i)).entry.url);

describe("perfect site of the day", () => {
	test("features every site once before repeating any", () => {
		const entries = pool(12);
		const picked = run(entries, 12);

		assert.equal(new Set(picked).size, 12, "no repeats within a cycle");
		assert.deepEqual([...picked].sort(), entries.map((e) => e.url).sort(), "every site had a turn");
	});

	test("starts a fresh cycle once every site has been featured", () => {
		const entries = pool(5);

		assert.equal(new Set(run(entries, 5, 0)).size, 5);
		assert.equal(new Set(run(entries, 5, 5)).size, 5, "the second cycle covers the pool again");
		assert.equal(select(entries, day(4)).cycle, 1);
		assert.equal(select(entries, day(5)).cycle, 2);
	});

	test("a growing pool does not bring back a recent pick", () => {
		// Keying cycles to the pool size moved the cycle start whenever the pool grew, repeating a site 3 days on.
		const poolFor = (d) => (d < day(4) ? pool(10) : pool(19));
		const picked = run(poolFor, 19);

		assert.equal(new Set(picked).size, 19, "no repeats until all 19 have had a turn");
	});

	test("earlier days replay against the pool they had", () => {
		const poolFor = (d) => (d < day(3) ? pool(6) : pool(6, 100));
		const early = run(poolFor, 3);
		const later = select(poolFor, day(3));

		assert.deepEqual(run(poolFor, 3), early, "past picks unchanged by later pools");
		assert.equal(later.position, 4, "the three earlier picks still count");
	});

	test("is pure — the hourly rebuild recomputes the same answer", () => {
		const entries = pool(30);
		for (const d of [0, 7, 29, 30, 101]) {
			assert.equal(select(entries, day(d)).entry.url, select(entries, day(d)).entry.url, `day ${d} is stable`);
		}
	});

	test("reports its position in the cycle", () => {
		const entries = pool(4);
		assert.deepEqual(
			[0, 1, 2, 3, 4].map((d) => select(entries, day(d)).position),
			[1, 2, 3, 4, 1],
		);
		assert.equal(select(entries, day(0)).pool, 4);
	});

	test("a one-site pool features it every day rather than failing", () => {
		const entries = pool(1);
		assert.equal(select(entries, day(0)).entry.url, entries[0].url);
		assert.equal(select(entries, day(9)).entry.url, entries[0].url);
	});

	test("an empty pool yields nothing rather than throwing", () => {
		assert.equal(select([], day(0)), null);
	});

	test("a day before the start picks from its own pool", () => {
		const r = select(pool(7), "2025-11-03");
		assert.equal(r.position, 1);
	});
});
