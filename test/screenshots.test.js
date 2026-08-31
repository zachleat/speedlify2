import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ResultStore } from "../lib/store.js";
import { keepsScreenshots } from "../lib/runner.js";

/**
 * The two screenshots a measurement stores: the page as rendered, and the same
 * page with scripts disabled.
 *
 * The slots are written independently — the no-JS load can time out on its own
 * while the ordinary one succeeded — so most of what matters here is that one
 * missing slot never clears the other.
 */

const tmp = [];
afterEach(() => {
	while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true });
});

function dir() {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "speedlify-shots-"));
	tmp.push(d);
	return d;
}

const shot = (byte, type = "webp") => ({
	buffer: Buffer.from([byte, byte, byte]),
	type,
	width: 800,
	height: 600,
});

const manifestIn = (d) => JSON.parse(fs.readFileSync(path.join(d, "screenshot.json"), "utf8"));

describe("screenshot storage", () => {
	test("writes both slots and names them for what they are", () => {
		const d = dir();
		const store = new ResultStore(d);

		const manifest = store.writeScreenshots(d, { primary: shot(1), noJs: shot(2) });

		assert.equal(manifest.file, "screenshot.webp");
		assert.equal(manifest.noJs.file, "screenshot-nojs.webp");
		assert.equal(manifest.width, 800);
		assert.equal(manifest.noJs.height, 600);
		assert.ok(fs.existsSync(path.join(d, "screenshot.webp")));
		assert.ok(fs.existsSync(path.join(d, "screenshot-nojs.webp")));
		assert.deepEqual(manifestIn(d), manifest);
	});

	test("a failed no-JS load keeps the one already on disk", () => {
		const d = dir();
		const store = new ResultStore(d);

		store.writeScreenshots(d, { primary: shot(1), noJs: shot(2) });
		// Next measurement: the ordinary load worked, the no-JS load timed out.
		const manifest = store.writeScreenshots(d, { primary: shot(3), noJs: null });

		assert.equal(manifest.noJs.file, "screenshot-nojs.webp", "kept the previous no-JS entry");
		assert.ok(fs.existsSync(path.join(d, "screenshot-nojs.webp")), "and its file");
		assert.deepEqual([...fs.readFileSync(path.join(d, "screenshot.webp"))], [3, 3, 3], "primary replaced");
		assert.deepEqual([...fs.readFileSync(path.join(d, "screenshot-nojs.webp"))], [2, 2, 2], "no-JS untouched");
	});

	test("nothing to write leaves the whole manifest alone", () => {
		const d = dir();
		const store = new ResultStore(d);

		store.writeScreenshots(d, { primary: shot(1), noJs: shot(2) });
		assert.equal(store.writeScreenshots(d, { primary: null, noJs: null }), null);
		assert.equal(manifestIn(d).noJs.file, "screenshot-nojs.webp");
	});

	test("a format change removes the file of the old type", () => {
		const d = dir();
		const store = new ResultStore(d);

		store.writeScreenshots(d, { primary: shot(1, "jpeg"), noJs: shot(2, "jpeg") });
		assert.ok(fs.existsSync(path.join(d, "screenshot.jpg")));

		const manifest = store.writeScreenshots(d, { primary: shot(3), noJs: shot(4) });

		assert.equal(manifest.file, "screenshot.webp");
		assert.ok(!fs.existsSync(path.join(d, "screenshot.jpg")), "stale JPEG swept");
		assert.ok(!fs.existsSync(path.join(d, "screenshot-nojs.jpg")), "stale no-JS JPEG swept");
	});

	test("buffers never reach the measurement record", () => {
		const d = dir();
		const store = new ResultStore(path.join(d, "results"));
		const url = "https://example.com/";

		store.write({
			url,
			name: "Example",
			group: "test",
			timestamp: Date.now(),
			date: new Date().toISOString(),
			lab: { scores: { performance: 100 } },
			pageShots: { js: shot(1), noJs: shot(2) },
		});

		const written = store.history(url);
		assert.equal(written.length, 1);
		assert.ok(!("pageShots" in written[0]), "pageShots stripped before serialization");
		assert.ok(!JSON.stringify(written[0]).includes("Buffer"), "no encoded buffer anywhere in the record");
	});
});

describe("who keeps their pictures", () => {
	const perfect = { scores: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 } };
	const nearly = { scores: { performance: 99, accessibility: 100, "best-practices": 100, seo: 100 } };

	test("a category that wants pictures keeps them at any score", () => {
		assert.equal(keepsScreenshots({ screenshots: "filmstrip" }, nearly), true);
		assert.equal(keepsScreenshots({ screenshots: "filmstrip" }, null), true);
	});

	test("a category that opted out keeps none", () => {
		assert.equal(keepsScreenshots({ screenshots: "none" }, nearly), false);
	});

	test("full marks overrides the opt-out", () => {
		assert.equal(keepsScreenshots({ screenshots: "none" }, perfect), true);
	});

	test("one point short is not full marks", () => {
		// The override is for 400 exactly — otherwise the opt-out would leak.
		assert.equal(keepsScreenshots({ screenshots: "none" }, nearly), false);
	});

	test("no measurement is not full marks", () => {
		assert.equal(keepsScreenshots({ screenshots: "none" }, null), false);
		assert.equal(keepsScreenshots({ screenshots: "none" }, { scores: null }), false);
		assert.equal(keepsScreenshots({ screenshots: "none" }, { scores: {} }), false);
	});

	test("the default is to keep them", () => {
		assert.equal(keepsScreenshots({}, null), true);
		assert.equal(keepsScreenshots(undefined, null), true);
	});
});
