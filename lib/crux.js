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
 *  - URL-level data is sparser than origin-level. We fall back automatically.
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

		const res = await fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
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
 * Current 28-day field data for a URL.
 *
 * Tries URL-level first (more specific), falls back to origin-level, which is
 * what most sites will actually have. The returned record says which you got —
 * never silently mix the two in one series.
 */
/**
 * The three Core Web Vitals, in the order they are reported everywhere else.
 */
const CWV_KEYS = ["lcp", "inp", "cls"];

/** Whether a metrics object is missing any Core Web Vital. */
function missingCoreWebVitals(metrics) {
	return CWV_KEYS.some((key) => metrics?.[key]?.p75 == null);
}

/**
 * Fill a URL's gaps from its origin, marking what came from where.
 *
 * CrUX reports a metric only when it has enough samples for that metric, so a
 * page can be reported for LCP and CLS and left blank for INP — INP needs real
 * interactions, which a page gets fewer of than it gets loads. The origin's
 * dataset pools every page on the site, so it frequently has the number the
 * page is short of.
 *
 * This is Google's own recommended fallback, and the merge is per metric rather
 * than all-or-nothing: a page-level LCP is a better answer than the whole
 * site's, so a real value is never replaced. Every borrowed value is tagged
 * `scope: "origin"` so nothing downstream can mistake the site's number for the
 * page's.
 */
function fillFromOrigin(metrics, originMetrics) {
	if (!originMetrics) return { metrics, borrowed: [] };

	const merged = { ...metrics };
	const borrowed = [];

	for (let [key, value] of Object.entries(originMetrics)) {
		if (merged[key]?.p75 != null) continue;
		if (value?.p75 == null) continue;

		merged[key] = { ...value, scope: "origin" };
		borrowed.push(key);
	}

	return { metrics: merged, borrowed };
}

export async function fetchFieldData(url, { apiKey, formFactor = "PHONE", scope = "auto" } = {}) {
	if (!apiKey) throw new Error("CrUX requires an API key (set CRUX_API_KEY)");

	const attempts = [];
	if (scope === "auto" || scope === "url") attempts.push({ url, scope: "url" });
	if (scope === "auto" || scope === "origin") attempts.push({ origin: new URL(url).origin, scope: "origin" });

	let lastError = null;

	for (let attempt of attempts) {
		const { scope: attemptScope, ...key } = attempt;
		const body = { ...key, metrics: CRUX_METRICS };
		// Omitting formFactor aggregates all devices; "ALL" is not a valid value.
		if (formFactor && formFactor !== "ALL") body.formFactor = formFactor;

		try {
			const json = await postJson(ENDPOINT, apiKey, body);
			const record = normalizeRecord(json, attemptScope, formFactor);

			// A URL-scoped answer with gaps in it is the case the origin can help
			// with. An origin-scoped answer is already the broadest dataset there
			// is, so there is nothing further to fall back to.
			if (record && attemptScope === "url" && scope === "auto" && missingCoreWebVitals(record.metrics)) {
				return await fillRecordFromOrigin(record, url, { apiKey, formFactor });
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
 * Second request, for the origin, to fill a page-scoped record's blanks.
 *
 * Never fatal. The page's own numbers are the answer being returned; the origin
 * is an improvement on it, and an improvement that fails to arrive leaves the
 * original answer exactly as good as it was.
 */
async function fillRecordFromOrigin(record, url, { apiKey, formFactor }) {
	let origin;
	try {
		const body = { origin: new URL(url).origin, metrics: CRUX_METRICS };
		if (formFactor && formFactor !== "ALL") body.formFactor = formFactor;
		origin = normalizeRecord(await postJson(ENDPOINT, apiKey, body), "origin", formFactor);
	} catch {
		return record;
	}

	const { metrics, borrowed } = fillFromOrigin(record.metrics, origin?.metrics);
	if (!borrowed.length) return record;

	// Recomputed rather than carried over: the verdict is about the metrics as
	// they now stand, and two of three filled in changes both numbers.
	const ratings = CWV_KEYS.map((k) => metrics[k]?.rating).filter(Boolean);

	return {
		...record,
		metrics,
		cwvPass: ratings.length ? ratings.every((r) => r === "good") : null,
		cwvAssessed: ratings.length,
		// Which values are the whole site's rather than this page's.
		borrowedFromOrigin: borrowed,
	};
}

function normalizeRecord(json, scope, formFactor) {
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
export async function fetchFieldHistory(url, { apiKey, formFactor = "PHONE", scope = "auto" } = {}) {
	if (!apiKey) throw new Error("CrUX requires an API key (set CRUX_API_KEY)");

	const attempts = [];
	if (scope === "auto" || scope === "url") attempts.push({ url, scope: "url" });
	if (scope === "auto" || scope === "origin") attempts.push({ origin: new URL(url).origin, scope: "origin" });

	let lastError = null;

	for (let attempt of attempts) {
		const { scope: attemptScope, ...key } = attempt;
		const body = { ...key, metrics: CRUX_METRICS };
		if (formFactor && formFactor !== "ALL") body.formFactor = formFactor;

		try {
			const json = await postJson(HISTORY_ENDPOINT, apiKey, body);
			const history = normalizeHistory(json, attemptScope, formFactor);

			// Same fallback as the single-record path: a page reported for LCP and
			// blank for INP can usually borrow INP from the whole site.
			if (history && attemptScope === "url" && scope === "auto" && history.series.some((w) => missingCoreWebVitals(w.metrics))) {
				return await fillHistoryFromOrigin(history, url, { apiKey, formFactor });
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
 * Fill a page's weekly history from the origin's, week by week.
 *
 * Matched on the collection period's end date rather than by position: the two
 * series are requested together and should line up, but a page that entered the
 * dataset late has fewer weeks than its origin, and pairing those by index would
 * silently attribute one week's numbers to another.
 *
 * Never fatal, for the same reason as the single-record version.
 */
async function fillHistoryFromOrigin(history, url, { apiKey, formFactor }) {
	let origin;
	try {
		const body = { origin: new URL(url).origin, metrics: CRUX_METRICS };
		if (formFactor && formFactor !== "ALL") body.formFactor = formFactor;
		origin = normalizeHistory(await postJson(HISTORY_ENDPOINT, apiKey, body), "origin", formFactor);
	} catch {
		return history;
	}

	if (!origin?.series?.length) return history;

	const byDate = new Map(origin.series.map((week) => [week.date, week]));
	let borrowedAny = false;

	const series = history.series.map((week) => {
		const { metrics, borrowed } = fillFromOrigin(week.metrics, byDate.get(week.date)?.metrics);
		if (!borrowed.length) return week;

		borrowedAny = true;
		return { ...week, metrics, borrowedFromOrigin: borrowed };
	});

	return borrowedAny ? { ...history, series } : history;
}

function normalizeHistory(json, scope, formFactor) {
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

	return { source: "crux-history", scope, formFactor, series };
}

/** One-shot connectivity/shape check so key problems surface immediately. */
export async function checkApiKey(apiKey, testOrigin = "https://web.dev") {
	const result = await fetchFieldData(testOrigin, { apiKey, scope: "origin" });
	return result;
}
