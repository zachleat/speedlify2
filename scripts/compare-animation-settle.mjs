/*
 * Does fast-forwarding animations change the client-rendering verdict?
 *
 * Captures each URL's pair twice — once as the pass used to, once with
 * `fastForwardAnimations` — and prints both readings side by side. Throwaway:
 * delete it once the answer is known.
 *
 *   node ./scripts/compare-animation-settle.mjs [url...]
 *   node ./scripts/compare-animation-settle.mjs --flagged
 *   node ./scripts/compare-animation-settle.mjs --near
 *
 * With no arguments it runs the four Eleventy sites the old heuristic flagged.
 * `--flagged` runs every site currently flagged in `results/`, `--near` the ones
 * close enough to the line to move across it.
 */
import fs from "node:fs";
import path from "node:path";
import * as chromeLauncher from "chrome-launcher";
import puppeteer from "puppeteer-core";
import { SHOT_SCALE, textRows, visualDifference, fastForwardAnimations } from "../lib/axe.js";
import { clientRendered } from "../lib/report.js";

function flaggedSites(resultsDir = "results") {
	const sites = [];
	for (let hash of fs.readdirSync(resultsDir)) {
		const dir = path.join(resultsDir, hash);
		let shot;
		try {
			shot = JSON.parse(fs.readFileSync(path.join(dir, "screenshot.json"), "utf8"));
		} catch {
			continue;
		}
		if (clientRendered(shot) !== true) continue;

		try {
			const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
			// The stored reading, to sit beside the two this run takes.
			sites.push({ url: meta.url, name: meta.name, stored: shot });
		} catch {
			continue;
		}
	}
	return sites;
}

/*
 * Sites close enough to the line that settling could carry them over it.
 *
 * Settling normally moves a site away from the flag — text goes up as content
 * finishes arriving, difference goes down as the two captures converge. The
 * exception is a page already reading as silent whose difference is only held
 * under the floor by where the shutter fell, so that band is what this returns.
 */
function nearSites(resultsDir = "results") {
	const sites = [];
	for (let hash of fs.readdirSync(resultsDir)) {
		const dir = path.join(resultsDir, hash);
		let shot;
		try {
			shot = JSON.parse(fs.readFileSync(path.join(dir, "screenshot.json"), "utf8"));
		} catch {
			continue;
		}
		if (clientRendered(shot) !== false) continue;
		if (!(shot.noJsText <= 3 && shot.difference < 20)) continue;

		try {
			const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
			sites.push({ url: meta.url, name: meta.name, stored: shot });
		} catch {
			continue;
		}
	}
	return sites;
}

const DEFAULT_URLS = [
	"https://stebre.ch/en",
	"https://optifolio.vercel.app/",
	"https://craigerskine.github.io/11ty-twind",
	"https://cover.000000076.xyz/",
];

const VIEWPORT = { width: 412, height: 823, isMobile: true, hasTouch: true };
const USER_AGENT =
	"Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36";

async function shoot(browser, url, { js, settle }) {
	const page = await browser.newPage();
	try {
		await page.setUserAgent(USER_AGENT);
		await page.setViewport({ ...VIEWPORT, deviceScaleFactor: SHOT_SCALE.standard });
		await page.setJavaScriptEnabled(js);
		await page.goto(url, { waitUntil: js ? ["load", "networkidle0"] : "load", timeout: 60000 });
		if (settle) await fastForwardAnimations(page);

		const words = await page
			.evaluate(() => {
				const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
				return text ? text.split(" ").length : 0;
			})
			.catch(() => null);

		const buffer = Buffer.from(await page.screenshot({ type: "webp", quality: 80, fullPage: false }));
		return { buffer, type: "webp", words };
	} catch (err) {
		return { error: err.message };
	} finally {
		await page.close().catch(() => {});
	}
}

async function arm(browser, url, settle) {
	const js = await shoot(browser, url, { js: true, settle });
	const noJs = await shoot(browser, url, { js: false, settle });
	if (js.error || noJs.error) return { error: js.error || noJs.error };

	const difference = await visualDifference(browser, js, noJs);
	const noJsText = await textRows(browser, noJs);
	return {
		difference,
		noJsText,
		words: noJs.words,
		flagged: clientRendered({ noJs: true, difference, noJsText }),
	};
}

const args = process.argv.slice(2);
const sites = args.includes("--flagged")
	? flaggedSites()
	: args.includes("--near")
		? nearSites()
		: (args.length ? args : DEFAULT_URLS).map((url) => ({ url, name: url }));

const chrome = await chromeLauncher.launch({
	chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });

const rows = [];
for (let site of sites) {
	const before = await arm(browser, site.url, false);
	const after = await arm(browser, site.url, true);
	rows.push({
		name: site.name,
		// Null on a run driven by bare URLs, where there is nothing stored to
		// compare against. A reading that differs from the stored one is a site
		// whose verdict was a coin flip before anything was changed.
		"text stored": site.stored?.noJsText ?? null,
		"text before": before.noJsText,
		"text after": after.noJsText,
		"diff stored": site.stored?.difference ?? null,
		"diff before": before.difference,
		"diff after": after.difference,
		"no-JS words": after.words,
		before: before.flagged,
		after: after.flagged,
	});
	console.log(site.name, "→", before.flagged, "→", after.flagged, before.error || after.error || "");
}

console.table(rows);

const cleared = rows.filter((r) => r.before === true && r.after === false).length;
const flaky = rows.filter((r) => r["text stored"] !== null && r.before === false).length;
console.log(`\n${rows.length} sites: ${cleared} cleared by settling, ${flaky} did not reproduce, ${rows.filter((r) => r.after).length} still flagged`);
await browser.disconnect();
await chrome.kill();
