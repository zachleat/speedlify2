import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ResultStore } from "../lib/store.js";
import { keepsScreenshots, keepsFilmstrip, filmstripMarkers } from "../lib/runner.js";
import { clientRendered, alignFirstFrame } from "../lib/report.js";

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

	test("primary keeps the no-JS capture but not the filmstrip", () => {
		// The whole point of the middle mode: the Without JavaScript comparison
		// without the frames, which are the expensive half.
		assert.equal(keepsScreenshots({ screenshots: "primary" }, nearly), true);
		assert.equal(keepsFilmstrip({ screenshots: "primary" }, nearly), false);
	});

	test("the filmstrip gate is stricter than the screenshot gate", () => {
		assert.equal(keepsFilmstrip({ screenshots: "filmstrip" }), true);
		assert.equal(keepsFilmstrip({ screenshots: "none" }), false);
		// Default is the richest mode, so an unset site keeps everything.
		assert.equal(keepsFilmstrip({}), true);
		assert.equal(keepsFilmstrip(undefined), true);
	});

	test("full marks lifts a site to primary, not to filmstrip", () => {
		// The perfect-site card draws one viewport capture, so the override grants
		// the no-JS pair and stops there — a strip is not what it needs.
		assert.equal(keepsScreenshots({ screenshots: "none" }, perfect), true);
		assert.equal(keepsFilmstrip({ screenshots: "none" }), false);
		assert.equal(keepsFilmstrip({ screenshots: "primary" }), false);
	});
});

describe("the client-rendering verdict", () => {
	const empty = { noJs: {}, noJsText: 0.4, difference: 87.7 };

	test("a page that said nothing and changed when scripted is flagged", () => {
		assert.equal(clientRendered(empty), true);
	});

	test("a page that drew itself without scripts is not", () => {
		assert.equal(clientRendered({ noJs: {}, noJsText: 34.6, difference: 0 }), false);
	});

	test("nothing to judge without a no-JS capture", () => {
		assert.equal(clientRendered({ noJsText: 0, difference: 90 }), null);
		assert.equal(clientRendered(null), null);
	});

	test("a bot check is unjudged rather than cleared", () => {
		// tesla.com serves an Access Denied page to the crawler. It is textless
		// and identical with scripts and without, so both measures read innocent
		// and the site came back "not client-rendered" — an answer about the wall
		// and not about the site.
		const wall = { noJs: {}, noJsText: 2.2, difference: 0.1 };
		assert.equal(clientRendered(wall), false);
		assert.equal(clientRendered(wall, "Access Denied"), null);
		assert.equal(clientRendered(empty, "Vercel Security Checkpoint"), null);
	});
});

describe("first frame alignment", () => {
	const frames = [{ timing: 5611, src: "a" }, { timing: 11222, src: "b" }];

	test("moves a first frame taken after FCP back to FCP", () => {
		const out = alignFirstFrame(frames, { fcp: 1430, lcp: 1430 }, 11222);
		assert.deepEqual(out.frames.map((f) => f.timing), [1430, 11222]);
		assert.equal(out.settledAt, 11222);
	});

	test("carries a settle on the first frame with it", () => {
		assert.equal(alignFirstFrame(frames, { fcp: 1430 }, 5611).settledAt, 1430);
	});

	test("moves the first frame to differ from the blank ones before FCP", () => {
		const blank = [2433, 4865, 7298, 9731].map((timing) => ({ timing, src: "blank" }));
		const strip = [...blank, { timing: 12163, src: "painted" }, { timing: 14596, src: "later" }];
		const out = alignFirstFrame(strip, { fcp: 11565 }, 14596);
		assert.deepEqual(out.frames.map((f) => f.timing), [2433, 4865, 7298, 9731, 11565, 14596]);
	});

	test("leaves a strip alone when a blank frame was taken after FCP", () => {
		const strip = [{ timing: 1000, src: "blank" }, { timing: 2000, src: "blank" }, { timing: 3000, src: "painted" }];
		assert.equal(alignFirstFrame(strip, { fcp: 1500 }, 3000).frames, strip);
	});

	test("leaves strips whose first frame is not after FCP alone", () => {
		assert.equal(alignFirstFrame(frames, { fcp: 12000 }, 11222).frames, frames);
		assert.equal(alignFirstFrame(frames, null, 11222).frames, frames);
	});
});

describe("filmstrip markers", () => {
	test("keeps TTFB, FCP and LCP from the capturing pass", () => {
		assert.deepEqual(filmstripMarkers({ ttfb: 610, fcp: 1820, lcp: 2400, si: 3000 }), { ttfb: 610, fcp: 1820, lcp: 2400 });
	});

	test("adds DevTools request latency to TTFB only", () => {
		assert.deepEqual(filmstripMarkers({ ttfb: 4, fcp: 1440, lcp: 1440 }, 562.5), { ttfb: 567, fcp: 1440, lcp: 1440 });
	});

	test("nothing to keep is null", () => {
		assert.equal(filmstripMarkers({ ttfb: null }), null);
		assert.equal(filmstripMarkers(undefined), null);
	});

	test("are written into the filmstrip manifest", () => {
		const d = dir();
		const store = new ResultStore(d);
		const frames = [{ timing: 375, buffer: Buffer.from([1, 2, 3]) }];
		store.writeFilmstrip(d, frames, 0, "devtools", { fcp: 1820 });
		const manifest = JSON.parse(fs.readFileSync(path.join(d, "filmstrip.json"), "utf8"));
		assert.deepEqual(manifest.markers, { fcp: 1820 });
		assert.equal(manifest.throttlingMethod, "devtools");
	});
});
