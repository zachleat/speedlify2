import puppeteer from "puppeteer-core";
import { AxePuppeteer } from "@axe-core/puppeteer";
import { pageProbe, detectGenerator, detectHost, pickHostHeaders, detectInterstitial } from "./stack.js";

/**
 * Standalone axe-core accessibility pass.
 *
 * Lighthouse embeds axe, but only runs a subset of its rules and folds the
 * outcome into a weighted score. The leaderboard tiebreaker needs the raw
 * count of violating nodes from a full axe run, which is a different and
 * stricter measurement — a page can score 92 in Lighthouse and still have
 * a dozen violations here.
 *
 * This connects to the Chrome that `chrome-launcher` already started for
 * Lighthouse rather than launching a second browser, so the extra cost is one
 * page load per site.
 *
 * The pass also carries the site's two screenshots, because it is already
 * holding a loaded page: one as the browser renders it, and one with scripts
 * disabled. Capturing them here rather than asking screenshot.11ty.dev for a
 * picture later means the image is of the same page load that produced the
 * numbers beside it, and the published site has no runtime dependency on
 * another service being up.
 */

/**
 * Screenshot encoding. WebP at 80 because these are stored for every site and
 * committed: the same frame as JPEG is roughly a third larger for no visible
 * gain at this size.
 */
const SHOT = { type: "webp", quality: 80 };

/**
 * The devices Lighthouse emulates, mirrored so the pass matches the run.
 *
 * Copied from lighthouse/core/config/constants.js rather than imported: those
 * are internal to a package we drive through its public API, and a silent
 * change there should not silently change what we photograph. Copied values go
 * stale loudly, when a screenshot stops matching a filmstrip frame.
 *
 * Mobile emulation is also what removes the scrollbar. A mobile viewport uses
 * overlay scrollbars, so there is no gutter to hide and no reserved 15px strip
 * down the edge of every picture — the earlier fix for that, an experimental
 * CDP call sent before navigation, is no longer needed.
 */
const DEVICES = {
	mobile: {
		viewport: { width: 412, height: 823, isMobile: true, hasTouch: true },
		userAgent:
			"Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36",
	},
	desktop: {
		viewport: { width: 1350, height: 940, isMobile: false, hasTouch: false },
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
	},
};

/**
 * The pixel ratios a capture can be taken at.
 *
 * `standard` is 1:1. Lighthouse renders this device at 1.75, which is right for
 * measuring an image-heavy page and mostly wrong for storing a picture of one:
 * it triples the bytes of a thumbnail displayed at ~300px, and every byte is
 * committed. Layout is identical at either ratio, so the axe pass sharing the
 * page is unaffected by the choice.
 *
 * `retina` is Lighthouse's own, kept for pages that score a straight 400. Those
 * are the candidates for Perfect Site of the Day, where the screenshot is the
 * card rather than a thumbnail beside it, and there is no second chance to go
 * back for a better one — the picture is taken during the measurement or not
 * at all.
 */
export const SHOT_SCALE = { standard: 1, retina: 1.75 };

/**
 * Put a page on the same device Lighthouse used, before it navigates.
 *
 * Before, because emulation applies at layout: a page told about its device
 * after loading has already laid itself out for whatever it thought it was.
 */
async function emulateDevice(page, formFactor, deviceScaleFactor = SHOT_SCALE.standard) {
	const device = DEVICES[formFactor] ?? DEVICES.mobile;
	await page.setUserAgent(device.userAgent);
	await page.setViewport({ ...device.viewport, deviceScaleFactor });
	return device;
}

/**
 * Take a viewport screenshot of an already-loaded page.
 *
 * Deliberately not `fullPage`. The two captures are meant to be read as a pair,
 * and a full-page shot makes them different shapes — a site that renders
 * nothing without JavaScript would produce a tall picture and a short one, so
 * the comparison would be between two aspect ratios rather than two renders.
 *
 * The viewport is whatever the caller set, and is reported back rather than
 * parsed out of the encoded bytes, so the page can reserve the right box before
 * the image loads.
 */
async function grab(page) {
	const viewport = page.viewport() ?? {};
	const buffer = await page.screenshot({ ...SHOT, fullPage: false });

	return {
		// Puppeteer hands back a Uint8Array; everything downstream writes Buffers.
		buffer: Buffer.from(buffer),
		type: SHOT.type,
		width: viewport.width ?? null,
		height: viewport.height ?? null,
	};
}

/**
 * How much of the page JavaScript is responsible for drawing, 0 to 100.
 *
 * The share of pixels that differ between the two captures. 0 means the two
 * renders are identical and nothing on the page needed a script to appear; 100
 * means no pixel survived, which in practice is a site that renders a blank
 * document without JavaScript.
 *
 * Measured in the browser we already have open rather than by decoding WebP in
 * node, which would mean a native image dependency for one number. A blank page
 * draws both captures to a canvas and walks the two pixel buffers.
 *
 * The per-channel tolerance is the point of the exercise. Both images are lossy
 * WebP of the same viewport, so a large minority of pixels differ by one or two
 * levels through compression alone; counting those would report a few percent
 * of difference for two identical renders. 12 is comfortably above that noise
 * and well below any real change in what is on screen.
 *
 * Returns null rather than throwing: this is a caption, not a measurement
 * anything depends on.
 */
async function visualDifference(browser, a, b) {
	if (!a?.buffer?.length || !b?.buffer?.length) return null;

	let page;
	try {
		page = await browser.newPage();
		await page.goto("about:blank");

		return await page.evaluate(
			async (srcA, srcB, tolerance) => {
				const load = (src) =>
					new Promise((resolve, reject) => {
						const img = new Image();
						img.onload = () => resolve(img);
						img.onerror = () => reject(new Error("decode failed"));
						img.src = src;
					});

				const [imgA, imgB] = await Promise.all([load(srcA), load(srcB)]);

				// Both are captures of the same viewport, so this is a guard rather
				// than a resize: comparing the overlap of two mismatched images is
				// still the right answer, and scaling one would invent pixels.
				const width = Math.min(imgA.naturalWidth, imgB.naturalWidth);
				const height = Math.min(imgA.naturalHeight, imgB.naturalHeight);
				if (!width || !height) return null;

				const read = (img) => {
					const canvas = document.createElement("canvas");
					canvas.width = width;
					canvas.height = height;
					const ctx = canvas.getContext("2d", { willReadFrequently: true });
					ctx.drawImage(img, 0, 0);
					return ctx.getImageData(0, 0, width, height).data;
				};

				const dataA = read(imgA);
				const dataB = read(imgB);

				let changed = 0;
				for (let i = 0; i < dataA.length; i += 4) {
					if (
						Math.abs(dataA[i] - dataB[i]) > tolerance ||
						Math.abs(dataA[i + 1] - dataB[i + 1]) > tolerance ||
						Math.abs(dataA[i + 2] - dataB[i + 2]) > tolerance
					) {
						changed++;
					}
				}

				return Math.round((changed / (width * height)) * 1000) / 10;
			},
			`data:image/${a.type};base64,${a.buffer.toString("base64")}`,
			`data:image/${b.type};base64,${b.buffer.toString("base64")}`,
			12,
		);
	} catch {
		return null;
	} finally {
		if (page) await page.close().catch(() => {});
	}
}

/**
 * How few distinct colors the no-JS capture is made of.
 *
 * The number that says whether a page rendered anything without its scripts.
 * Ink coverage does not: ti.com's no-JS shell is 10.7% "ink" because it paints
 * a gray body panel over a white strip, and nuxt.com — which renders fully
 * without JavaScript — is 13%. Two flat rectangles and a finished page are
 * indistinguishable by area. By color count they are 2 against 627.
 *
 * Channels are quantized to 16 levels before counting so that antialiasing and
 * the webp encoder's own noise do not read as content. What survives is the
 * count of genuinely different colors, which is tiny for a shell of empty boxes
 * and large for anything with text or images on it.
 */
async function colorCount(browser, shot) {
	if (!shot?.buffer?.length) return null;

	let page;
	try {
		page = await browser.newPage();
		await page.goto("about:blank");

		return await page.evaluate(
			async (src) => {
				const img = await new Promise((resolve, reject) => {
					const i = new Image();
					i.onload = () => resolve(i);
					i.onerror = () => reject(new Error("decode failed"));
					i.src = src;
				});

				const canvas = document.createElement("canvas");
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
				if (!canvas.width || !canvas.height) return null;

				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				ctx.drawImage(img, 0, 0);
				const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

				const seen = new Set();
				for (let i = 0; i < data.length; i += 4) {
					seen.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
				}
				return seen.size;
			},
			`data:image/${shot.type};base64,${shot.buffer.toString("base64")}`,
		);
	} catch {
		return null;
	} finally {
		if (page) await page.close().catch(() => {});
	}
}

/**
 * Load the page again with scripts disabled, and photograph that.
 *
 * A second page rather than a second navigation on the first one: the axe run
 * needs the page as the browser really renders it, and
 * `Emulation.setScriptExecutionDisabled` only takes effect on the *next*
 * navigation, so the flag has to be set before the goto rather than after.
 *
 * `load` alone, not the `networkidle0` the axe navigation waits for. With no
 * scripts running there is no second wave of requests to settle, and
 * networkidle0 is what makes a handful of sites sit at the timeout for two
 * minutes.
 *
 * Never throws. A missing no-JS picture is worth less than the measurement it
 * would take down with it.
 */
async function captureWithoutJavaScript(browser, url, formFactor, timeoutMs, scale) {
	let page;

	try {
		page = await browser.newPage();
		// Same ratio as its pair, or visualDifference would compare two sizes.
		await emulateDevice(page, formFactor, scale);
		await page.setJavaScriptEnabled(false);
		await page.goto(url, { waitUntil: "load", timeout: timeoutMs });

		return await grab(page);
	} catch {
		return null;
	} finally {
		if (page) await page.close().catch(() => {});
	}
}

/**
 * Count violating (or passing) *nodes*, not rules.
 *
 * One rule broken across eight elements is eight violations. Counting rules
 * instead would rank a page with one widespread failure above a page with two
 * isolated ones. Rules that report no nodes still count once.
 */
export function countNodes(entries) {
	let count = 0;
	for (let entry of entries || []) {
		count += entry.nodes?.length ? entry.nodes.length : 1;
	}
	return count;
}

/**
 * Run axe against a URL using an already-running Chrome.
 *
 * Never throws: accessibility results are a tiebreaker, and losing a whole
 * measurement because axe timed out on one heavy page would be a bad trade.
 * A failure comes back as `{ error }` with null counts.
 */
export async function runAxe(
	url,
	{
		port,
		timeoutMs = 60000,
		screenshots = false,
		noJsScreenshot = false,
		formFactor = "mobile",
		scale = SHOT_SCALE.standard,
	} = {},
) {
	let browser;
	let page;

	try {
		// `connect`, not `launch` — and `disconnect` below, not `close`, because
		// this Chrome belongs to the Lighthouse runner and must outlive us.
		browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
		page = await browser.newPage();

		// The same device Lighthouse measured on, so the picture and the numbers
		// describe one page rather than two renderings of it.
		await emulateDevice(page, formFactor, scale);

		// Sites with a strict CSP would otherwise block the injected axe bundle.
		await page.setBypassCSP(true);

		/*
		 * The main document's headers, captured as they arrive rather than taken
		 * from the return of `goto`.
		 *
		 * `goto` hands back the response only if it resolves, and the wait below
		 * is `networkidle0` — 500ms of silence, which a page that polls or beacons
		 * never reaches. Those pages time out having rendered perfectly well, and
		 * the headers were on the wire long before. Listening keeps them.
		 */
		let mainResponse = null;
		page.on("response", (res) => {
			if (!mainResponse && res.frame() === page.mainFrame() && res.request().resourceType() === "document") {
				mainResponse = res;
			}
		});

		/*
		 * A navigation timeout is not a failed page.
		 *
		 * `networkidle0` is the right wait for axe — it wants the DOM the user
		 * ends up with, not the one at `load` — but it is a condition some sites
		 * never satisfy, and waiting for it is the difference between a heavy
		 * page and a broken one. duda.co renders fine and never goes quiet.
		 *
		 * So: give up on the wait, keep the page. Everything below works on
		 * whatever has rendered by now, which is what a reader would have seen at
		 * that moment anyway. Any other navigation error — DNS, refused, a
		 * certificate — is a real failure and still throws.
		 */
		let navigationTimedOut = false;
		try {
			await page.goto(url, { waitUntil: ["load", "networkidle0"], timeout: timeoutMs });
		} catch (err) {
			if (err?.name !== "TimeoutError") throw err;
			navigationTimedOut = true;
		}

		// Stack detection rides along on this page load rather than costing a
		// second request — see lib/stack.js.
		const headers = pickHostHeaders(mainResponse?.headers() || {});
		const probe = await page.evaluate(pageProbe).catch(() => ({ meta: null, marks: [] }));

		/*
		 * Both captures happen before axe runs and at the viewport axe uses.
		 *
		 * Before, because axe injects its own bundle into the page and the
		 * picture should be of the site rather than of the site plus a test
		 * harness. At the same viewport, because resizing to something more
		 * photogenic would re-run every responsive breakpoint the accessibility
		 * numbers are measured at — and those numbers feed the ranking.
		 */
		/*
		 * The two captures are costed separately because they buy different
		 * things. The first replaces a runtime call to the screenshot service, so
		 * every site needs one or that dependency survives on 95% of the corpus.
		 * The second only feeds the "Without JavaScript" section and doubles what
		 * is committed, so it follows the filmstrip's opt-out.
		 */
		let shots = null;
		if (screenshots) {
			const js = await grab(page).catch(() => null);
			const noJs = noJsScreenshot
				? await captureWithoutJavaScript(browser, url, formFactor, timeoutMs, scale)
				: null;
			// How much of what you see needed a script to get there, and how much
			// the page amounts to without them.
			shots = {
				js,
				noJs,
				difference: noJs ? await visualDifference(browser, js, noJs) : null,
				noJsColors: noJs ? await colorCount(browser, noJs) : null,
			};
		}

		const results = await new AxePuppeteer(page).analyze();

		return {
			shots,
			// The page never went quiet, so everything here describes it as it
			// stood at the timeout rather than at rest.
			navigationTimedOut,
			generator: detectGenerator(probe, headers),
			// Set when the page we measured was a bot check rather than the site.
			// Null is the ordinary case.
			interstitial: detectInterstitial(probe),
			host: detectHost(headers),
			headers,
			violations: countNodes(results.violations),
			passes: countNodes(results.passes),
			incomplete: countNodes(results.incomplete),
			// Distinct rules broken, alongside the node count the ranking uses.
			violationRules: results.violations?.length ?? 0,
			version: results.testEngine?.version ?? null,
			// Enough detail to act on, without storing every node.
			top: (results.violations || [])
				.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes?.length ?? 0, help: v.help }))
				.sort((a, b) => b.nodes - a.nodes)
				.slice(0, 10),
			error: null,
		};
	} catch (err) {
		return {
			shots: null,
			navigationTimedOut: false,
			generator: null,
			host: null,
			headers: {},
			violations: null,
			passes: null,
			incomplete: null,
			violationRules: null,
			version: null,
			top: [],
			error: err.message,
		};
	} finally {
		if (page) await page.close().catch(() => {});
		// Detach without killing the browser Lighthouse is still using.
		if (browser) browser.disconnect();
	}
}
