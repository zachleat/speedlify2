import lighthouse, { desktopConfig } from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { extractMetrics, extractScreenshots, medianRun } from "./metrics.js";
import { fetchFieldData } from "./crux.js";
import { runAxe, SHOT_SCALE } from "./axe.js";
import { SCORES } from "./report-metrics.js";
import { normalizeUrl } from "./hash.js";

const CHROME_FLAGS = [
	"--headless=new",
	"--no-sandbox",
	"--disable-gpu",
	"--disable-dev-shm-usage",
	// Keep runs comparable: no extensions, no background sync, no first-run UI.
	"--disable-extensions",
	"--disable-background-networking",
	"--no-first-run",
	"--no-default-browser-check",
];

/**
 * Every Lighthouse category at 100.
 *
 * Derived from the reported categories rather than compared against 400, so a
 * category appearing or disappearing upstream cannot leave this quietly testing
 * a bar nothing can reach — the same reasoning as PERFECT_TOTAL in report.js.
 */
/**
 * Does this measurement keep its pictures?
 *
 * A category turns them off to stop a thousand sites costing storage nobody
 * looks at. Full marks overrides that: a site that just scored 400 is the one
 * everybody looks at — it can be the perfect site of the day, and that card is
 * mostly a photograph. Self-limiting, since it only fires for sites that
 * reached a bar most never will.
 *
 * Exported and shared by both captures rather than written out at each of them:
 * the filmstrip and the no-JS pair have to agree, or a site page would offer a
 * Without JavaScript section on a run whose frames were thrown away.
 */
export function keepsScreenshots(site, median) {
	return (site?.screenshots ?? "filmstrip") !== "none" || isPerfectLighthouse(median);
}

function isPerfectLighthouse(run) {
	const scores = run?.scores;
	if (!scores) return false;

	const values = SCORES.map((s) => s.key).map((key) => scores[key]);
	return values.every((v) => v === 100);
}

/**
 * Owns a single headless Chrome for the whole measurement pass.
 *
 * Reusing one browser across sites is much faster than relaunching per URL, but
 * we hand every Lighthouse run a fresh context so state never leaks between
 * sites. If Chrome dies mid-pass we relaunch rather than failing everything
 * after it.
 */
export class Runner {
	constructor({ logger, runs = 3, formFactor = "mobile", cruxApiKey = null, axeEnabled = true, timeoutMs = 120_000 }) {
		this.logger = logger;
		this.runs = runs;
		this.formFactor = formFactor;
		this.cruxApiKey = cruxApiKey;
		this.axeEnabled = axeEnabled;
		this.timeoutMs = timeoutMs;
		this.chrome = null;

		// Politeness state: when the last measurement finished, and when each host
		// was last touched.
		this.lastFinishedAt = null;
		this.lastHostAt = new Map();
	}

	async launch() {
		if (this.chrome) return this.chrome;
		this.chrome = await chromeLauncher.launch({ chromeFlags: CHROME_FLAGS });
		this.logger.debug("chrome launched", { port: this.chrome.port });
		return this.chrome;
	}

	async close() {
		if (!this.chrome) return;
		try {
			await this.chrome.kill();
		} catch {
			// Already gone; nothing to clean up.
		}
		this.chrome = null;
	}

	/** Chrome occasionally dies under CI memory pressure. Bring it back. */
	async #ensureChrome() {
		if (this.chrome) {
			try {
				process.kill(this.chrome.pid, 0);
				return this.chrome;
			} catch {
				this.logger.warn("chrome process gone, relaunching");
				this.chrome = null;
			}
		}
		return this.launch();
	}

	async #runOnce(url) {
		const chrome = await this.#ensureChrome();

		const options = {
			port: chrome.port,
			output: "json",
			logLevel: "silent",
			// A fresh context per run: no shared cache, cookies, or storage.
			disableStorageReset: false,
		};

		const config = this.formFactor === "desktop" ? desktopConfig : undefined;

		const result = await withTimeout(
			lighthouse(url, options, config),
			this.timeoutMs,
			`lighthouse timed out after ${this.timeoutMs}ms`
		);

		if (!result?.lhr) throw new Error("lighthouse returned no result");
		if (result.lhr.runtimeError) {
			throw new Error(`${result.lhr.runtimeError.code}: ${result.lhr.runtimeError.message}`);
		}

		// Kept beside the metrics rather than inside them: `metrics` is written to
		// disk as JSON for every measurement forever, and a megabyte of base64 in
		// each record would be a different project.
		return {
			metrics: extractMetrics(result.lhr),
			screenshots: extractScreenshots(result.lhr),
		};
	}

	/**
	 * Wait before touching a site, if politeness requires it.
	 *
	 * Measurement is already one-at-a-time — a single Chrome, a single
	 * Lighthouse run at a time — so nothing is ever requested concurrently.
	 * These delays are the separate question of *pace*: measuring thousands of
	 * personal sites back-to-back is a lot of traffic aimed at people's blogs,
	 * most of them on modest hosting.
	 *
	 * Two independent limits:
	 *  - `delayMs`   — a pause between consecutive sites.
	 *  - `hostCooldownMs` — a minimum gap between two requests to the *same*
	 *    host, for the case where several entries share a domain.
	 */
	async #throttle(site) {
		const host = hostOf(site.url);
		const wait = throttleWait({
			rateLimit: site.rateLimit,
			host,
			now: Date.now(),
			lastFinishedAt: this.lastFinishedAt,
			lastHostAt: this.lastHostAt,
		});

		if (wait > 0) {
			this.logger.debug(`waiting ${wait}ms before ${site.url}`, { host, wait });
			await new Promise((resolve) => setTimeout(resolve, wait));
		}

		if (host && site.rateLimit?.hostCooldownMs) this.lastHostAt.set(host, Date.now());
	}

	/**
	 * Measure one site: N Lighthouse runs (median kept), a full axe pass, and
	 * CrUX field data.
	 *
	 * Always resolves to a record. A failure is stored as a record with `error`
	 * set rather than thrown away, because "this site was down on Tuesday" is
	 * itself data you want on the chart.
	 */
	async measure(site) {
		await this.#throttle(site);

		const url = normalizeUrl(site.url);
		const startedAt = Date.now();
		const timestamp = Date.now();

		const base = {
			url,
			name: site.name,
			group: site.group,
			groupName: site.groupName,
			timestamp,
			date: new Date(timestamp).toISOString(),
			runId: this.logger.runId,
			formFactor: this.formFactor,
			requestedRuns: this.runs,
		};

		const attempts = [];
		// Frames per attempt, index-aligned with `attempts`, so the filmstrip that
		// gets kept is the one belonging to the run the numbers came from. Taking
		// the last run's would pair a screenshot with someone else's timings.
		const shots = [];
		// Only kept for sites the screenshot service cannot reach; see below.
		const failures = [];

		for (let i = 0; i < this.runs; i++) {
			try {
				const { metrics, screenshots } = await this.#runOnce(url);
				attempts.push(metrics);
				shots.push(screenshots);
				this.logger.debug(`run ${i + 1}/${this.runs} ok`, {
					url,
					performance: metrics.scores?.performance,
					lcp: metrics.timings?.lcp,
				});
			} catch (err) {
				failures.push(err.message);
				this.logger.warn(`run ${i + 1}/${this.runs} failed`, { url, error: err.message });
			}
		}

		// Field data is independent of the lab runs — fetch it even if they all
		// failed, since CrUX may still have data for a site that won't load here.
		const field = await this.#field(url);

		// One axe pass per measurement, not per run: it is a static analysis of
		// the rendered DOM, so repeating it would cost a page load for the same
		// answer. Skipped only if every Lighthouse run failed, since the page
		// almost certainly won't load for axe either.
		// Before the axe pass rather than after, because the pass now needs to
		// know how this site scored: a straight 400 is photographed at Lighthouse's
		// own pixel ratio. There is no going back for a better picture later.
		const median = attempts.length ? medianRun(attempts) : null;

		const { axe, shots: pageShots } = attempts.length
			? await this.#axe(url, site, median)
			: { axe: null, shots: null };

		this.lastFinishedAt = Date.now();

		if (!attempts.length) {
			this.logger.error("all runs failed", { url, errors: failures });
			return {
				...base,
				completedRuns: 0,
				durationMs: Date.now() - startedAt,
				error: failures[failures.length - 1] || "unknown error",
				errors: failures,
				field,
				axe,
			};
		}

		return {
			...base,
			// Stripped off by ResultStore.write, which puts the frames on disk as
			// JPEGs. Never serialized into the measurement record.
			screenshots: this.#filmstrip(site, shots[attempts.indexOf(median)], median),
			// The page as rendered and the page with scripts off, from the axe
			// pass. Stripped off by ResultStore.write the same way — see there.
			pageShots,
			completedRuns: attempts.length,
			durationMs: Date.now() - startedAt,
			error: null,
			...(failures.length ? { partialErrors: failures } : {}),
			// Spread of the performance score across runs. A wide spread means the
			// number is noisy and a small week-over-week "regression" is meaningless.
			variance: variance(attempts.map((a) => a.scores?.performance)),
			lab: median,
			field,
			axe,
		};
	}

	/**
	 * The run's frames, unless this site's category asked for none — and it did
	 * not just score full marks, which overrides that.
	 *
	 * Same exception as the no-JS capture in `#axe`, and cheaper here: Lighthouse
	 * has already taken these frames either way, so this only decides whether to
	 * keep them.
	 */
	#filmstrip(site, frames, median) {
		if (!frames?.length || !keepsScreenshots(site, median)) return null;
		return frames;
	}

	/**
	 * Accessibility violations from a full axe run, and the site's screenshots.
	 *
	 * The two come back together because they share a page load. The buffers are
	 * split off here rather than in `runAxe`, so that what this returns as `axe`
	 * is exactly what gets serialized into the measurement record — a Buffer
	 * left on that object would be written to disk as a JSON array of bytes.
	 *
	 * Never fatal.
	 */
	async #axe(url, site, median) {
		if (!this.axeEnabled) return { axe: null, shots: null };

		const chrome = await this.#ensureChrome();
		const result = await runAxe(url, {
			port: chrome.port,
			timeoutMs: this.timeoutMs,
			// Full marks in every Lighthouse category. Not the whole definition of
			// perfect — axe and Core Web Vitals also count, and neither is known
			// yet: axe runs inside this very call, and field data is not lab data.
			// Lighthouse alone is what is available at the moment the shutter has
			// to open, and it is a superset of the sites that end up qualifying.
			scale: isPerfectLighthouse(median) ? SHOT_SCALE.retina : SHOT_SCALE.standard,
			// Same device Lighthouse just measured on. Without this the pass ran
			// at Puppeteer's 800x600 desktop default while the scores beside it
			// came from a 412px phone.
			formFactor: this.formFactor,
			// Always. This is the site page's header image, and the whole point of
			// taking it ourselves is that no site is left calling out to the
			// screenshot service at render time.
			screenshots: true,
			// The second capture, and the section it feeds, follow the filmstrip's
			// opt-out: it doubles what is stored for 1,500 sites that asked for no
			// pictures.
			// Except at full marks — see `keepsScreenshots`.
			noJsScreenshot: keepsScreenshots(site, median),
		});

		if (result.error) {
			this.logger.warn("axe failed", { url, error: result.error });
		} else if (result.navigationTimedOut) {
			// Worth saying out loud: the numbers and the picture are of the page
			// as it stood at the timeout, not at rest.
			this.logger.warn("page never went idle, measured as-is", { url, violations: result.violations });
		} else {
			this.logger.debug("axe ok", { url, violations: result.violations, rules: result.violationRules });
		}

		const { shots, ...axe } = result;
		if (shots && !shots.noJs) this.logger.debug("no-js screenshot failed", { url });

		return { axe, shots };
	}

	async #field(url) {
		if (!this.cruxApiKey) return null;

		try {
			const data = await fetchFieldData(url, {
				apiKey: this.cruxApiKey,
				formFactor: this.formFactor === "desktop" ? "DESKTOP" : "PHONE",
			});

			if (!data) {
				this.logger.debug("no crux field data", { url });
				return null;
			}

			this.logger.debug("crux ok", { url, scope: data.scope, lcp: data.metrics?.lcp?.p75 });
			return data;
		} catch (err) {
			// Never let a field-data hiccup lose a good lab measurement.
			this.logger.warn("crux fetch failed", { url, error: err.message });
			return null;
		}
	}
}

function variance(values) {
	const nums = values.filter((v) => typeof v === "number");
	if (nums.length < 2) return null;
	return {
		min: Math.min(...nums),
		max: Math.max(...nums),
		spread: Math.max(...nums) - Math.min(...nums),
		runs: nums.length,
	};
}

function withTimeout(promise, ms, message) {
	let timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		}),
	]);
}

export function hostOf(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

/**
 * How long to wait before requesting a site, in milliseconds.
 *
 * Pure so the pacing rules can be tested without launching a browser or
 * actually sleeping. The two limits are independent and the longer one wins:
 * a site can be due under the global delay while still inside its own host's
 * cooldown.
 */
export function throttleWait({ rateLimit, host, now, lastFinishedAt, lastHostAt }) {
	if (!rateLimit) return 0;

	const waits = [0];

	// Gap since the previous measurement of any site.
	if (rateLimit.delayMs && lastFinishedAt) {
		waits.push(rateLimit.delayMs - (now - lastFinishedAt));
	}

	// Gap since this particular host was last touched.
	if (rateLimit.hostCooldownMs && host) {
		const last = lastHostAt?.get(host);
		if (last) waits.push(rateLimit.hostCooldownMs - (now - last));
	}

	return Math.max(...waits);
}
