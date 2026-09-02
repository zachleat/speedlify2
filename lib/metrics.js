import { extractRedirect } from "./redirect.js";

/**
 * Turn a Lighthouse result (LHR) into the compact, stable record we persist.
 *
 * Everything here is defensive: Lighthouse renames and moves audits between
 * majors (v13 moved a pile of them behind `*-insight` ids), and a record that
 * throws on a missing audit would break the whole history. Anything we can't
 * find comes back `null` and the UI renders it as "—".
 */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function audit(lhr, id) {
	return lhr?.audits?.[id];
}

function auditNumeric(lhr, id) {
	return num(audit(lhr, id)?.numericValue);
}

function auditScore(lhr, id) {
	const s = audit(lhr, id)?.score;
	return typeof s === "number" ? s : null;
}

function items(lhr, id) {
	const d = audit(lhr, id)?.details;
	return Array.isArray(d?.items) ? d.items : [];
}

function sum(list, key) {
	let total = 0;
	let seen = false;
	for (let item of list) {
		if (typeof item?.[key] === "number" && Number.isFinite(item[key])) {
			total += item[key];
			seen = true;
		}
	}
	return seen ? total : null;
}

/**
 * Sum an audit's items, distinguishing "the audit ran and found nothing" (0)
 * from "the audit wasn't in this report at all" (null).
 *
 * This matters more than it looks: a passing site legitimately has zero unused
 * JavaScript, and recording that as null would put a gap in the chart exactly
 * where the good news is — and would make a later regression from 0 look like
 * data starting rather than a number going up.
 */
function sumAudit(lhr, id, key) {
	if (!audit(lhr, id)) return null;
	return sum(items(lhr, id), key) ?? 0;
}

function round(v, places = 0) {
	if (v === null) return null;
	const f = 10 ** places;
	return Math.round(v * f) / f;
}

/* -------------------------------------------------------------------------- */

/** Category scores, 0–100. `agentic-browsing` is new in Lighthouse 13. */
function categories(lhr) {
	const out = {};
	for (let [id, cat] of Object.entries(lhr.categories || {})) {
		out[id] = typeof cat.score === "number" ? Math.round(cat.score * 100) : null;
	}
	return out;
}

/**
 * Core timings. `audits.metrics` hands back every lab metric in one object,
 * including timeToFirstByte, which is otherwise annoying to derive.
 */
function timings(lhr) {
	const m = items(lhr, "metrics")[0] || {};
	const pick = (key, fallbackAuditId) =>
		num(m[key]) ?? (fallbackAuditId ? auditNumeric(lhr, fallbackAuditId) : null);

	return {
		fcp: round(pick("firstContentfulPaint", "first-contentful-paint")),
		lcp: round(pick("largestContentfulPaint", "largest-contentful-paint")),
		si: round(pick("speedIndex", "speed-index")),
		tbt: round(pick("totalBlockingTime", "total-blocking-time")),
		tti: round(pick("interactive", "interactive")),
		// CLS is unitless; keep three decimals.
		cls: round(num(m.cumulativeLayoutShift) ?? auditNumeric(lhr, "cumulative-layout-shift"), 3),
		ttfb: round(pick("timeToFirstByte")),
		maxPotentialFid: round(pick("maxPotentialFID", "max-potential-fid")),
		// Origin-level server latency, separate from this document's TTFB.
		serverResponseTime: round(auditNumeric(lhr, "server-response-time")),
		networkRtt: round(auditNumeric(lhr, "network-rtt"), 1),
		networkServerLatency: round(auditNumeric(lhr, "network-server-latency"), 1),
	};
}

/**
 * Which part of LCP got slower. A flat LCP number tells you something
 * regressed; the subparts tell you whether it was the server, resource
 * discovery, the download, or render-blocking work.
 */
function lcpBreakdown(lhr) {
	const detail = audit(lhr, "lcp-breakdown-insight")?.details;
	const list = Array.isArray(detail?.items) ? detail.items : [];
	const table = list.find((i) => i?.type === "table" && Array.isArray(i.items));
	if (!table) return null;

	const out = {};
	for (let row of table.items) {
		if (row?.subpart) out[row.subpart] = round(num(row.duration), 1);
	}
	return Object.keys(out).length ? out : null;
}

/** Page weight and request count, split by resource type. */
function weight(lhr) {
	const diag = items(lhr, "diagnostics")[0] || {};
	const out = {
		total: num(diag.totalByteWeight) ?? auditNumeric(lhr, "total-byte-weight"),
		requests: num(diag.numRequests),
		mainDocument: num(diag.mainDocumentTransferSize),
		byType: {},
	};

	for (let row of items(lhr, "resource-summary")) {
		if (!row?.resourceType) continue;
		out.byType[row.resourceType] = {
			bytes: num(row.transferSize),
			requests: num(row.requestCount),
		};
	}

	if (out.total === null && out.byType.total) out.total = out.byType.total.bytes;
	if (out.requests === null && out.byType.total) out.requests = out.byType.total.requests;

	// Counts that creep up quietly between releases.
	out.scripts = num(diag.numScripts);
	out.stylesheets = num(diag.numStylesheets);
	out.fonts = num(diag.numFonts);

	return out;
}

/**
 * Third-party cost. This is the metric most likely to regress without anyone
 * on the team shipping a thing — a tag manager container changes and your
 * main thread budget is gone.
 */
/*
 * Chrome's request types, in the vocabulary the page-weight bar already uses.
 *
 * `network-requests` reports the DevTools names — "Script", "Image", "Fetch",
 * "Ping" — while `resource-summary`, which feeds `weight.byType`, reports
 * lowercase buckets. The two sections sit one above the other on a site page
 * and share a color key, so they have to agree: without this the third-party
 * bars ask for a `.type-Image` class that does not exist and draw uncolored.
 *
 * Everything outside the seven buckets that key covers — XHR, Fetch, Ping,
 * WebSocket, and the rest of the long tail — folds into "other", which is where
 * `resource-summary` puts it too.
 */
const RESOURCE_TYPES = new Set(["document", "stylesheet", "image", "media", "font", "script"]);

function normalizeResourceType(type) {
	const key = String(type).toLowerCase();
	return RESOURCE_TYPES.has(key) ? key : "other";
}

function thirdParty(lhr) {
	// Absent audit → null. Present with no entities → a real zero.
	if (!audit(lhr, "third-parties-insight")) return null;

	const rows = items(lhr, "third-parties-insight");
	if (!rows.length) return { count: 0, bytes: 0, mainThreadMs: 0, top: [] };

	/*
	 * What kind of bytes each third party is: script, image, font, and so on.
	 *
	 * Neither audit has this on its own. The insight names entities and lists
	 * their URLs; `network-requests` types every URL but knows nothing about
	 * entities. Joining them on the URL gives the breakdown, and the join is
	 * exact — both audits describe the same request set from the same run.
	 *
	 * Types come from Chrome, so they are the same vocabulary `weight.byType`
	 * already uses on this page, and the two sections read alike.
	 */
	const typeByUrl = new Map();
	for (let req of items(lhr, "network-requests")) {
		if (req?.url && req?.resourceType) typeByUrl.set(req.url, normalizeResourceType(req.resourceType));
	}

	const breakdown = (row) => {
		const subItems = row?.subItems?.items;
		if (!Array.isArray(subItems) || !subItems.length) return null;

		const byType = {};
		let typed = 0;
		for (let sub of subItems) {
			// A URL the network audit did not report is skipped rather than
			// bucketed as "other": a made-up type would be indistinguishable from
			// a measured one in the bar.
			const type = typeByUrl.get(sub?.url);
			if (!type) continue;

			const bytes = num(sub.transferSize) ?? 0;
			byType[type] = (byType[type] ?? 0) + bytes;
			typed += bytes;
		}

		return typed ? { byType, typedBytes: typed } : null;
	};

	const entities = rows
		.map((r) => {
			const parts = breakdown(r);
			return {
				entity: typeof r.entity === "string" ? r.entity : r.entity?.text || String(r.entity ?? ""),
				bytes: num(r.transferSize),
				mainThreadMs: round(num(r.mainThreadTime), 1),
				// Null where the join found nothing to type, so the template can
				// fall back to a plain bar rather than draw an empty stack.
				...(parts ? { byType: parts.byType, typedBytes: parts.typedBytes } : {}),
			};
		})
		.filter((e) => e.entity)
		.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));

	return {
		count: entities.length,
		bytes: sum(entities, "bytes"),
		mainThreadMs: round(sum(entities, "mainThreadMs"), 1),
		// Keep the worst offenders so a regression is attributable, not just visible.
		top: entities.slice(0, 5),
	};
}

/** Where the main thread actually went: script eval vs style/layout vs parse. */
function mainThread(lhr) {
	const rows = items(lhr, "mainthread-work-breakdown");
	if (!rows.length) return null;

	const out = { total: round(auditNumeric(lhr, "mainthread-work-breakdown"), 1), byGroup: {} };
	for (let row of rows) {
		if (row?.group) out.byGroup[row.group] = round(num(row.duration), 1);
	}
	out.bootupMs = round(auditNumeric(lhr, "bootup-time"), 1);

	const tasks = items(lhr, "long-tasks");
	out.longTasks = tasks.length || 0;
	out.longestTaskMs = tasks.length ? round(Math.max(...tasks.map((t) => num(t.duration) ?? 0)), 1) : null;

	return out;
}

/**
 * A DOM snapshot that cannot be describing a page that loaded.
 *
 * Lighthouse takes its element census from one snapshot at the end of the run,
 * and that snapshot occasionally comes back as a bare document while every
 * other audit in the same run saw the real page. Three runs in 4,840 here have
 * reported `2 elements, depth 1, most children 1` for sites that fetched thirty
 * requests, painted inside three seconds and scored in the nineties —
 * maprunner.co.uk measured 239 elements the week before and 239 again on a
 * re-run today.
 *
 * The floor is set where no served document can reach. `<html><head></head>
 * <body></body></html>` is already three elements at depth 1, and a page with
 * anything at all inside body is at depth 2 — so a real page cannot produce
 * these numbers, and nothing real is thrown away by refusing them.
 *
 * Refused rather than clamped or kept: there is no route back to the true count
 * from a failed snapshot, and a gap in the series reads as "not measured" where
 * a 2 reads as "this site is empty" — a claim about someone's site that is
 * simply false.
 */
export function domSnapshotFailed(dom) {
	if (!dom) return false;
	return dom.depth <= 1 || dom.elements <= 2;
}

/** DOM size — correlates with style/layout cost and only ever goes up. */
function dom(lhr) {
	const rows = items(lhr, "dom-size-insight");
	const readValue = (v) => (typeof v === "object" && v ? num(v.value) : num(v));

	const out = { elements: null, depth: null, maxChildren: null };
	for (let row of rows) {
		const stat = String(row?.statistic || "").toLowerCase();
		const value = readValue(row?.value);
		if (stat.includes("total element")) out.elements = value;
		else if (stat.includes("depth")) out.depth = value;
		else if (stat.includes("children")) out.maxChildren = value;
	}

	if (out.elements === null) out.elements = auditNumeric(lhr, "dom-size-insight");
	// Stored as nulls, so the record says the snapshot failed rather than
	// reporting a two-element page that was never served.
	if (domSnapshotFailed(out)) return { elements: null, depth: null, maxChildren: null };
	return out;
}

/**
 * Bytes you shipped but didn't use, plus cacheability. These lead the score:
 * unused JS climbing for three weeks is the story behind the performance drop
 * that shows up in week four.
 */
function waste(lhr) {
	return {
		unusedJsBytes: sumAudit(lhr, "unused-javascript", "wastedBytes"),
		unusedCssBytes: sumAudit(lhr, "unused-css-rules", "wastedBytes"),
		legacyJsBytes: sumAudit(lhr, "legacy-javascript-insight", "wastedBytes"),
		duplicatedJsBytes: sumAudit(lhr, "duplicated-javascript-insight", "wastedBytes"),
		unminifiedJsBytes: sumAudit(lhr, "unminified-javascript", "wastedBytes"),
		unminifiedCssBytes: sumAudit(lhr, "unminified-css", "wastedBytes"),
		renderBlockingMs: round(sumAudit(lhr, "render-blocking-insight", "wastedMs"), 1),
		renderBlockingCount: items(lhr, "render-blocking-insight").length || 0,
		poorlyCachedBytes: sumAudit(lhr, "cache-insight", "wastedBytes"),
		poorlyCachedCount: items(lhr, "cache-insight").length || 0,
	};
}

/**
 * Accessibility failures by count and id, not just the weighted score. The
 * score is coarse enough that you can add a whole broken component and barely
 * move it; the failing-audit list moves immediately.
 */
function accessibility(lhr) {
	const refs = lhr?.categories?.accessibility?.auditRefs || [];
	const failing = [];
	let applicable = 0;

	for (let ref of refs) {
		const a = audit(lhr, ref.id);
		if (!a || a.score === null) continue; // not applicable to this page
		applicable++;
		if (a.score < 1) {
			failing.push({
				id: ref.id,
				title: a.title,
				// How many nodes on the page violate it — the number that actually
				// tracks whether things are getting better.
				nodes: Array.isArray(a.details?.items) ? a.details.items.length : null,
			});
		}
	}

	return {
		failingCount: failing.length,
		applicableCount: applicable,
		failingNodes: sum(failing, "nodes") ?? 0,
		failing: failing.sort((a, b) => (b.nodes ?? 0) - (a.nodes ?? 0)).slice(0, 15),
	};
}

/**
 * Hygiene that changes rarely but matters enormously when it does — usually as
 * the silent side effect of an infra change nobody announced.
 */
function hygiene(lhr) {
	const proto = items(lhr, "network-requests").find((r) => r?.protocol)?.protocol ?? null;

	return {
		https: auditScore(lhr, "is-on-https"),
		hsts: auditScore(lhr, "has-hsts"),
		csp: auditScore(lhr, "csp-xss"),
		clickjacking: auditScore(lhr, "clickjacking-mitigation"),
		originIsolation: auditScore(lhr, "origin-isolation"),
		trustedTypes: auditScore(lhr, "trusted-types-xss"),
		bfCache: auditScore(lhr, "bf-cache"),
		bfCacheFailures: items(lhr, "bf-cache").length || 0,
		protocol: proto,
		legacyHttpRequests: items(lhr, "modern-http-insight").length || 0,
		redirectMs: round(auditNumeric(lhr, "redirects"), 1),
		consoleErrors: items(lhr, "errors-in-console").length || 0,
		// Baseline feature usage — how modern the shipped code is over time.
		baselineLimitedFeatures: items(lhr, "baseline").length || 0,
	};
}

/**
 * Environment. `benchmarkIndex` is a CPU speed score for the machine that ran
 * the test — higher is faster. Without it, a slow shared CI runner looks
 * exactly like a real TBT/TTI regression. Always chart it beside the metrics.
 */
function environment(lhr) {
	return {
		lighthouseVersion: lhr.lighthouseVersion ?? null,
		benchmarkIndex: round(num(lhr.environment?.benchmarkIndex), 1),
		formFactor: lhr.configSettings?.formFactor ?? null,
		throttlingMethod: lhr.configSettings?.throttlingMethod ?? null,
		userAgent: lhr.environment?.networkUserAgent ?? null,
		fetchTime: lhr.fetchTime ?? null,
		// How long the audit itself took, useful for spotting a slowing runner.
		runtimeMs: round(num(lhr.timing?.total), 1),
	};
}

/* -------------------------------------------------------------------------- */

export function extractMetrics(lhr) {
	return {
		requestedUrl: lhr.requestedUrl ?? null,
		finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? null,
		// Non-null only when the requested URL is not where we ended up.
		redirect: extractRedirect(lhr),
		statusCode: auditScore(lhr, "http-status-code") === 0 ? "error" : "ok",
		scores: categories(lhr),
		timings: timings(lhr),
		lcpBreakdown: lcpBreakdown(lhr),
		weight: weight(lhr),
		thirdParty: thirdParty(lhr),
		mainThread: mainThread(lhr),
		dom: dom(lhr),
		waste: waste(lhr),
		accessibility: accessibility(lhr),
		hygiene: hygiene(lhr),
		environment: environment(lhr),
	};
}

/**
 * The loading filmstrip, as raw JPEG buffers.
 *
 * Lighthouse renders every page it measures, so these cost nothing extra to
 * collect — they are already in the LHR and were previously thrown away with
 * it. Two audits carry them and they overlap exactly: `final-screenshot` is
 * byte-identical to the last `screenshot-thumbnails` frame, verified across
 * fast and slow sites. So only the filmstrip is read, and the final screenshot
 * is the last frame of it rather than a second copy.
 *
 * `lhr.fullPageScreenshot` is deliberately ignored. It is the entire scrollable
 * page — 237 KB and 16,000 pixels tall for one site here — which is an order of
 * magnitude more than the rest of a measurement put together. The site page's
 * own screenshots come from the axe pass instead, at viewport size; see
 * lib/axe.js.
 *
 * Returns null when the audit is missing or not applicable, which is the normal
 * answer for a run that errored before rendering anything.
 */
export function extractScreenshots(lhr) {
	const items = lhr?.audits?.["screenshot-thumbnails"]?.details?.items;
	if (!Array.isArray(items) || !items.length) return null;

	const frames = [];
	for (let item of items) {
		// `data:image/jpeg;base64,…`. Anything else is a Lighthouse change we do
		// not understand, and guessing at it would write garbage to disk.
		const match = /^data:image\/jpeg;base64,(.+)$/.exec(item?.data ?? "");
		if (!match) continue;
		frames.push({ timing: item.timing ?? null, buffer: Buffer.from(match[1], "base64") });
	}

	return frames.length ? frames : null;
}

/**
 * Pick the representative run out of N. Median by performance score, tie-broken
 * by LCP, which is the noisiest of the headline metrics. Taking the median
 * rather than the best keeps the series honest.
 */
export function medianRun(records) {
	const usable = records.filter(Boolean);
	if (usable.length === 0) return null;
	if (usable.length === 1) return usable[0];

	const sorted = [...usable].sort((a, b) => {
		const perf = (a.scores?.performance ?? 0) - (b.scores?.performance ?? 0);
		if (perf !== 0) return perf;
		return (a.timings?.lcp ?? 0) - (b.timings?.lcp ?? 0);
	});

	return sorted[Math.floor((sorted.length - 1) / 2)];
}
