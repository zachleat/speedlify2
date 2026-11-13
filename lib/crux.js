/**
 * Chrome UX Report (CrUX) — real-user Core Web Vitals from Google.
 *
 * Why this exists alongside Lighthouse: lab data is a simulation on one machine
 * with synthetic throttling. Field data is what actually happened to real
 * Chrome users over a 28-day window. They diverge, and the divergence is
 * frequently the most interesting thing on the chart — lab flat while field
 * degrades usually means a population you don't test on (slow devices, bad
 * networks, a region you added).
 *
 * It is also the ONLY way to get INP. Lighthouse cannot measure interaction
 * latency in a lab run; `inp-breakdown-insight` is null on a cold navigation.
 *
 * Requires a Google API key with the Chrome UX Report API enabled:
 *   https://developers.google.com/chrome/ux-report/
 * Set it as CRUX_API_KEY.
 *
 * Caveats worth remembering when reading the charts:
 *  - Only origins/URLs with enough Chrome traffic are included. Small sites
 *    return 404 (NOT_FOUND) — that's normal, not a failure.
 *  - The window is a trailing 28 days, so it moves slowly and lags a deploy.
 *  - URL-level data is sparser than origin-level. The two are reported side by
 *    side and never mixed: a verdict is only ever made from a URL's own data.
 */

const ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
const HISTORY_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord";

/** The metrics we request. Others exist but these are the ones worth charting. */
export const CRUX_METRICS = [
	"largest_contentful_paint",
	"cumulative_layout_shift",
	"interaction_to_next_paint",
	"first_contentful_paint",
	"experimental_time_to_first_byte",
	"round_trip_time",
];

/** Google's official good/needs-improvement/poor boundaries. */
export const CWV_THRESHOLDS = {
	lcp: { good: 2500, poor: 4000, unit: "ms" },
	cls: { good: 0.1, poor: 0.25, unit: "" },
	inp: { good: 200, poor: 500, unit: "ms" },
	fcp: { good: 1800, poor: 3000, unit: "ms" },
	ttfb: { good: 800, poor: 1800, unit: "ms" },
};

const SHORT_NAME = {
	largest_contentful_paint: "lcp",
	cumulative_layout_shift: "cls",
	interaction_to_next_paint: "inp",
	first_contentful_paint: "fcp",
	experimental_time_to_first_byte: "ttfb",
	round_trip_time: "rtt",
};

export function rate(metric, value) {
	const t = CWV_THRESHOLDS[metric];
	if (!t || value === null || value === undefined) return null;
	if (value <= t.good) return "good";
	if (value <= t.poor) return "needs-improvement";
	return "poor";
}

/**
 * CrUX returns CLS percentiles as a STRING ("0.05") while timing metrics come
 * back as numbers. Coercing blindly is how you end up with NaN in a chart.
 */
function toNumber(v) {
	if (v === null || v === undefined) return null;
	const n = typeof v === "string" ? Number.parseFloat(v) : v;
	return Number.isFinite(n) ? n : null;
}

function collectionDate(d) {
	if (!d) return null;
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/**
 * Histogram densities → the good/needs-improvement/poor split, as percentages.
 * This is richer than p75 alone: p75 can hold steady while the poor bucket
 * doubles, which is a real regression for a real slice of your users.
 */
function buckets(histogram) {
	if (!Array.isArray(histogram) || histogram.length < 3) return null;
	const pct = (i) => {
		const d = toNumber(histogram[i]?.density);
		return d === null ? null : Math.round(d * 1000) / 10;
	};
	return { good: pct(0), needsImprovement: pct(1), poor: pct(2) };
}

/**
 * CrUX allows 150 queries per minute, per Google Cloud *project* — so anything
 * else using the same key shares it.
 *
 * A plain `for … await` loop is not slow enough on its own: the API answers in
 * a couple of hundred milliseconds, so an unpaced loop issues three to five
 * hundred requests a minute and starts failing about thirty seconds in, then
 * keeps failing for the rest of the run.
 *
 * 420ms between requests is ~143/minute, just under the limit with enough
 * margin to absorb a fast response.
 */
const MIN_REQUEST_GAP_MS = 420;

/** Retries after a 429, doubling each time. Past this the quota is not the problem. */
const RATE_LIMIT_RETRIES = 3;

let lastRequestAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Space requests out, measured from when the last one was actually issued. */
async function pace() {
	const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
	if (wait > 0) await sleep(wait);
	lastRequestAt = Date.now();
}

async function postJson(endpoint, apiKey, body) {
	for (let attempt = 0; ; attempt++) {
		await pace();

		const res = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
			body: JSON.stringify(body),
		});

		const json = await res.json().catch(() => null);

		if (res.ok) return json;

		// Being throttled is not a fact about the site — it is a fact about how
		// fast we asked. Backing off and asking again is the whole fix; giving up
		// would leave the site with no field data until the next backfill.
		if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
			// Honor Retry-After when the API sends one, since it knows better.
			const retryAfter = Number.parseInt(res.headers?.get?.("retry-after") ?? "", 10);
			const backoff = Number.isFinite(retryAfter)
				? retryAfter * 1000
				: MIN_REQUEST_GAP_MS * 4 * 2 ** attempt;
			await sleep(backoff);
			continue;
		}

		const err = new Error(json?.error?.message || `CrUX HTTP ${res.status}`);
		err.status = res.status;
		// 404 means "not enough traffic to report", which is an expected outcome
		// for smaller sites rather than something to retry or shout about.
		err.notFound = res.status === 404;
		err.rateLimited = res.status === 429;
		throw err;
	}
}

/**
 * The three Core Web Vitals, in the order they are reported everywhere else.
 */
const CWV_KEYS = ["lcp", "inp", "cls"];

/**
 * The metrics a page may show its origin's value for when CrUX has none of its
 * own — labeled as the origin's, and never counted toward a verdict.
 *
 * The test is whether the page determines the number. LCP and CLS are the page:
 * its hero image, its fonts, its layout, and the lab column measures both
 * anyway, so a page with no field LCP still has an LCP on screen. These four
 * are mostly not the page. RTT is the users' network latency and the server's
 * location. TTFB is the server and the CDN. FCP is both of those plus whatever
 * blocks the first paint, which is usually site-wide. INP is the page's own
 * JavaScript in principle, but in practice one bundle serves every route — and
 * it is the only metric no lab run can ever produce, so a missing INP is
 * missing everywhere rather than merely missing from one column.
 *
 * Why this is safe for three of the four: RTT, TTFB and FCP are not Core Web
 * Vitals, so nothing they say can move a pass, a fail or a rank. INP can, which
 * is why the borrowed value is shown but kept out of the assessment — see
 * coreWebVitals in lib/report.js.
 */
export const BORROWABLE_FROM_ORIGIN = ["inp", "ttfb", "fcp", "rtt"];

/** Everything the origin is worth a second request for: borrowable, or a vital we would show it beside. */
const ORIGIN_WORTH_ASKING = [...new Set([...CWV_KEYS, ...BORROWABLE_FROM_ORIGIN])];

/** Whether the origin could add anything to what the page reported. */
function originCouldHelp(metrics) {
	return ORIGIN_WORTH_ASKING.some((key) => metrics?.[key]?.p75 == null);
}

/**
 * Which URL to ask CrUX about, and what to call the answer.
 *
 * CrUX keys a URL-level record on the address the browser actually navigated
 * to. A front door that redirects — `https://www.amd.com/` to
 * `/en.html` — therefore has no record of its own: every visit is filed under
 * the landing path, and asking for the bare origin path returns NOT_FOUND
 * however much traffic the site has. Nine of the big-brand homepages in this
 * corpus are in exactly that position, and were falling back to origin-level
 * data for a reason that has nothing to do with their traffic.
 *
 * So when the measurement followed a landing redirect, the landing URL is the
 * page we loaded and the page CrUX knows, and it is what gets asked about. The
 * answer is scoped `landing` rather than `url` — the numbers are a real
 * page-level measurement of the page we measured, but of a URL the site is not
 * keyed on, and the pages say which URL they came from.
 *
 * `isLandingRedirect` in lib/redirect.js decides what counts, and the site's
 * own identity is untouched: this changes the question, not the subject.
 */
function pageTarget(url, landingUrl) {
	if (typeof landingUrl === "string" && landingUrl && landingUrl !== url) {
		return { url: landingUrl, scope: "landing" };
	}
	return { url, scope: "url" };
}

/**
 * Current 28-day field data for a URL.
 *
 * Tries URL-level first. When the URL is in CrUX but short of a metric, the
 * origin's record is fetched and attached as `origin` — alongside, never merged
 * in. When the URL is not in CrUX at all, the origin record is returned on its
 * own, marked `scope: "origin"`, which is the caller's signal that there is no
 * page-level data here.
 *
 * The two are kept apart because they answer different questions: the origin
 * pools every page on the site, so its p75 is not this page's p75 and a verdict
 * built from the mixture belongs to neither.
 */
export async function fetchFieldData(url, { apiKey, formFactor = "PHONE", scope = "auto", landingUrl = null } = {}) {
	if (!apiKey) throw new Error("CrUX requires an API key (set CRUX_API_KEY)");

	const page = pageTarget(url, landingUrl);

	const attempts = [];
	if (scope === "auto" || scope === "url") attempts.push({ url: page.url, scope: page.scope });
	if (scope === "auto" || scope === "origin") attempts.push({ origin: new URL(url).origin, scope: "origin" });

	let lastError = null;

	for (let attempt of attempts) {
		const { scope: attemptScope, ...key } = attempt;
		const body = { ...key, metrics: CRUX_METRICS };
		// Omitting formFactor aggregates all devices; "ALL" is not a valid value.
		if (formFactor && formFactor !== "ALL") body.formFactor = formFactor;

		try {
			const json = await postJson(ENDPOINT, apiKey, body);
			const record = normalizeRecord(json, attemptScope, formFactor, attemptScope === "landing" ? page.url : null);

			// A page-scoped answer with gaps in it is the case the origin can speak
			// to, so it is fetched and attached beside the page's own numbers. An
			// origin-scoped answer is already the broadest dataset there is.
			if (record && attemptScope !== "origin" && scope === "auto" && originCouldHelp(record.metrics)) {
				return await attachOrigin(record, url, { apiKey, formFactor });
			}

			return record;
		} catch (err) {
			lastError = err;
			if (err.notFound) continue; // try the next, broader scope
			throw err;
		}
	}

	if (lastError?.notFound) return null; // genuinely no field data for this site
	throw lastError;
}

/**
 * Second request, for the origin, attached to a page-scoped record.
 *
 * Attached rather than merged: the page's own metrics stay exactly as CrUX
 * reported them, and the origin sits beside them as separate context for the
 * metrics the page is short of. Nothing downstream has to unpick a mixture.
 *
 * Never fatal. The page's numbers are the answer being returned, and context
 * that fails to arrive leaves that answer exactly as good as it was.
 */
async function attachOrigin(record, url, { apiKey, formFactor }) {
	let origin;
	try {
		const body = { origin: new URL(url).origin, metrics: CRUX_METRICS };
		if (formFactor && formFactor !== "ALL") body.formFactor = formFactor;
		origin = normalizeRecord(await postJson(ENDPOINT, apiKey, body), "origin", formFactor);
	} catch {
		return record;
	}

	if (!origin) return record;

	// Which of the page's gaps the origin can say something about, so a reader is
	// not left comparing the two tables by eye.
	const covers = ORIGIN_WORTH_ASKING.filter(
		(k) => record.metrics[k]?.p75 == null && origin.metrics[k]?.p75 != null
	);

	return { ...record, origin, originCovers: covers };
}

function normalizeRecord(json, scope, formFactor, url = null) {
	const record = json?.record;
	if (!record) return null;

	const metrics = {};
	for (let [name, data] of Object.entries(record.metrics || {})) {
		const short = SHORT_NAME[name];
		if (!short) continue;

		const p75 = toNumber(data?.percentiles?.p75);
		metrics[short] = {
			p75,
			rating: rate(short, p75),
			distribution: buckets(data?.histogram),
		};
	}

	// Overall pass = all three Core Web Vitals in the "good" band at p75.
	// Note the explicit null check rather than `every(...) || null`: that idiom
	// silently turns a real "fails CWV" (false) into "no data" (null), which is
	// exactly backwards for the site you most want to notice.
	const cwvRatings = ["lcp", "cls", "inp"].map((k) => metrics[k]?.rating).filter(Boolean);
	const cwvPass = cwvRatings.length ? cwvRatings.every((r) => r === "good") : null;

	return {
		source: "crux",
		scope,
		// Set only on a landing-scoped record: the URL CrUX was actually asked
		// about, so the page can name it rather than implying the site's own.
		...(url ? { url } : {}),
		formFactor,
		collectionPeriod: {
			first: collectionDate(record.collectionPeriod?.firstDate),
			last: collectionDate(record.collectionPeriod?.lastDate),
		},
		metrics,
		cwvPass,
		// How many of the three were actually reported — a "pass" on two of three
		// is not the same claim as a pass on all three.
		cwvAssessed: cwvRatings.length,
	};
}

/**
 * Weekly p75 history — roughly 25 weeks in a single request.
 *
 * This is the fastest way to make a brand-new install useful: instead of
 * waiting months to accumulate a trend, you get six months of real-user
 * history immediately.
 */
export async function fetchFieldHistory(url, { apiKey, formFactor = "PHONE", scope = "auto", landingUrl = null } = {}) {
	if (!apiKey) throw new Error("CrUX requires an API key (set CRUX_API_KEY)");

	const page = pageTarget(url, landingUrl);

	const attempts = [];
	if (scope === "auto" || scope === "url") attempts.push({ url: page.url, scope: page.scope });
	if (scope === "auto" || scope === "origin") attempts.push({ origin: new URL(url).origin, scope: "origin" });

	let lastError = null;

	for (let attempt of attempts) {
		const { scope: attemptScope, ...key } = attempt;
		const body = { ...key, metrics: CRUX_METRICS };
		if (formFactor && formFactor !== "ALL") body.formFactor = formFactor;

		try {
			const json = await postJson(HISTORY_ENDPOINT, apiKey, body);
			const history = normalizeHistory(json, attemptScope, formFactor, attemptScope === "landing" ? page.url : null);

			// Same as the single-record path: the origin's own history is fetched
			// and attached beside the page's, not folded into it.
			if (history && attemptScope !== "origin" && scope === "auto" && history.series.some((w) => originCouldHelp(w.metrics))) {
				return await attachOriginHistory(history, url, { apiKey, formFactor });
			}

			return history;
		} catch (err) {
			lastError = err;
			if (err.notFound) continue;
			throw err;
		}
	}

	if (lastError?.notFound) return null;
	throw lastError;
}

/**
 * The origin's weekly history, attached beside a page's own.
 *
 * Kept as its own series rather than folded in week by week: a chart drawn from
 * a mixture has no single subject, and the page's series is the one the verdict
 * reads.
 *
 * Never fatal, for the same reason as the single-record version.
 */
async function attachOriginHistory(history, url, { apiKey, formFactor }) {
	let origin;
	try {
		const body = { origin: new URL(url).origin, metrics: CRUX_METRICS };
		if (formFactor && formFactor !== "ALL") body.formFactor = formFactor;
		origin = normalizeHistory(await postJson(HISTORY_ENDPOINT, apiKey, body), "origin", formFactor);
	} catch {
		return history;
	}

	if (!origin?.series?.length) return history;

	return { ...history, origin };
}

function normalizeHistory(json, scope, formFactor, url = null) {
	const record = json?.record;
	if (!record) return null;

	const periods = (record.collectionPeriods || []).map((p) => ({
		first: collectionDate(p?.firstDate),
		last: collectionDate(p?.lastDate),
	}));

	// Transpose Google's metric-major timeseries into one row per week, which
	// is what every chart and table downstream actually wants.
	const series = periods.map((period, i) => {
		const point = { period, date: period.last, metrics: {} };

		for (let [name, data] of Object.entries(record.metrics || {})) {
			const short = SHORT_NAME[name];
			if (!short) continue;

			const p75 = toNumber(data?.percentilesTimeseries?.p75s?.[i]);
			const densities = data?.histogramTimeseries;
			const density = (b) => {
				const d = toNumber(densities?.[b]?.densities?.[i]);
				return d === null ? null : Math.round(d * 1000) / 10;
			};

			point.metrics[short] = {
				p75,
				rating: rate(short, p75),
				distribution: Array.isArray(densities) && densities.length >= 3
					? { good: density(0), needsImprovement: density(1), poor: density(2) }
					: null,
			};
		}

		return point;
	});

	// `url` as on a record: the URL asked about, when it is not the site's own.
	return { source: "crux-history", scope, ...(url ? { url } : {}), formFactor, series };
}

/** One-shot connectivity/shape check so key problems surface immediately. */
export async function checkApiKey(apiKey, testOrigin = "https://web.dev") {
	const result = await fetchFieldData(testOrigin, { apiKey, scope: "origin" });
	return result;
}
