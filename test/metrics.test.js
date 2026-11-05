import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMetrics } from "../lib/metrics.js";

test("dom-size-insight savings are not read as an element count", () => {
	// Lighthouse 13.6 puts estimated savings in an insight's numericValue.
	const items = [
		{ statistic: "DOM depth", value: 12 },
		{ statistic: "Most children", value: 30 },
	];
	const lhr = { audits: { "dom-size-insight": { numericValue: 120, details: { items } } } };
	assert.equal(extractMetrics(lhr).dom.elements, null);
});
