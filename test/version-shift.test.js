import { test } from "node:test";
import assert from "node:assert/strict";

import { buildVersionShift } from "../lib/report.js";

const site = (...runs) => ({ history: runs.map(([lh, performance], t) => ({ t, lh, performance })) });

test("pairs the last run on the previous version with the first on the newest", () => {
	const shift = buildVersionShift([
		site(["13.4.1", 70], ["13.4.1", 85], ["13.6.0", 92], ["13.6.0", 40]),
		site(["13.4.1", 95], ["13.4.1", 95], ["13.6.0", 95]),
		site(["13.4.1", 60]),
	]);

	assert.equal(shift.from, "13.4.1");
	assert.equal(shift.to, "13.6.0");
	assert.equal(shift.count, 2);
	assert.equal(shift.improved, 1);
	assert.equal(shift.worsened, 0);
	assert.deepEqual([shift.up, shift.down, shift.same], [1, 0, 1]);
	assert.equal(shift.steady, 50);
	assert.deepEqual(shift.rows.find((r) => r.band === "average").cells.map((c) => c.count), [0, 0, 1]);
});

test("orders versions numerically and skips pairs across older versions", () => {
	const shift = buildVersionShift([
		site(["13.10.0", 50], ["13.9.0", 50]),
		site(["13.9.0", 50], ["13.10.0", 60]),
		site(["13.4.1", 50], ["13.10.0", 60]),
	]);

	assert.equal(shift, null);
});

test("returns null with a single version", () => {
	assert.equal(buildVersionShift([site(["13.4.1", 80], ["13.4.1", 82])]), null);
});
