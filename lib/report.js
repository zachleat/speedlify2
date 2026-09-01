import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { ResultStore } from "./store.js";
import { trend, rank, isSignificant, environmentDrift, labVsField, DRIFT_THRESHOLD } from "./compare.js";
import { readAliases, resolveHistoryUrls, applyAliases } from "./aliases.js";
import { selectSiteOfTheDay } from "./site-of-the-day.js";
import { urlHash, distinctUrls, normalizeUrl, shortHash } from "./hash.js";
import { rate, CWV_THRESHOLDS } from "./crux.js";
import { assignSlugs } from "./slug.js";
import { confirmRedirect, isRetiredDestination } from "./redirect.js";
import { detectHost, detectGenerator, generatorById } from "./stack.js";
import {
	createComparator,
	rankLeaderboard,
	lighthouseSum,
	tiebreakerValue,
	tiebreakerWeight,
	accessibilityViolations,
	coreWebVitalFailures,
	scoreBand,
	axeBand,
	AXE_BAND_AVERAGE,
	bandCounts,
	cwvBand,
	coreWebVitalWorst,
} from "./rank.js";
import {
	SCORES,
	LAB_METRICS,
	FIELD_METRICS,
	WEIGHT_METRICS,
	HEALTH_METRICS,
} from "./report-metrics.js";

/**
 * Turn the configured redirect map into pages worth publishing.
 *
 * A destination is only allowed if this build emits it: a category page for a
 * group that exists, a site page for a slug that exists, or the home page. The
 * point is that a stale entry fails here, where the count is visible in the
 * report, rather than silently shipping a doorway onto a 404.
 *
 * The label comes from whatever the destination is, so the page can say where
 * someone is going rather than just sending them.
 */
function resolveRedirects(map, groups, entries) {
	const out = [];

	for (const [from, to] of Object.entries(map ?? {})) {
		let name = null;

		if (to === "/") name = "the leaderboard";
		else {
			const group = /^\/group\/([^/]+)\/$/.exec(to);
			if (group) name = groups.find((g) => g.id === group[1])?.name ?? null;

			const site = /^\/site\/([^/]+)\/$/.exec(to);
			if (site) name = entries.find((e) => e.slug === site[1])?.displayUrl ?? null;
		}

		if (name) out.push({ from, to, name });
	}

	return out;
}

/*
 * Every site's latest measurement as one picture: page weight against LCP.
 *
 * Both axes are logarithmic, and not as a stylistic choice — the corpus spans
 * 1 kB to 53 MB of page weight and 0.8 s to 260 s of LCP. On linear axes
 * everything but a handful of outliers collapses into the bottom-left corner
 * and the plot says nothing at all.
 *
 * The geometry is resolved here rather than in the template because it is a few
 * thousand pieces of arithmetic, and Nunjucks is the wrong place for that. What
 * the template receives is coordinates it can print.
 */
function buildScatter(entries, {
	xOf,
	// LCP up the side is the default because it is the outcome on most of these
	// charts. Where the vertical axis is something else, `bandOn` says which axis
	// carries LCP so the colors and the 2.5 s / 4 s lines follow it.
	yOf = (e) => e.latest?.lab?.timings?.lcp,
	unit = "bytes",
	unitY = "ms",
	bandOn = "y",
	// Which Core Web Vital the colors and threshold lines come from. Not always
	// LCP: the layout-shift chart bands on CLS, whose boundaries are 0.1 and 0.25
	// rather than 2.5 s and 4 s.
	metric = "lcp",
	/*
	 * Overrides the metric's thresholds, for an axis that is not a Core Web Vital.
	 * `higherIsBetter` flips which side of them is green — a Lighthouse score of
	 * 90 is good, where an LCP of 90 ms would be.
	 */
	bandsAt = null,
	// A bounded score does not belong on a log axis: 0 has no coordinate there,
	// and the interval from 90 to 100 is not smaller than the one from 10 to 20.
	yScale = "log",
	yDomain = null,
	zeroColumn = false,
	zeroRow = false,
	// One domain covering both axes, so a 45-degree line is genuinely y = x.
	// Only meaningful when the two axes measure the same thing.
	sharedDomain = false,
	identity = false,
} = {}) {
	const points = [];
	for (const entry of entries) {
		const bytes = xOf(entry);
		const lcp = yOf(entry);
		if (typeof bytes !== "number" || bytes < 0) continue;
		/*
		 * Zero is a real value on the JavaScript axis and a missing one on the
		 * total-weight axis, so whether to keep it is the caller's to say.
		 *
		 * Three hundred sites here ship no script at all, and two hundred and
		 * seventy of those paint inside 2.5 s. A log axis cannot hold them, and
		 * quietly dropping them would delete the exact evidence the chart exists
		 * to show. They get a column of their own instead.
		 */
		if (bytes === 0 && !zeroColumn) continue;
		if (typeof lcp !== "number" || lcp < 0) continue;
		// Same rule on the other axis: zero is a real reading for layout shift and
		// a missing one for a paint time.
		if (lcp === 0 && !zeroRow) continue;
		points.push({ bytes, lcp, name: entry.displayUrl, slug: entry.slug });
	}

	if (points.length < 2) return null;

	/*
	 * The domain is the data, padded slightly so edge dots sit inside the frame
	 * rather than half over the border.
	 *
	 * Rounding out to whole decades instead would be tidier arithmetic and a
	 * worse chart: the slowest LCP here is 260 s and the heaviest page 53 MB, so
	 * rounding gives axes running to 1000 s and 100 MB and squanders a quarter of
	 * the height and an eighth of the width on emptiness. Gridlines still land on
	 * round numbers — they are drawn at whatever decades fall inside the range.
	 */
	const xs = points.filter((p) => p.bytes > 0).map((p) => Math.log10(p.bytes));
	if (!xs.length) return null;
	const linearY = yScale === "linear";
	const yv = (v) => (linearY ? v : Math.log10(v));
	const ys = points.filter((p) => linearY || p.lcp > 0).map((p) => yv(p.lcp));
	if (!ys.length) return null;
	const pad = (lo, hi) => {
		const margin = (hi - lo) * 0.03;
		return [lo - margin, hi + margin];
	};
	let [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
	// An explicit domain where the scale has natural bounds, so a corpus that
	// happens to bottom out at 5 does not imply the scale starts there.
	let [y0, y1] = yDomain ? yDomain : pad(Math.min(...ys), Math.max(...ys));
	if (sharedDomain) {
		// Both axes measure the same quantity, so they get the same scale. Without
		// this the identity line is not at 45 degrees and the distance of a point
		// from it — which is the whole reading — means nothing.
		const lo = Math.min(x0, y0);
		const hi = Math.max(x1, y1);
		x0 = y0 = lo;
		x1 = y1 = hi;
	}
	const domain = { x0, x1, y0, y1 };

	// Left and bottom carry two things now — the tick labels and the name of the
	// axis beyond them — so both are deep enough for a second line of text.
	const box = { w: 1000, h: 548, left: 86, right: 14, top: 16, bottom: 70 };
	const plot = { w: box.w - box.left - box.right, h: box.h - box.top - box.bottom };

	/*
	 * The zero column, when there is one: a strip at the left holding every site
	 * with none of whatever the axis measures, then a gap, then the log scale.
	 *
	 * The gap is the whole point. Butted against the decades it would read as
	 * "slightly less than the smallest value", which is wrong by an infinite
	 * distance — zero is not a small number on a log axis, it is off it. The
	 * break says so.
	 */
	const zeroes = points.filter((p) => p.bytes === 0).length;
	const zoneW = zeroColumn && zeroes ? 54 : 0;
	const gapW = zoneW ? 22 : 0;
	const logLeft = box.left + zoneW + gapW;
	const logW = box.w - box.right - logLeft;

	// The same device on the vertical axis, for a metric whose zero is a real
	// reading — most of this corpus shifts its layout not at all.
	const zeroRows = points.filter((p) => p.lcp === 0).length;
	const zoneH = zeroRow && zeroRows ? 34 : 0;
	const gapH = zoneH ? 20 : 0;
	const logBottom = box.top + plot.h - zoneH - gapH;
	const logH = logBottom - box.top;

	const sx = (bytes) =>
		bytes === 0
			? box.left + zoneW / 2
			: logLeft + ((Math.log10(bytes) - domain.x0) / (domain.x1 - domain.x0)) * logW;
	const sy = (ms) =>
		ms === 0 && zoneH
			? box.top + plot.h - zoneH / 2
			: box.top + logH - ((yv(ms) - domain.y0) / (domain.y1 - domain.y0)) * logH;

	const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
	const bytes = (b) =>
		b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} kB` : `${b} B`;
	// Either axis can be bytes or milliseconds, so how to read a value is the
	// caller's to declare rather than something inferred here.
	// CLS is a ratio with no unit, and three decimals is where its thresholds
	// live — 0.1 and 0.25 are meaningless rounded to whole numbers.
	const ratio = (v) => (v === 0 ? "0" : v.toFixed(3));
	const score = (v) => String(Math.round(v));
	const reader = { ms: secs, bytes, none: ratio, score };
	const xValue = reader[unit] ?? bytes;
	const yValue = reader[unitY] ?? secs;

	// Banded by the same thresholds the rings and tables use, so a color means
	// here what it means everywhere else on the site.
	const { good, poor, higherIsBetter = false } = bandsAt ?? CWV_THRESHOLDS[metric];
	const rate = (v) =>
		higherIsBetter
			? v >= good
				? "good"
				: v >= poor
					? "average"
					: "poor"
			: v <= good
				? "good"
				: v <= poor
					? "average"
					: "poor";
	const dots = { good: [], average: [], poor: [] };
	const named = [];
	for (const point of points) {
		const band = rate(bandOn === "x" ? point.bytes : point.lcp);
		// Rounded: a tenth of a pixel in a 1000-wide viewBox is invisible, and
		// carrying the decimals would add a third to the weight of the page.
		const dot = { x: Math.round(sx(point.bytes)), y: Math.round(sy(point.lcp)) };

		/*
		 * Named if it painted inside 2.5 seconds, and not otherwise.
		 *
		 * These are mostly other people's sites, and putting a name on a slow dot
		 * turns a chart about a relationship into a list of who is worst. The
		 * green half is the half worth pointing at. Every dot is still drawn —
		 * the data is not edited, only the name withheld.
		 */
		if (band === "good") {
			/*
			 * The overlay that carries the tooltip is HTML on top of the SVG, so
			 * it is positioned in percentages of the same box the viewBox
			 * describes — the plot scales with the page and the two stay locked
			 * together without any script measuring anything.
			 *
			 * `flip` is decided here for the same reason the coordinates are: a
			 * tooltip near the right edge has to open leftwards or it is cut off,
			 * and CSS alone cannot ask where in the box its element sits.
			 */
			named.push({
				name: point.name,
				slug: point.slug,
				xText: xValue(point.bytes),
				yText: yValue(point.lcp),
				px: Math.round((dot.x / box.w) * 1000) / 10,
				py: Math.round((dot.y / box.h) * 1000) / 10,
				flipX: dot.x > box.w * 0.7,
				flipY: dot.y < box.h * 0.24,
			});
		}
		dots[band].push(dot);
	}

	/*
	 * Ten of the named dots are reachable from the keyboard, spread evenly across
	 * the weight axis.
	 *
	 * All nine hundred cannot be: that many tab stops in the middle of a page is
	 * a trap, not access. None can be either — that leaves the chart pointer-only,
	 * and the whole overlay unreachable without a mouse. A sample is the honest
	 * middle: someone tabbing through gets a real traverse of the plot, light
	 * pages through heavy ones, and can follow any of them to the site's page.
	 *
	 * Chosen by position rather than at random so the walk is orderly and the
	 * same ten are picked on every build — a sample that reshuffled itself each
	 * run would move the focus order under anyone who learned it.
	 */
	const KEYBOARD_SAMPLE = 10;
	const byWeight = [...named].sort((a, b) => a.px - b.px);
	for (let i = 0; i < KEYBOARD_SAMPLE && i < byWeight.length; i++) {
		// Mid-bucket rather than the edges: the extremes of this axis are one
		// site each, and a sample made of them describes nothing.
		let at = Math.min(byWeight.length - 1, Math.floor(((i + 0.5) / KEYBOARD_SAMPLE) * byWeight.length));
		// Buckets can collide on a short list; step forward rather than mark the
		// same dot twice and hand back a sample of nine.
		while (at < byWeight.length && byWeight[at].keyboard) at++;
		if (at < byWeight.length) byWeight[at].keyboard = true;
	}

	/*
	 * The focusable ten last, in ascending weight, so tab order walks the plot
	 * left to right and their focus rings paint over the cloud rather than under
	 * it. The rest sit before them, heaviest first — a stable order rather than
	 * whatever the entry list happened to be in.
	 */
	named.sort((a, b) => {
		if (a.keyboard !== b.keyboard) return a.keyboard ? 1 : -1;
		return a.keyboard ? a.px - b.px : b.px - a.px;
	});

	// Ticks land on exact decades, so these can divide rather than round and say
	// "1 MB" where the value formatter above would say "1.0 MB".
	const bytesLabel = (b) => (b >= 1e6 ? `${b / 1e6} MB` : b >= 1e3 ? `${b / 1e3} kB` : `${b} B`);
	const msLabel = (ms) => (ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`);
	const xLabel = unit === "ms" ? msLabel : bytesLabel;

	const xTicks = [];
	for (let e = Math.ceil(domain.x0); e <= Math.floor(domain.x1); e++) {
		xTicks.push({ x: Math.round(sx(10 ** e)), label: xLabel(10 ** e) });
	}
	const yTicks = [];
	if (linearY) {
		// Quarters of the range: five gridlines is enough to read a bounded score
		// against, and more would clutter a chart whose points sit in the top fifth.
		const step = (domain.y1 - domain.y0) / 4;
		for (let i = 0; i <= 4; i++) {
			const v = domain.y0 + step * i;
			yTicks.push({ y: Math.round(sy(v)), label: unitY === "score" ? String(Math.round(v)) : msLabel(v) });
		}
	} else {
		for (let e = Math.ceil(domain.y0); e <= Math.floor(domain.y1); e++) {
			yTicks.push({ y: Math.round(sy(10 ** e)), label: unitY === "none" ? String(+(10 ** e).toFixed(3)) : msLabel(10 ** e) });
		}
	}

	return {
		box,
		plot,
		dots,
		xTicks,
		yTicks,
		/*
		 * Where the tick labels sit, and where the axis names sit beyond them.
		 *
		 * Here rather than as arithmetic in the template, so that changing the
		 * margins above moves the text with them instead of leaving it behind at
		 * an offset someone hand-tuned once.
		 */
		axis: {
			tickY: box.h - box.bottom + 22,
			tickX: box.left - 12,
			xLabel: { x: box.left + plot.w / 2, y: box.h - 12 },
			// Rotated about its own center, so it reads bottom-to-top alongside
			// the scale it names.
			yLabel: { x: 24, y: box.top + plot.h / 2 },
		},
		// Null on an axis with no zeroes to hold. Where it exists, `sep` is the
		// break in the scale and `x` is where the column's own tick goes.
		zero: zoneW
			? { x: box.left + zoneW / 2, sep: box.left + zoneW + gapW / 2, count: zeroes }
			: null,
		/*
		 * The two lines that make the colors a scale rather than a palette.
		 * Horizontal when LCP is the vertical axis, vertical when it is not — a
		 * threshold is a cut across the scale it belongs to, and drawing it on the
		 * wrong one would label the chart with a boundary that means nothing.
		 */
		thresholds: [good, poor].map((v) => {
			const label = bandsAt ? String(v) : metric === "cls" ? String(v) : msLabel(v);
			return bandOn === "x" ? { x: Math.round(sx(v)), label } : { y: Math.round(sy(v)), label };
		}),
		bandOn,
		// The break above the zero row, and where that row's own tick goes.
		zeroY: zoneH
			? { y: box.top + plot.h - zoneH / 2, sep: logBottom + gapH / 2, count: zeroRows }
			: null,
		/*
		 * The y = x line, for charts whose axes measure the same thing. Drawn from
		 * the shared domain's corners rather than from the data, so it is the
		 * reference the points are read against and not a fit to them.
		 */
		identity: identity
			? {
					x1: Math.round(sx(10 ** domain.x0)),
					y1: Math.round(sy(10 ** domain.y0)),
					x2: Math.round(sx(10 ** domain.x1)),
					y2: Math.round(sy(10 ** domain.y1)),
				}
			: null,
		count: points.length,
		counts: { good: dots.good.length, average: dots.average.length, poor: dots.poor.length },
		named,
		labeled: named.length,
		keyboardCount: named.filter((n) => n.keyboard).length,
	};
}


/*
 * The same picture as the chart on /charts/, small enough for a stat tile.
 *
 * Not that markup shrunk: at this size the axes, the threshold lines and the
 * tooltips are all illegible, and nine hundred hit targets in a thumbnail would
 * cost more than the tile is worth. What survives is the shape — the diagonal
 * smear and where it turns amber — which is the one thing readable at 240px and
 * the reason to click through.
 *
 * Built per set, like everything else on the bar, so a category's tile shows its
 * own sites rather than the fleet's.
 */
const { good: LCP_GOOD, poor: LCP_POOR } = CWV_THRESHOLDS.lcp;

function buildScatterPreview(entries, { xOf, yOf, rate, yLinear = false, yDomain = null } = {}) {
	const points = [];
	for (const entry of entries) {
		const bytes = xOf(entry);
		const lcp = yOf(entry);
		if (typeof bytes !== "number" || bytes <= 0) continue;
		if (typeof lcp !== "number" || (!yLinear && lcp <= 0) || lcp < 0) continue;
		points.push({ bytes, lcp });
	}

	// Under a handful the shape is noise, and a tile of four dots invites a
	// reading the data cannot support.
	if (points.length < 12) return null;

	// Margins rather than a uniform pad: the left and bottom edges carry the name
	// of each scale. No tick numbers down here — at this size they would be
	// unreadable, and "which axis is which" is the only question a thumbnail can
	// answer anyway.
	const box = { w: 240, h: 128, left: 15, right: 3, top: 3, bottom: 15 };
	/*
	 * Thinned by an even stride rather than by taking the first N: the entry list
	 * arrives in leaderboard order, so a prefix would be the best sites only and
	 * the tile would show one corner of the plot as though it were the whole.
	 */
	const MAX_DOTS = 300;
	const stride = Math.max(1, Math.ceil(points.length / MAX_DOTS));
	const shown = points.filter((_, i) => i % stride === 0);

	/*
	 * The scale is fitted to the dots actually drawn, not to every point.
	 *
	 * Fitting to all of them reserved room for outliers the stride never sampled:
	 * one site with a 260 s paint stretched the axis, and the thumbnail rendered
	 * with the top third of its box empty. What a tile this size can show is the
	 * shape of the dots it has, and the full chart it links to is where the
	 * outliers belong.
	 */
	const yv = (v) => (yLinear ? v : Math.log10(v));
	const xs = shown.map((q) => Math.log10(q.bytes));
	const ys = shown.map((q) => yv(q.lcp));
	const x0 = Math.min(...xs);
	// A bounded score keeps its own scale, so a category that happens to bottom
	// out at 70 does not stretch the bottom of the tile up to meet it.
	const y0 = yDomain ? yDomain[0] : Math.min(...ys);
	// A set whose sites all weigh the same would divide by zero; one column of
	// dots up the middle is the honest picture of that.
	const dx = Math.max(...xs) - x0 || 1;
	const dy = (yDomain ? yDomain[1] : Math.max(...ys)) - y0 || 1;
	const inner = { w: box.w - box.left - box.right, h: box.h - box.top - box.bottom };

	const dots = { good: [], average: [], poor: [] };
	for (const point of shown) {
		dots[rate(point.lcp)].push({
			x: Math.round(box.left + ((Math.log10(point.bytes) - x0) / dx) * inner.w),
			y: Math.round(box.top + inner.h - ((yv(point.lcp) - y0) / dy) * inner.h),
		});
	}

	return {
		w: box.w,
		h: box.h,
		dots,
		// Same idea as the full chart's: positions resolved here so the text
		// follows the margins instead of being pinned to them by hand.
		axis: {
			xLabel: { x: box.left + inner.w / 2, y: box.h - 4 },
			yLabel: { x: 6, y: box.top + inner.h / 2 },
		},
		// What the tile is drawn from, and what it stands for — these differ once
		// the stride bites, and "1,490 sites" over 300 dots would be a claim the
		// reader has no way to check.
		count: points.length,
		shown: dots.good.length + dots.average.length + dots.poor.length,
	};
}


/*
 * Lab and field LCP for the same site, as a pair joined by a line.
 *
 * The scatter this replaces put one dot per site at (lab, field) and read the
 * gap as distance from a diagonal. A pair on a shared axis says the same thing
 * more directly — the line *is* the disagreement, and its length is measured in
 * the units of the thing being compared rather than in diagonal offset.
 *
 * One row per site, ordered by what real users got. That makes the field dots a
 * smooth curve and leaves the lab dots scattered against it, which is the shape
 * of the finding: field LCP is tightly grouped, and the lab wanders.
 */
function buildLabFieldPairs(entries) {
	const rows = [];
	for (const entry of entries) {
		const lab = entry.latest?.lab?.timings?.lcp;
		const field = entry.latest?.field?.metrics?.lcp?.p75;
		if (typeof lab !== "number" || lab <= 0) continue;
		if (typeof field !== "number" || field <= 0) continue;
		rows.push({ lab, field, name: entry.displayUrl, slug: entry.slug });
	}

	if (rows.length < 2) return null;
	rows.sort((a, b) => a.field - b.field);

	const values = rows.flatMap((r) => [Math.log10(r.lab), Math.log10(r.field)]);
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	const margin = (hi - lo) * 0.03 || 0.1;
	const x0 = lo - margin;
	const x1 = hi + margin;

	// Height follows the number of sites rather than a fixed box: rows thin enough
	// to fit a set page height would put the two dots of a pair on top of each
	// other, which is the one thing this chart must not do.
	const rowH = 4;
	const box = { w: 1000, left: 86, right: 14, top: 16, bottom: 70 };
	box.h = box.top + rows.length * rowH + box.bottom;
	const plot = { w: box.w - box.left - box.right, h: rows.length * rowH };

	const sx = (ms) => Math.round(box.left + ((Math.log10(ms) - x0) / (x1 - x0)) * plot.w);
	const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
	const { good, poor } = CWV_THRESHOLDS.lcp;

	const pairs = rows.map((r, i) => {
		const y = Math.round(box.top + i * rowH + rowH / 2);
		const band = r.field <= good ? "good" : r.field <= poor ? "average" : "poor";
		return {
			y,
			labX: sx(r.lab),
			fieldX: sx(r.field),
			// Colored by what real users got, which is the half of the pair that is
			// true. The lab dot is drawn neutral so the eye reads the verdict off the
			// field end rather than off whichever end sits further right.
			band,
			/*
			 * Named only if real users got a good paint, as on every other chart
			 * here. The rows are all drawn — nothing is hidden — but a slow site is
			 * not identified by name. This one would be the worst place to break
			 * that rule: a row whose line runs the width of the plot is already the
			 * most conspicuous thing on the page, and putting a name on it would be
			 * pointing rather than measuring.
			 */
			named: band === "good",
			// Which way the line runs, since it is not always the same way.
			labSlower: r.lab > r.field,
			name: r.name,
			slug: r.slug,
			labText: secs(r.lab),
			fieldText: secs(r.field),
			py: Math.round((y / box.h) * 1000) / 10,
			flipY: y < box.h * 0.1,
		};
	});

	const xTicks = [];
	for (let e = Math.ceil(x0); e <= Math.floor(x1); e++) {
		const ms = 10 ** e;
		xTicks.push({ x: sx(ms), label: ms >= 1000 ? `${ms / 1000} s` : `${ms} ms` });
	}

	return {
		box,
		plot,
		pairs,
		/*
		 * One row's height as a percentage of the frame, for the hit targets.
		 *
		 * A fixed pixel height cannot work: the SVG scales with the page, so the
		 * gap between rows is whatever 4 viewBox units happen to render as. A
		 * target taller than that overlaps its neighbors and the hover lands on
		 * whichever the DOM painted last — which is how the wrong site's name came
		 * up under the cursor.
		 */
		rowPct: Math.round((rowH / box.h) * 10000) / 100,
		xTicks,
		thresholds: [good, poor].map((ms) => ({ x: sx(ms), label: secs(ms) })),
		axis: {
			tickY: box.h - box.bottom + 22,
			xLabel: { x: box.left + plot.w / 2, y: box.h - 12 },
		},
		count: rows.length,
		labeled: rows.filter((r) => r.field <= good).length,
		labSlower: rows.filter((r) => r.lab > r.field).length,
		labFaster: rows.filter((r) => r.lab < r.field).length,
	};
}

/*
 * A site's generator for the purpose of grouping.
 *
 * Eleventy and Build Awesome are one project under two names, and every chart
 * that groups by generator wants them as one row — split, they describe the same
 * thing twice and each half looks smaller than it is. `ELEVENTY_IDS` is the set
 * the rest of this file already uses for the pair, so they cannot drift apart.
 *
 * Labeled with both names. The current one leads, and the old one is kept in
 * the label rather than dropped: most of these sites still report Eleventy, and
 * a row named only for the rename would not be findable by the name the data
 * actually carries.
 */
function generatorKey(entry) {
	const generator = entry.generator;
	if (!generator) return null;
	return ELEVENTY_IDS.has(generator.id)
		? { name: "Build Awesome (11ty)", icon: generator.icon }
		: generator;
}

/*
 * Sites grouped by what built them, for the two charts that ask what a choice of
 * generator actually costs.
 *
 * A floor of five sites per generator. Below that a median is one or two pages
 * wearing a statistic's clothes, and this corpus has twenty generators with
 * fewer than five — listing them would be inviting a comparison the data cannot
 * support. The count is printed on every row for the same reason.
 *
 * Worth knowing while reading either chart: this corpus is an Eleventy project's
 * corpus. Eleventy is eighty percent of the sites that report a generator, and
 * every other row is a small, self-selected sample of people who chose to submit
 * a site here. It is a fair description of these sites and not of the web.
 */
function groupSites(entries, { keyOf, valueOf, min = 5 } = {}) {
	const by = new Map();
	for (const entry of entries) {
		const key = keyOf(entry);
		if (!key?.name || !entry.latest) continue;
		const value = valueOf(entry);
		if (value === undefined || value === null) continue;
		if (!by.has(key.name)) by.set(key.name, { name: key.name, icon: key.icon ?? null, values: [] });
		by.get(key.name).values.push(value);
	}
	return [...by.values()].filter((g) => g.values.length >= min);
}

/*
 * A strip plot: every site as a dot on a shared log axis, one row per group,
 * with each row's median marked.
 *
 * A distribution rather than a bar of medians. On the JavaScript chart the
 * medians run from 7 kB to 566 kB and a bar would say exactly that and no more —
 * it could not show that Eleventy's row spans from nothing to megabytes, which
 * is the part that says a generator sets a floor rather than a ceiling. On the
 * TTFB chart the medians sit within 1.5x of each other and the rows overlap
 * almost entirely, which is the same fact told the other way: the grouping
 * explains very little, and a bar chart would have hidden that behind ten
 * different lengths.
 */
function buildStrip(entries, { keyOf, valueOf, unit = "bytes", zeroColumn = false, label }) {
	const groups = groupSites(entries, { keyOf, valueOf });
	if (!groups.length) return null;

	const median = (a) => {
		const v = [...a].sort((x, y) => x - y);
		const m = Math.floor(v.length / 2);
		return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
	};
	groups.sort((a, b) => median(a.values) - median(b.values));

	const nonzero = groups.flatMap((g) => g.values.filter((v) => v > 0)).map(Math.log10);
	if (!nonzero.length) return null;
	const lo = Math.min(...nonzero);
	const hi = Math.max(...nonzero);
	const m = (hi - lo) * 0.03;
	const x0 = lo - m;
	const x1 = hi + m;

	const rowH = 34;
	/*
	 * The left margin holds the row labels, and 132 was not enough once Eleventy
	 * and Build Awesome merged: "Build Awesome (11ty) 681" measures 163 units at
	 * this size and was being drawn off the left edge of the frame. 184 leaves
	 * room for a name of that length plus its count and the 12-unit gap.
	 */
	const box = { w: 1000, left: 184, right: 14, top: 16, bottom: 70 };
	box.h = box.top + groups.length * rowH + box.bottom;
	const plot = { w: box.w - box.left - box.right, h: groups.length * rowH };

	// Same device as the JavaScript scatter: a column for the sites with none of
	// whatever is being measured. Not every metric has a meaningful zero — a
	// server that answered in no time did not answer — so the caller decides.
	const zeroes = zeroColumn ? groups.flatMap((g) => g.values).filter((v) => v === 0).length : 0;
	const zoneW = zeroes ? 54 : 0;
	const gapW = zoneW ? 22 : 0;
	const logLeft = box.left + zoneW + gapW;
	const logW = box.w - box.right - logLeft;
	const sx = (b) =>
		b === 0 ? box.left + zoneW / 2 : Math.round(logLeft + ((Math.log10(b) - x0) / (x1 - x0)) * logW);

	const bytes = (b) =>
		b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} kB` : `${b} B`;
	const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
	const kb = unit === "ms" ? secs : bytes;

	/*
	 * Sites that land on the same pixel become one dot sized by how many.
	 *
	 * Area in proportion to the count, which means the radius goes as its square
	 * root — sizing by radius directly would make a stack of nine look nine times
	 * heavier than a single site rather than three.
	 *
	 * Capped, because the zero column holds 141 sites at one position and an
	 * honest radius for that is 30px in a 34px row: it would swallow the rows
	 * above and below. The cap bites only above about 27 sites, which in this
	 * data is the zero column alone — every other stack is drawn to scale.
	 *
	 * Largest first, so the small dots paint over the big ones instead of
	 * disappearing behind them.
	 */
	const stack = (xs) => {
		const counts = new Map();
		for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
		return [...counts.entries()]
			.map(([x, n]) => ({ x, n, r: Math.min(13, Math.round(2.5 * Math.sqrt(n) * 10) / 10) }))
			.sort((a, b) => b.n - a.n);
	};

	const rows = groups.map((g, i) => {
		const y = Math.round(box.top + i * rowH + rowH / 2);
		const mid = median(g.values);
		return {
			name: g.name,
			icon: g.icon,
			y,
			count: g.values.length,
			median: mid,
			medianX: sx(mid),
			medianText: kb(mid),
			zeroes: g.values.filter((v) => v === 0).length,
			dots: stack(g.values.map((v) => sx(v))),
		};
	});

	const xTicks = [];
	for (let e = Math.ceil(x0); e <= Math.floor(x1); e++) {
		xTicks.push({ x: sx(10 ** e), label: kb(10 ** e).replace(".0", "") });
	}

	return {
		box,
		plot,
		rows,
		xTicks,
		label,
		zero: zoneW ? { x: box.left + zoneW / 2, sep: box.left + zoneW + gapW / 2, count: zeroes } : null,
		axis: { tickY: box.h - box.bottom + 22, xLabel: { x: box.left + plot.w / 2, y: box.h - 12 } },
		count: groups.reduce((n, g) => n + g.values.length, 0),
		groups: groups.length,
		// The spread between the fastest and slowest row's median, which is the
		// figure that says whether the grouping explains anything at all.
		medianSpread:
			rows.length > 1 ? Math.round((rows[rows.length - 1].median / rows[0].median) * 10) / 10 : null,
	};
}

/*
 * Resource types as shares of total page weight, largest first.
 *
 * Shares rather than raw widths: a stacked bar is read as parts of one whole, so
 * the arithmetic that makes them add up belongs here rather than in a template
 * dividing inside a loop.
 */
function buildWeightBreakdown(byType) {
	if (!byType?.total?.bytes) return [];
	const total = byType.total.bytes;
	return Object.entries(byType)
		.filter(([key, part]) => key !== "total" && key !== "third-party" && part?.bytes > 0)
		.map(([key, part]) => {
			const share = Math.round((part.bytes / total) * 1000) / 10;
			return {
				key,
				bytes: part.bytes,
				requests: part.requests,
				// One decimal for the width, which is all a bar can express.
				share,
				/*
				 * The share as written, which is not always the share as measured.
				 * On a 54 MB page a 26 kB stylesheet rounds to 0.0%, and "0%" next
				 * to "26 kB · 19 req" reads as a broken number rather than a small
				 * one. Anything present but below a tenth of a percent says so.
				 */
				shareText: share < 0.1 ? "<0.1%" : `${share}%`,
			};
		})
		.sort((a, b) => b.bytes - a.bytes);
}

/**
 * Third parties, each split by the kind of bytes it serves.
 *
 * The same treatment the page weight above gets, one row down: a stacked bar
 * says *what* a third party is, where a plain one only says how much. An
 * analytics tag that is all script and an image CDN that is all image are very
 * different neighbors at the same byte count.
 *
 * Shares are of the row's own typed bytes, not of the page — each bar is a
 * whole, and its length against the others is what carries the comparison.
 *
 * `parts` is empty where the measurement predates the per-type extraction, or
 * where no URL in the row could be typed. The template falls back to the plain
 * bar there rather than drawing an empty stack, so an old record still renders.
 */
/**
 * The newest measurements, newest first, as the recents lists render them.
 *
 * Shared by the stat bar's card and the longer list on /runs/ so the two cannot
 * drift: same ordering, same fields, same six band colors per row. Only the
 * length differs, which is the caller's business.
 */
function buildRecents(measured, limit) {
	return measured
		.filter((e) => typeof e.latest?.timestamp === "number")
		.sort((a, b) => b.latest.timestamp - a.latest.timestamp)
		.slice(0, Math.max(0, limit))
		.map((e) => ({
			displayUrl: e.displayUrl,
			slug: e.slug,
			timestamp: e.latest.timestamp,
			bands: ringBands(e),
		}));
}

/*
 * A category's health, as the share of its measured sites showing no red ring.
 *
 * The same question the leaderboard's first step asks of one site, asked of a
 * whole category — which keeps the badge and the order it sits above telling the
 * same story. A proportion rather than a count, so a curated dozen and a
 * community list of a thousand are judged on the same terms.
 *
 * Bands drawn where the corpus already separates. Sorted, the categories run
 * 0, 12, 20, 22 · 34, 36, 42, 43 · 57, 63, 69, 75, 100 — two gaps of more than
 * eleven points, and the lines go in them rather than at round numbers that
 * happen to sound decisive.
 *
 * Null for a category with nothing measured yet: no data is not poor health.
 */
const CATEGORY_HEALTH_GOOD = 50;
const CATEGORY_HEALTH_AVERAGE = 28;

function categoryHealth(entries) {
	const counts = entries.filter((e) => e.latest).map((e) => bandCounts(e)).filter(Boolean);
	if (!counts.length) return null;

	const clean = counts.filter((c) => c.poor === 0).length;
	const pct = round((clean / counts.length) * 100, 1);

	return {
		pct,
		clean,
		measured: counts.length,
		band: pct >= CATEGORY_HEALTH_GOOD ? "good" : pct >= CATEGORY_HEALTH_AVERAGE ? "average" : "poor",
	};
}

function buildThirdPartyRows(thirdParty) {
	if (!thirdParty?.top?.length) return [];

	return thirdParty.top.map((tp) => {
		const typed = tp.typedBytes ?? 0;
		const parts = Object.entries(tp.byType ?? {})
			.filter(([, bytes]) => bytes > 0)
			.map(([key, bytes]) => {
				const share = round((bytes / typed) * 100, 1);
				return { key, bytes, share, shareText: share < 0.1 ? "<0.1%" : `${share}%` };
			})
			.sort((a, b) => b.bytes - a.bytes);

		return {
			entity: tp.entity,
			bytes: tp.bytes,
			mainThreadMs: tp.mainThreadMs,
			parts: typed ? parts : [],
			/*
			 * Bytes the join could not type, kept so the bar can account for the
			 * row's full transfer size rather than silently drawing a short one.
			 * Usually zero; non-zero when a request appears in the third-party
			 * insight but not in the network audit.
			 */
			untyped: Math.max(0, (tp.bytes ?? 0) - typed),
		};
	});
}

/**
 * What the measuring machines have been like.
 *
 * Lighthouse records a benchmark index for the machine each run happened on,
 * and every CPU-bound metric on this site is relative to it: the same page on a
 * slower runner reports a worse TBT and a worse performance score, having done
 * nothing differently. The per-site drift banner compares a run against that
 * site's own history; this is the fleet it is drawn from.
 *
 * Median and mean are both reported because they disagree, and the disagreement
 * is the point — most runners cluster tightly and a thin tail of fast ones drags
 * the mean up, so the median is the figure to reason with.
 *
 * Every stored measurement, not the latest per site: the question is what the
 * machines have done, and a site measured fifty times says fifty things about
 * that.
 */
function buildBenchmarkStats(entries) {
	const values = [];
	for (const entry of entries) {
		for (const point of entry.history ?? []) {
			if (typeof point.bench === "number") values.push(point.bench);
		}
	}

	if (values.length < 2) return null;

	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

	return {
		count: values.length,
		median: Math.round(median),
		mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
		min: Math.round(sorted[0]),
		max: Math.round(sorted[sorted.length - 1]),
		/*
		 * The band the drift notice draws, derived here rather than in the
		 * template so the page and the notice cannot quote different numbers.
		 *
		 * A distance from the median rather than a percentile: the notice claims
		 * the CPU-bound metrics moved, which is a question of how far off the
		 * machine was, not of how rare it was.
		 */
		driftBand: {
			low: Math.round(median * (1 - DRIFT_THRESHOLD)),
			high: Math.round(median * (1 + DRIFT_THRESHOLD)),
			pct: Math.round(DRIFT_THRESHOLD * 100),
		},
	};
}

export const REPORT_VERSION = 1;

/**
 * Build the report: every configured site joined to its stored history, with
 * all trends, rankings and comparisons already computed.
 *
 * This is the whole analysis layer, and it runs as its own step rather than
 * inside the site build. Two things fall out of that:
 *
 *  - The Eleventy build becomes a pure render of one JSON file. It touches no
 *    measurements, so it cannot rebuild a series cache as a side effect and
 *    works fine against a read-only checkout.
 *  - The report is a publishable artifact in its own right — the same numbers
 *    the site shows, in a form something else can consume.
 */
export async function buildReport({
	resultsDir = process.env.SPEEDLIFY_RESULTS_DIR || "results",
	configFile = "config/sites.js",
	// Whether Core Web Vitals are being collected at all. Without a CrUX key
	// there is no INP and no field data, so the only thing we could show is a
	// lab approximation — and presenting that as "Core Web Vitals" would imply a
	// measurement that isn't happening.
	cruxEnabled = Boolean(process.env.CRUX_API_KEY),
	now = Date.now(),
} = {}) {
	const config = await loadConfig(configFile);
	const store = new ResultStore(resultsDir);

	const context = { resultsDir, cruxEnabled, weightByDay: {}, perfectDays: new Map() };

	// Ranking is configurable because where field data sits materially changes
	// the leaderboard.
	const compare = createComparator(config.ranking);

	// Confirmed URL moves, so a site that changed address keeps one continuous
	// history instead of restarting from zero.
	const { aliases } = readAliases(resultsDir);

	// Same resolution the measure step uses, so the report describes where each
	// site lives now rather than where the config last said it lived.
	const sites = applyAliases(config.sites, aliases, urlHash);

	context.displayUrls = distinctUrls(sites.map((s) => s.url));
	// A collision means two sites want one filename, and the embed component —
	// which derives the slug in the browser with no index to check — would find
	// the wrong one. Both fall back to their hash instead, which is loud here
	// and inert there.
	const slugCollisions = [];
	context.slugs = assignSlugs(
		sites.map((s) => s.url),
		{
			onCollision(slug, urls) {
				slugCollisions.push({ slug, urls });
			},
		},
	);
	context.slugCollisions = slugCollisions;

	const all = sites.map((site) => buildEntry(site, store, config, now, aliases, context));

	// Two kinds of site leave the dataset here, before anything ranks or groups
	// them: parked domains found by measurement, and URLs archived by hand. Both
	// keep their stored history — `findOrphans` is given `all` further down — and
	// both are reported separately so the drop is visible rather than silent.
	/*
	 * Archived twice over: by hand, and by having failed for long enough.
	 *
	 * The automatic half is derived here rather than written back into
	 * config/archived.json, so it reverses itself. A site that starts answering
	 * again has its failure count reset by the next successful measurement and
	 * is simply back on the board — no edit, no stale list. Writing to the
	 * config would be a decision the data could no longer take back.
	 */
	const failureLimit = config.archiveAfterFailures ?? 0;
	for (let entry of all) {
		if (entry.archived) {
			entry.archivedReason = "manual";
		} else if (failureLimit && entry.consecutiveFailures >= failureLimit) {
			entry.archived = true;
			entry.archivedReason = "failing";
		}
	}

	const retired = all.filter((e) => e.retiredTo && !e.archived);
	const archived = all.filter((e) => e.archived);
	const entries = all.filter((e) => !e.retiredTo && !e.archived);

	// Membership can depend on what was measured, not only on what was configured.
	/*
	 * What the charts are drawn from: everything except the starters.
	 *
	 * The 158 Build Awesome Starters are templates rather than sites — the same
	 * handful of boilerplates deployed over and over, near-identical in weight
	 * and content. They are a tenth of the corpus and would pull every
	 * distribution on /charts/ toward one repeated point, describing the
	 * starter kit rather than the web it is used to build. They keep their own
	 * category page and their own leaderboard; only the corpus-wide charts leave
	 * them out.
	 *
	 * Membership rather than primary category: the two starters that also sit in
	 * another category are still starters.
	 */
	const chartEntries = entries.filter((e) => !(e.groups || [e.group]).includes("11ty-starters"));

	const emeritus = applyGeneratorRules(entries, config);

	// Strictly after reclassification: a site that just measured as Astro belongs
	// to Emeritus, and must not be handed a presumed Build Awesome mark on its
	// way out.
	applyPresumedGenerators(entries, config);
	flagUnlisted(entries, config);
	flagPerfectScoreExclusions(entries, config);
	flagEmbeds(entries, config);
	flagCadence(entries, config);

	// The machines every CPU-bound number on this site was produced on.
	const benchmark = buildBenchmarkStats(entries);

	/*
	 * Whether the machine behind a measurement was a typical one — asked of the
	 * whole project rather than of the site alone.
	 *
	 * A site's own past can only answer this once it has been measured twice,
	 * which left most of the corpus unjudged; the project median answers for
	 * every measured site from its first run. What it gives up is the machine
	 * that was unusual for one site while sitting inside the fleet's normal
	 * range — a real drift this no longer notices.
	 *
	 * Over `all` rather than `entries` so retired and archived sites, which keep
	 * their pages, are judged by the same rule as everything else.
	 */
	for (let entry of all) {
		entry.environmentDrift = environmentDrift(entry.history ?? [], {
			baseline: benchmark?.median ?? null,
		});

		/*
		 * The same comparison again, per row of the measurement log.
		 *
		 * This used to be the step from the row above, which read as movement the
		 * site had caused. Against the project median instead, every row answers
		 * the question the column exists for on its own: was this machine one the
		 * numbers can be trusted from. `outside` marks the rows the notice above
		 * the table is about.
		 */
		if (!benchmark) continue;
		for (let point of entry.history ?? []) {
			if (typeof point.bench !== "number") continue;
			const ratio = (point.bench - benchmark.median) / benchmark.median;
			point.benchVsMedian = Math.round(ratio * 100);
			point.benchOutside = Math.abs(ratio) > DRIFT_THRESHOLD;
		}
	}

	// Rank globally first, then within each group. These write to different
	// keys on purpose: entries are shared object references, so a single `ranks`
	// field would have the second pass silently overwrite the first and a site
	// would show its global position inside a group table.
	rankEntries(entries, "ranks", compare);

	const groups = Object.entries(config.groups).map(([id, group]) => {
		const groupEntries = entries.filter((e) => (e.groups || [e.group]).includes(id));
		rankEntries(groupEntries, `groupRanks:${id}`, compare);

		return {
			id,
			name: group.name || id,
			description: group.description || "",
			// Whether the category presents as a ranking. Off for Emeritus, which
			// is a record of departures rather than a competition — the ranks are
			// still computed, they are simply not shown.
			ranked: group.ranked !== false,
			// How stale a site here has to be before it is eligible again, which
			// is what sets the cadence a reader sees. Inherited from the top level
			// when the category does not set its own.
			freshnessHours: group.freshnessHours ?? config.freshnessHours ?? null,
			// Whether the category shows a "Biggest movers" panel. Off for
			// Emeritus, for the same reason `ranked` is: these sites left, and
			// singling out the ones whose scores wobbled afterwards is commentary
			// on people who are no longer taking part.
			movers: group.movers !== false,
			// Whether a perfect score here is kept off the home page's board. A
			// property of the category rather than of its sites, so it is reported
			// here as well as stamped on each entry: the page has to be able to say
			// so even when nothing in the category has been measured yet.
			excludeFromPerfectScores: group.excludeFromPerfectScores === true,
			// On the home page's list of categories. False unless a category asks
			// for it: the front page is a short list by default, and a category
			// left out of it still has its page, still appears in the switcher, and
			// its sites still rank everywhere they would have.
			showOnHomePageCategoryList: group.showOnHomePageCategoryList === true,
			// Where a reader adds a site to this category, where that is a place
			// rather than "send a pull request". Null for most of them.
			submitUrl: group.submitUrl ?? null,
			submitLabel: group.submitLabel ?? "Add a site",
			entries: sortByLeaderboard(groupEntries, compare),
			// The panel's contents, decided here because the ordering cannot be
			// expressed in a template: it is by *absolute* change, so a site that
			// fell 30 ranks above one that rose 12, and Nunjucks can neither sort
			// on a computed value nor on a nested attribute.
			//
			// Four, whatever the category's size. "Biggest movers" promises a
			// shortlist, and the significance test alone leaves hundreds in a group
			// of thousands — at which point the panel stops summarizing the table
			// and becomes a worse copy of it.
			//
			// Carries only the fields the card renders. These entries are already
			// in `entries` above; repeating them whole would put four more copies
			// of each in every category.
			topMovers: (group.movers === false ? [] : groupEntries)
				.filter((e) => e.trends?.performance?.significant && e.trends.performance.vsPrevious)
				// By percentage, not points: a 6-point fall from 30 is a bigger
				// story than the same fall from 96, and `pct` already says so.
				.sort(
					(a, b) =>
						Math.abs(b.trends.performance.vsPrevious.pct) - Math.abs(a.trends.performance.vsPrevious.pct),
				)
				.slice(0, 4)
				.map((e) => ({
					slug: e.slug,
					url: e.url,
					displayUrl: e.displayUrl,
					// The object, not a number: deltaClass, deltaArrow and deltaText
					// all read `.pct` and `.better` off it.
					vsPrevious: e.trends.performance.vsPrevious,
					previous: e.trends.performance.previous,
					current: e.trends.performance.current,
				})),
			measured: groupEntries.filter((e) => e.latest).length,
			// When this category was last touched — the newest measurement in it,
			// not the newest attempt. A run that failed everywhere would otherwise
			// report the category as fresh while its numbers stood still.
			//
			// Null when nothing in it has ever been measured, which the page shows
			// as no pill rather than as an age of zero.
			lastMeasured: groupEntries.reduce(
				(newest, e) => (e.latest?.timestamp > (newest ?? 0) ? e.latest.timestamp : newest),
				null,
			),
			// The same figures the home page shows, over this category alone.
			// No `weightHistory`: that is a per-day average across everything
			// measured that day, and there is no per-day-per-category record to
			// draw one from. The template skips the sparkline when it is absent.
			stats: buildStats(groupEntries, { now }),
			// What this category is built with and served from. The same tally the
			// home page shows, over this category's sites rather than all of them —
			// which is the interesting version of it, since a category is usually a
			// set of sites with something in common to find.
			stacks: buildStacks(groupEntries),
			// How many entries have enough history for significance testing.
			comparable: groupEntries.filter((e) => e.historyCount >= 3).length,
			/*
			 * The Good/Warn/Bad badge beside the category's name, where the
			 * category asks for one. Opt-in like `showEmbed`: a health verdict is a
			 * judgment on other people's sites, and a category should say whether
			 * it wants to be summarized that way rather than have it assumed.
			 */
			health: group.showHealth === true ? categoryHealth(groupEntries) : null,
		};
	});

	/*
	 * The categories a site belongs to, biggest first.
	 *
	 * `groups` is in config declaration order, which decides which chip a reader
	 * sees first — and that order is an implementation detail of the config file
	 * rather than anything about the site. Moving a group's declaration up would
	 * silently relabel every site in it.
	 *
	 * Size is the ordering that means something: the general category before the
	 * specific one, which is how a reader narrows down. A hosting company reads
	 * "Developer Tooling" then "Web Hosts"; a personal site reads "Built Awesome"
	 * before the handful it also sits in.
	 *
	 * A separate field rather than a re-sort of `groups`, because `groups[0]` is
	 * the primary category — it is written into every stored measurement and
	 * emitted by the embed API — and that should not move because a category
	 * gained a site.
	 */
	const groupSize = new Map(groups.map((g) => [g.id, g.entries.length]));
	for (let entry of entries) {
		entry.categories = (entry.groups || [entry.group])
			.map((id, i) => ({ id, name: entry.groupNames?.[i] ?? id, size: groupSize.get(id) ?? 0 }))
			.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
	}

	/*
	 * Every board has been ranked, so the previous measurements have done their
	 * job and the movement they produced is on the entries as a number.
	 *
	 * Dropped rather than kept, because `report.json` serializes entries whole:
	 * a full Lighthouse record per site is 8.2 MB on top of 58.6 MB, a 14% file
	 * for a field nothing downstream reads.
	 */
	for (let entry of entries) delete entry.previous;

	return {
		version: REPORT_VERSION,
		config: {
			runs: config.runs,
			formFactor: config.formFactor,
			ranking: config.ranking,
			// Quoted on the page that explains automatic archiving, so the number
			// there cannot drift from the one that decides it.
			archiveAfterFailures: config.archiveAfterFailures,
		},
		// Row definitions, so report.json is renderable without this codebase.
		metrics: { SCORES, LAB_METRICS, FIELD_METRICS, WEIGHT_METRICS, HEALTH_METRICS },
		// Addresses that used to mean something, and where they go now — the
		// original Speedlify's category paths, and any category since folded into
		// another. Each destination is resolved against what this build actually
		// publishes, so an entry pointing at a renamed category or a changed slug
		// is dropped rather than published as a link to a 404.
		redirects: resolveRedirects(config.redirects, groups, entries),
		entries: sortByLeaderboard(entries, compare),
		groups,
		// Whether the switcher has a second list to separate off. A boolean rather
		// than a count, and computed here because the template cannot ask it:
		// Nunjucks has no reliable filter-by-field, and a counter set inside a
		// loop does not survive the iteration.
		// The machines every CPU-bound number on this site was produced on.
		benchmark,
		// For /runs/, which shows the measurement loop's own output at length.
		recentlyMeasured: buildRecents(
			entries.filter((e) => e.latest),
			RECENTLY_MEASURED_LONG,
		),
		// Every site's latest measurement, weight against LCP.
		lcpScatter: buildScatter(chartEntries, {
			xOf: (e) => e.latest?.lab?.weight?.total,
		}),
		// The same question asked of scripts alone, which is the half of page
		// weight a site's own choices move most — and the half that has a
		// meaningful zero.
		jsScatter: buildScatter(chartEntries, {
			xOf: (e) => e.latest?.lab?.weight?.byType?.script?.bytes,
			zeroColumn: true,
		}),
		// And asked of the server rather than the page: how much of the paint was
		// spent waiting for the first byte, before there was anything to render.
		// Do heavier web fonts shift the layout more? Both axes have a real zero —
		// a third of these sites load no font file, and well over half never shift
		// at all — so both get a band of their own outside the log scale.
		fontClsScatter: buildScatter(chartEntries, {
			xOf: (e) => e.latest?.lab?.weight?.byType?.font?.bytes,
			yOf: (e) => e.latest?.lab?.timings?.cls,
			unitY: "none",
			metric: "cls",
			zeroColumn: true,
			zeroRow: true,
		}),
		// What the lab says against what real users got. Only CrUX-covered sites
		// can appear, which is a seventh of the corpus and the popular seventh —
		// the page says so rather than presenting it as the fleet.
		labFieldPairs: buildLabFieldPairs(chartEntries),
		// The server wait along the bottom, paint time up the side — LCP stays on
		// the vertical axis here as it does on every other chart.
		/*
		 * Third-party bytes against the Lighthouse performance score.
		 *
		 * The one chart here whose vertical axis is a verdict rather than a
		 * measurement, which is why it is the one with a linear scale and reversed
		 * colors: ninety and above is green, and the axis stops at a hundred
		 * because the score does.
		 */
		// What a generator costs in shipped JavaScript, and what its sites get in
		// return from real users. Both are grouped by detected generator, and both
		// are dominated by Eleventy — this is an Eleventy project's corpus.
		jsByGenerator: buildStrip(chartEntries, {
			keyOf: generatorKey,
			valueOf: (e) => e.latest?.lab?.weight?.byType?.script?.bytes,
			zeroColumn: true,
			label: "generator",
		}),
		// Where a site is served from, against how long the server took to answer
		// — the one thing on this page a host is directly responsible for.
		ttfbByHost: buildStrip(chartEntries, {
			keyOf: (e) => e.host,
			valueOf: (e) => e.latest?.lab?.timings?.ttfb,
			unit: "ms",
			label: "host",
		}),
		clientRenderedByGenerator: buildClientRenderedByGenerator(chartEntries),
		thirdPartyScatter: buildScatter(chartEntries, {
			xOf: (e) => e.latest?.lab?.weight?.byType?.["third-party"]?.bytes,
			yOf: (e) => e.latest?.lab?.scores?.performance,
			unitY: "score",
			yScale: "linear",
			yDomain: [0, 100],
			bandsAt: { good: 90, poor: 50, higherIsBetter: true },
			zeroColumn: true,
		}),
		ttfbScatter: buildScatter(chartEntries, {
			xOf: (e) => e.latest?.lab?.timings?.ttfb,
			unit: "ms",
		}),
		hasSecondaryCategories: groups.some((g) => !g.showOnHomePageCategoryList),
		// Sites whose stored history no longer matches anything in config —
		// usually a URL that was edited or removed. Surfaced so history isn't
		// silently orphaned.
		// A predecessor URL is no longer an orphan — its history has been merged
		// into the site that succeeded it.
		// `all`, not `entries`: a retired site still has a config entry and is
		// reported above under `retired`. Passing the filtered list would file its
		// stored history as orphaned — the same fact twice, the second time under
		// a name that means the opposite ("nothing in the config claims this").
		orphans: findOrphans(all, store, resultsDir),
		// Sites reclassified out of a category by what their generator turned out
		// to be — see `requireGenerator` in config/sites.js.
		emeritus,
		// Sites whose slug was taken, and which fell back to a hash. Empty is the
		// normal state; anything here is a site whose embed has gone quiet.
		slugCollisions: context.slugCollisions,
		// Sites currently redirecting somewhere that isn't yet being measured.
		// Informational only — once a redirect is confirmed, measurement follows
		// it on its own. This is the waiting room, not a to-do list.
		moving: entries
			.filter((e) => e.redirectTo && e.redirectTo !== e.url)
			.map((e) => ({
				name: e.name,
				hash: e.hash,
				slug: e.slug,
				// Which categories the URL sits in — a redirect in a curated list
				// means something different from one in the address book.
				groups: e.groupNames,
				from: e.url,
				to: e.redirectTo,
				confirmed: e.redirectConfirmed,
				reason: e.redirectReason,
			})),
		// One record per legacy API filename, flat and self-contained. Drives both
		// the per-hash files and the urls.json index, so the two cannot disagree
		// about which spelling maps to which hash.
		//
		// Flat because a URL can answer to more than one of these — see
		// `compatHashes` — and Eleventy paginates one output file per item, so
		// the list has to be the files rather than the sites. Self-contained
		// because the alternative is the template looking each entry up by hash
		// across three thousand of them, once per file.
		compatRoutes: entries.flatMap((e) =>
			e.compatUrls.map(({ url, hash }) => ({
				url,
				hash,
				lighthouse: e.latest?.lab?.scores
					? {
							performance: legacyScore(e.latest.lab.scores.performance),
							accessibility: legacyScore(e.latest.lab.scores.accessibility),
							bestPractices: legacyScore(e.latest.lab.scores["best-practices"]),
							seo: legacyScore(e.latest.lab.scores.seo),
						}
					: null,
			})),
		),
		// Taken out of circulation by hand. Rendered as plain text, with no row and
		// no link — the point of archiving is to stop pointing at a site while
		// keeping the fact that it was here.
		archived: archived.map((e) => ({
			name: e.name,
			hash: e.hash,
			url: e.url,
			displayUrl: e.displayUrl,
			groups: e.groupNames,
			// The last thing we knew, so the list can say when it stopped.
			lastMeasured: e.lastMeasured,
			// "manual" or "failing" — the two mean different things to a reader
			// and to the scheduler, so the page says which.
			reason: e.archivedReason,
			consecutiveFailures: e.consecutiveFailures,
			lastError: e.lastError,
		})),
		// Domains that lapsed and are now parked on a registrar's for-sale page.
		// Deliberately not in `moving` above: that list is a waiting room for
		// moves that may yet be confirmed, and these are not waiting for
		// anything. Listed here so they can be pruned from the config.
		retired: retired.map((e) => ({
			name: e.name,
			hash: e.hash,
			slug: e.slug,
			groups: e.groupNames,
			from: e.url,
			to: e.retiredTo,
		})),
		// Moves already followed automatically, with no config change.
		autoMoved: entries
			.filter((e) => e.movedAutomatically)
			.map((e) => ({ hash: e.hash, slug: e.slug, from: e.configuredUrl, to: e.url })),
		moved: entries
			.filter((e) => e.movedFrom)
			.map((e) => ({ name: e.name, hash: e.hash, slug: e.slug, from: e.movedFrom, to: e.url })),
		stats: {
			...buildStats(entries, { featuredOnly: true, now }),
			weightHistory: buildWeightHistory(context.weightByDay),
			perfectHistory: buildPerfectHistory(context.perfectDays, entries),
		},
		// What the fleet is built with and hosted on.
		stacks: buildStacks(entries),
		// One perfect score, held for the whole UTC day. Null until something is
		// perfect, which the page treats as no section rather than as an error.
		siteOfTheDay: siteOfTheDay(entries, now),
		coverage: buildCoverage(entries, config),
		generated: new Date().toISOString(),
		// Either source counts — a backfilled history is field data too.
		hasFieldData: entries.some((e) => e.latest?.field || e.fieldHistory?.series?.length),
		cruxEnabled,
		// Whether any site has a Core Web Vitals assessment to show. Templates
		// branch on this rather than on the key, so a build with stored field
		// data still renders it.
		cwvAvailable: entries.some((e) => e.cwv),
	};
}

/**
 * Move sites out of a category when the generator says they no longer belong.
 *
 * A curated list is a record of what was submitted, which drifts from what is
 * true — a site rebuilt on something else is still on the list. A group can
 * declare `requireGenerator: [...ids]` plus an `emeritusGroup` to receive the
 * ones that no longer qualify.
 *
 * The inverse exists too: `rejectGenerator` plus a `rejectGroup`, for a category
 * defined by what a site *used* to be built with. One measuring as that thing
 * again has come back, and leaving it there would state the opposite.
 *
 * Three deliberate choices:
 *
 *  - **Undetected is not disqualifying.** Most static sites emit no generator
 *    tag at all, so `null` proves nothing and those entries stay put. Only a
 *    positively identified *other* generator moves a site.
 *  - **Only the one membership moves.** A site in both this category and the
 *    address book keeps the address book.
 *  - **Nothing stops being measured.** This reshapes presentation only; the
 *    site stays in `config.sites`, which is what lets it come home by itself if
 *    it is ever rebuilt on the original generator.
 *
 * A URL in `config.pinned` — or a site entry with `pinGroup: true` — is exempt
 * from all of it. That is the escape hatch for the cases detection reads
 * correctly and still gets wrong, and it is the only way to make a category
 * change stick against a rule that would otherwise re-apply on every build.
 */
function applyGeneratorRules(entries, config) {
	const moved = [];

	/**
	 * One direction of the rule.
	 *
	 * `keep` decides membership: a site whose detected generator fails the test
	 * does not belong in `groupId` and is moved to `destination`.
	 */
	function reassign(groupId, destination, keep, label) {
		if (!config.groups[destination]) {
			throw new Error(`Group "${groupId}" names ${label} "${destination}", which is not defined.`);
		}

		for (let entry of entries) {
			if (!entry.groups.includes(groupId)) continue;

			// Pinned by hand: this site stays where the config puts it. For the
			// cases detection gets wrong and no amount of measuring will fix — a
			// stale generator tag, a proxy stamping its own, a site that reports
			// one thing and is built with another. See `config.pinned`.
			if (entry.pinGroup) continue;

			// No detection, or nothing we recognize: not evidence of anything.
			const id = entry.generator?.id;
			if (!id || keep(id)) continue;

			entry.groups = entry.groups.filter((g) => g !== groupId);
			if (!entry.groups.includes(destination)) entry.groups.push(destination);

			// `group` and its display names were resolved from the old membership.
			entry.group = entry.groups[0];
			entry.groupName = config.groups[entry.group]?.name || entry.group;
			entry.groupNames = entry.groups.map((g) => config.groups[g]?.name || g);

			moved.push({
				url: entry.url,
				slug: entry.slug,
				from: groupId,
				to: destination,
				generator: entry.generator.name,
			});
		}
	}

	for (let [groupId, group] of Object.entries(config.groups)) {
		// Built with something else, so it has moved on.
		if (group.requireGenerator?.length && group.emeritusGroup) {
			reassign(groupId, group.emeritusGroup, (id) => group.requireGenerator.includes(id), "emeritusGroup");
		}

		// The inverse: this category is for sites that *used* to be built with
		// something. One measuring as that thing again has come back, and saying
		// otherwise would be false.
		//
		// Safe to run alongside the rule above in either order: a site the first
		// rule moves out has a generator the second rule does not accept, so it
		// cannot be bounced back on the same pass.
		if (group.rejectGenerator?.length && group.rejectGroup) {
			reassign(groupId, group.rejectGroup, (id) => !group.rejectGenerator.includes(id), "rejectGroup");
		}
	}

	return moved;
}

/**
 * Mark what a category *claims* built a site, where nothing was detected.
 *
 * Most static sites emit no `meta[name=generator]` at all, so a blank is the
 * ordinary case rather than a suspicious one. A curated list is itself a claim
 * — someone submitted the site as built with a particular thing — and that is
 * worth showing, provided it never passes for a measurement.
 *
 * Three things keep the two apart:
 *
 *  - **Derived every build, never stored.** The moment a site emits a real
 *    generator tag, `entry.generator` fills in and this is simply not set on
 *    the next report. Nothing has to be cleaned up, and a wrong guess cannot
 *    outlive the evidence that contradicts it.
 *  - **Never counted.** `buildStacks` tallies `entry.generator` only, so a
 *    presumption cannot inflate the Built with numbers with guesses.
 *  - **Never qualifying.** `requireGenerator` reads `entry.generator` too, so a
 *    presumed mark cannot keep a site in a category it no longer belongs to.
 */
/**
 * A Lighthouse score on the scale the legacy API used: 0–1, not 0–100.
 *
 * Lighthouse's own report is 0–1 and the original Speedlify passed it through
 * untouched, so the component in the wild renders it as
 * `parseInt(value * 100, 10)`. Handing it our 0–100 number displays 10000.
 *
 * Null rather than 0 when the score is missing, since 0 is a real score and
 * dividing null would produce one.
 */
function legacyScore(value) {
	return typeof value === "number" && Number.isFinite(value) ? value / 100 : null;
}

/**
 * The URLs the original Speedlify published, as literal strings.
 *
 * A frozen snapshot — see the note in the file. The compatibility routes exist
 * to keep embeds deployed against that instance working, and an embed can only
 * exist for a URL that instance published, so this list is the whole set of
 * files worth writing. Publishing our own 1,600 sites there would be 1,600
 * files nothing will ever request.
 */
/*
 * URLs the original Speedlify instance published, so a deployed
 * `<speedlify-score>` pointing here still resolves. Read rather than imported:
 * a new instance served none of them, and `npm run reset` deletes the file — an
 * absent list has to mean "no legacy routes", not a build that will not start.
 */
const LEGACY_API_URLS = new Set(
	(() => {
		try {
			return JSON.parse(fs.readFileSync(new URL("../config/legacy-api-urls.json", import.meta.url), "utf8")).urls;
		} catch {
			return [];
		}
	})(),
);

/**
 * The spellings of a URL the legacy API answers for, each with the hash that
 * spelling produces. Empty for a site the original never published.
 *
 * Both halves of the old API are keyed by the URL as a config wrote it: the
 * filename is `shortHash(url)`, and urls.json looks up `json[url]` as a bare
 * string with no normalizing at all. Our stored URL has had its trailing slash
 * removed, so `https://www.zachleat.com/about` is not the key an embed asks
 * for — the original published `.../about/`, and that is the spelling that has
 * to be matched and published.
 *
 * Both candidate forms are tested against the snapshot rather than assuming
 * which one it used, since it used whichever its config was written with.
 */
function compatUrls(url) {
	const forms = [url];

	try {
		const u = new URL(url);
		if (u.pathname !== "/" && !u.pathname.endsWith("/")) {
			u.pathname = `${u.pathname}/`;
			forms.push(u.toString());
		}
	} catch {
		// Not a URL we can vary — the one form is all there is.
	}

	const seen = new Set();
	return forms
		.filter((form) => LEGACY_API_URLS.has(form))
		.map((form) => ({ url: form, hash: shortHash(form) }))
		.filter(({ hash }) => !seen.has(hash) && seen.add(hash));
}

/**
 * Mark entries whose category is kept off the home page's Perfect Scores board.
 *
 * A category opts out with `excludeFromPerfectScores: true`; membership in any
 * such category is enough. Applied after reclassification, so a site that has
 * just moved between categories is judged on where it ended up.
 */
function flagPerfectScoreExclusions(entries, config) {
	const excluded = new Set(
		Object.entries(config.groups)
			.filter(([, group]) => group.excludeFromPerfectScores)
			.map(([id]) => id),
	);

	for (let entry of entries) {
		entry.excludedFromPerfectScores = (entry.groups || [entry.group]).some((id) => excluded.has(id));
	}
}

/**
 * Which category sets a site's measurement cadence.
 *
 * `freshnessHours` is already resolved onto the site by the config layer, which
 * takes the strictest window across every category it belongs to. That number
 * is the answer; this records who supplied it, so a page can say "once a day,
 * from Developer Tooling" rather than stating a figure with no provenance.
 *
 * Usually one category. It can be several — 11ty.dev is in Developer Tooling
 * and Site Generators, both daily — and then all of them are named, because
 * picking one would imply the others are slower than they are.
 */
function flagCadence(entries, config) {
	for (let entry of entries) {
		const hours = entry.freshnessHours;
		if (typeof hours !== "number") {
			entry.cadenceFrom = [];
			continue;
		}

		entry.cadenceFrom = (entry.groups || [entry.group])
			.filter((id) => (config.groups[id]?.freshnessHours ?? config.freshnessHours) === hours)
			.map((id) => config.groups[id]?.name || id);
	}
}

/**
 * Mark entries whose category asks for the embed snippet on its site pages.
 *
 * Opt-in, unlike `excludeFromPerfectScores` beside it: a category shows the
 * section by setting `showEmbed: true`, and membership in any such category is
 * enough. The asymmetry is deliberate — the snippet invites somebody to publish
 * a live badge for a site they may not own, which is a reasonable thing to
 * offer for a register people submit their own sites to and a strange thing to
 * offer beside a list of companies nobody here speaks for.
 *
 * Applied after reclassification, so a site that has just moved between
 * categories is judged on where it ended up.
 */
function flagEmbeds(entries, config) {
	const shown = new Set(
		Object.entries(config.groups)
			.filter(([, group]) => group.showEmbed === true)
			.map(([id]) => id),
	);

	for (let entry of entries) {
		entry.showEmbed = (entry.groups || [entry.group]).some((id) => shown.has(id));
	}
}

/**
 * Flag sites built with a generator that some category is the register for,
 * but which are not in that category.
 *
 * No new configuration: `requireGenerator` already says "this group is the list
 * of sites built with these things". A site built with one of them and absent
 * from the group is, by that same statement, missing from the list — which for
 * a community-submitted register is a submission nobody has made yet.
 *
 * Detections only. A presumed mark comes *from* the listing, so treating it as
 * evidence here would be circular — and would flag every unlisted site whose
 * generator we never saw.
 */
function flagUnlisted(entries, config) {
	for (let [groupId, group] of Object.entries(config.groups)) {
		if (!group.requireGenerator?.length) continue;

		// Categories that stand in for membership of this register. A site pulled
		// out of the register into a category of its own — starters, say — is
		// still listed upstream; only its presentation moved. Flagging it as
		// missing would be telling you to submit something already submitted.
		const listed = new Set([
			groupId,
			...Object.entries(config.groups)
				.filter(([, other]) => other.listedIn === groupId)
				.map(([id]) => id),
		]);

		for (let entry of entries) {
			if (entry.groups.some((id) => listed.has(id))) continue;

			const id = entry.generator?.id;
			if (!id || !group.requireGenerator.includes(id)) continue;

			entry.unlisted = {
				group: groupId,
				groupName: group.name || groupId,
				generator: entry.generator.name,
			};
		}
	}
}

function applyPresumedGenerators(entries, config) {
	for (let [groupId, group] of Object.entries(config.groups)) {
		if (!group.presumedGenerator) continue;

		const presumed = generatorById(group.presumedGenerator);
		if (!presumed) {
			throw new Error(
				`Group "${groupId}" names presumedGenerator "${group.presumedGenerator}", which is not a known generator.`,
			);
		}

		for (let entry of entries) {
			// A detection always wins, and a site only presumed to be measured is
			// not presumed to be anything.
			if (!entry.groups.includes(groupId) || entry.generator || !entry.latest) continue;
			entry.presumedGenerator = { ...presumed, presumed: true, source: groupId };
		}
	}
}

function buildEntry(site, store, config, now, aliases, context) {
	// Every URL this site has lived at, oldest first.
	const historyUrls = resolveHistoryUrls(site.url, aliases, site.previousUrls);
	const predecessors = historyUrls.slice(0, -1);

	// The whole chartable history in one compact file per URL. Everything below
	// reads from this rather than the archive, which is what keeps build cost
	// independent of how many years of measurements a site has.
	const series = mergeSeries(store, historyUrls);
	const totalCount = historyUrls.reduce((sum, u) => sum + store.count(u), 0);

	// Optionally chart only the tail. The full series is cheap enough that this
	// is a display choice now rather than a memory guard.
	const history = config.historyLimit ? series.slice(-config.historyLimit) : series;

	// Fleet-wide weight history, gathered here because the full series is already
	// loaded. One bucket per day, holding every measurement taken that day.
	for (let point of series) {
		if (point.error || typeof point.total !== "number") continue;
		const day = new Date(point.t).toISOString().slice(0, 10);
		(context.weightByDay[day] ??= []).push(point.total);
	}

	const successPoints = history.filter((p) => !p.error);
	const latestPoint = history[history.length - 1] || null;

	// A category may set its own staleness threshold — thousands of personal
	// sites on a weekly cycle should not all read as overdue against a target
	// meant for a handful of framework home pages.
	const staleAfterHours = site.staleAfterHours ?? config.staleAfterHours;

	// The one full record the report actually needs: newest successful, for the
	// detail panels (third parties, a11y failures, hygiene, resource split).
	//
	// Searched newest URL first across the whole move chain — a site that just
	// changed address has no records under its new URL yet, and falling back to
	// the previous one keeps its detail panels rather than blanking the page.
	const latest = successPoints.length ? latestSuccessAcross(store, historyUrls) : null;

	// The URL the site redirected us to, when it differs from the one we asked
	// for by nothing but a trailing slash. A real move is handled by the redirect
	// machinery instead; this is the small case that machinery ignores.
	const finalUrl = latest?.lab?.finalUrl ?? null;
	const canonicalUrl =
		finalUrl && finalUrl !== site.url && normalizeUrl(finalUrl) === normalizeUrl(site.url)
			? finalUrl
			: null;

	// Redirect state from the newest point, and whether it is confirmed enough
	// to have been learned as an alias.
	//
	// Re-tested against the current normalization rather than trusted as stored,
	// the same way host and generator are. A point recorded before trailing
	// slashes collapsed still carries `/en` -> `/en/` as a move; under today's
	// rule that is one URL, and reading the stored value would keep reporting a
	// site as moving to itself until it happened to be measured again.
	const storedTo = latestPoint?.to || null;
	const redirectTo = storedTo && normalizeUrl(storedTo) !== normalizeUrl(site.url) ? storedTo : null;
	const redirectVerdict = redirectTo ? confirmRedirect(series, { confirmations: config.redirectConfirmations }) : null;

	// A domain landing on a registrar's for-sale page has lapsed, not moved.
	// Retired on sight rather than put through the confirmation process there is
	// nothing to confirm, and every run spent on it measures a parking page and
	// files the numbers under a site that no longer exists.
	const retiredTo = redirectTo && isRetiredDestination(redirectTo) ? redirectTo : null;

	// Read once: the CWV assessment falls back to it when a measurement has no
	// field data of its own.
	const fieldHistory = readFieldHistory(context.resultsDir, site.hash);
	const filmstrip = readFilmstrip(context.resultsDir, site.hash);
	const ownScreenshot = readOwnScreenshot(context.resultsDir, site.hash);

	const lastAt = store.lastMeasuredAt(site.url);
	const ageHours = lastAt === null ? null : (now - lastAt) / 3600000;
	const dataAgeHours = latest ? (now - latest.timestamp) / 3600000 : null;

	// Built before the return so the ranking value below can read it.
	const cwv = coreWebVitals(latest, context.cruxEnabled, fieldHistory);

	// One entry per site, holding the days it was measured and whether it was
	// perfect each time. Turned into a fleet-wide daily count after every site
	// has been read — see buildPerfectHistory, which explains why it cannot be
	// counted a day at a time. Placed here rather than beside the weight loop
	// above because it needs the Core Web Vitals verdict, which is only settled
	// on the line before this one.
	// Recorded for every site and filtered later, by URL. Which sites count
	// toward the board is decided on the finished entries — starters are flagged
	// by flagPerfectScoreExclusions, which runs after this, and archived sites are
	// partitioned out later still. Guessing at either here counted 181 against
	// the headline's 152.
	{
		const failures = coreWebVitalFailures({ cwv });
		const days = [];
		for (let point of series) {
			if (point.error) continue;
			days.push({ day: new Date(point.t).toISOString().slice(0, 10), perfect: pointIsPerfect(point, failures) });
		}
		if (days.length) context.perfectDays.set(site.url, days);
	}

	const trends = {};
	for (let metric of [...SCORES, ...LAB_METRICS, ...WEIGHT_METRICS, ...HEALTH_METRICS]) {
		// Series points are flat, so the metric key is the lookup.
		const t = trend(history, metric.key, metric.key);
		if (t) trends[metric.key] = slimTrend(t, metric);
	}

	for (let metric of FIELD_METRICS) {
		const key = `field-${metric.key}`;
		const t = trend(history, key, metric.key);
		if (t) trends[key] = slimTrend(t, metric);
	}

	const entry = {
		...site,
		// Lighthouse's own screenshots of this site, from the run the numbers
		// came from. Null when nothing has been captured yet.
		filmstrip,
		// Our own pair, from the axe pass: the page as rendered and with scripts
		// disabled. Preferred over the screenshot service wherever it exists,
		// which is every site measured since the pair was introduced.
		ownScreenshot,
		// Whether the page drew anything without its scripts. Null where there is
		// no no-JS capture to judge, which is most of the corpus.
		clientRendered: clientRendered(ownScreenshot),
		// Shown instead of the configured name throughout the site.
		displayUrl: context.displayUrls.get(site.url) || site.url,
		// The site page's path segment. Separate from `hash`, which still keys
		// stored history and the embed API — those must stay stable, this only
		// has to stay readable.
		slug: context.slugs.get(site.url) || site.hash,
		// Only for the compatibility routes — see src/api-compat-*.njk. Not an
		// identifier this project uses for anything of its own.
		// Every filename a deployed <speedlify-score> might ask for.
		//
		// The legacy hash is computed over the URL *as written in a config*, not
		// over our normalized form — the original project did no normalizing. Our
		// `normalizeUrl` strips the trailing slash from a deeper path, so hashing
		// the stored URL produces a name nothing in the wild will ever request:
		// https://www.zachleat.com/about/ is 803cb8c3 out there and 6bd2054c here,
		// and speedlify.dev serves the former and 404s the latter. Root URLs keep
		// their slash and are unaffected, which is why this went unnoticed — the
		// documented example is a root URL.
		//
		// Both forms are emitted rather than guessing which one a given page was
		// generated from. They are a few hundred bytes each and there is no way
		// to ask.
		shortHash: shortHash(site.url),
		compatUrls: compatUrls(site.url),
		// Only what the history table renders. Trends were computed from the
		// full window above and carry their own values, so emitting every point
		// again here would be the same duplication in a second place.
		// Each row's own six circles — see pointBands.
		history: history.slice(-(config.logRows ?? 30)).map((p) => ({ ...p, bands: pointBands(p) })),
		// Points charted vs total on disk — they differ once a site has more
		// history than the window.
		historyCount: history.length,
		totalCount,
		windowed: totalCount > history.length,
		latest,
		// The measurement before `latest`, kept only so the leaderboard can be
		// re-run on it and the rank column can show movement. Null for a site
		// measured just once.
		previous: successPoints.length > 1 ? previousSuccessAcross(store, historyUrls) : null,
		// A site that is currently failing still has a latest *successful*
		// record; showing both keeps a broken site visible instead of frozen at
		// its last good numbers.
		currentlyFailing: Boolean(latestPoint?.error),
		lastError: latestPoint?.error || null,
		consecutiveFailures: latestPoint?.error ? latestPoint.fails || 1 : 0,
		firstMeasured: series[0]?.date || null,
		lastMeasured: latestPoint?.date || null,
		// URL history: where this site used to live, and where it appears to be
		// heading if it is currently redirecting somewhere new.
		previousUrls: predecessors,
		movedFrom: predecessors.length ? predecessors[predecessors.length - 1] : null,
		// True when the config still names an older URL and the move was followed
		// automatically from a confirmed redirect.
		movedAutomatically: Boolean(site.movedAutomatically),
		configuredUrl: site.configuredUrl || site.url,
		moveAt: predecessors.length ? findMoveBoundary(series) : null,
		redirectTo,
		redirectConfirmed: Boolean(redirectVerdict?.confirmed),
		redirectReason: redirectVerdict?.reason || null,
		// Set when the destination is a parking page. Kept on the entry rather
		// than filtered here so buildReport can report what it dropped.
		retiredTo,
		// Which form of the URL the site itself serves.
		//
		// `/en` and `/en/` are one site to us, so we request whichever the config
		// happened to list and let the redirect carry us to the real one. That is
		// the page actually measured, and this is how you can tell which it was —
		// otherwise the redirect would be invisible, having been deliberately
		// suppressed as a non-move.
		canonicalUrl,
		// Age of the last attempt vs age of the data actually being displayed.
		ageHours,
		dataAgeHours,
		stale: ageHours === null || ageHours >= staleAfterHours,
		// Age of the figures actually on screen. Differs from  when the
		// newest attempt failed and the displayed numbers are older than it.
		dataStale: dataAgeHours === null || dataAgeHours >= staleAfterHours,
		neverMeasured: lastAt === null,
		trends,
		// `rows` is the same series with empty weeks merged — see fieldHistoryRows.
		fieldHistory: fieldHistory && { ...fieldHistory, rows: fieldHistoryRows(fieldHistory.series) },
		labVsField: latest ? labVsField(latest, "lcp") : null,
		// Filled in once every entry exists. The baseline is the project-wide
		// median benchmark index, which cannot be known one site at a time.
		environmentDrift: null,
		cwv,

		/*
		 * Page weight split by resource type, as shares of the whole.
		 *
		 * `third-party` is dropped along with `total`. It is not a resource type
		 * but a cross-cutting tally — those bytes are already counted under script
		 * and image and the rest — and on the 1,022 sites where it is non-zero,
		 * including it would push a stacked bar past 100%. The seven real types
		 * sum exactly to the total on every site measured.
		 */
		weightByType: buildWeightBreakdown(latest?.lab?.weight?.byType),
		thirdPartyRows: buildThirdPartyRows(latest?.lab?.thirdParty),
		// Full axe results for the newest successful measurement.
		axe: latest?.axe ?? null,
		// The title of a bot check, when the page we measured was one. Suppresses
		// the screenshot: a picture of Cloudflare's waiting room is not a picture
		// of the site, and showing it implies we saw something we did not.
		interstitial: latest?.axe?.interstitial ?? null,
		// What built the site and who serves it, detected on the same page load.
		//
		// Both are re-derived from what the record stored raw rather than read
		// back as detected, so a new rule (a CDN that stamps its PoP into
		// `server`, a generator we hadn't learned yet) applies to history already
		// on disk instead of only to future runs. Only the meta string is stored,
		// so a detection that came from a DOM mark is kept as it was found.
		generator: reDetectGenerator(latest?.axe?.generator),
		host: latest?.axe?.headers ? detectHost(latest.axe.headers) : (latest?.axe?.host ?? null),

		// The ranking inputs, in the order the leaderboard applies them, so the
		// site can explain why a row sits where it does.
		lighthouseTotal: lighthouseSum({ latest }),
		// Null, never undefined: JSON.stringify drops undefined keys entirely,
		// which would leave the report silently missing a documented field.
		cwvFailures: coreWebVitalFailures({ cwv }) ?? null,
		// Only the ring's color reads this — the count above is what the ranking
		// and every pass/fail check use. See `cwvBand`.
		cwvWorst: coreWebVitalWorst({ cwv }),
		axeViolations: accessibilityViolations({ latest }),
		tiebreaker: round(tiebreakerValue({ latest }), 0),
		tiebreakerWeight: tiebreakerWeight({ latest }),

		// When the generator changed, from the tags recorded per measurement.
		generatorHistory: generatorChanges(series),

		// Every ring green — nothing amber, red or unmeasured across the four
		// Lighthouse categories and axe, and no Core Web Vital failing.
		//
		// A lower bar than `perfect`, deliberately: 90 is green and 100 is
		// perfect. This is the "looks clean at a glance" test, which is what a
		// category too large to read row by row can usefully be filtered to.
		//
		// Core Web Vitals counts as green when it is gray, for the same reason it
		// does in `isPerfect`: most of this corpus is too small for CrUX to
		// sample, and an unknown is not a failure.
		allGreen: allRingsGreen({ latest, cwv }),
	};

	// Decided here rather than re-derived in a template: the home page's
	// leaderboard and the count above it must agree on what perfect means.
	entry.perfect = isPerfect(entry);

	return entry;
}

/**
 * Trim a trend for serialization.
 *
 * `trend()` returns a point per measurement as `{date, timestamp, value}`, and
 * a site has ~26 trends. Serializing that duplicates the entire history 26
 * times — at 120 points per site it is roughly 190 kB per site, which the
 * in-memory version got away with and a JSON artifact does not.
 *
 * Sparklines only ever plot the values, so that is all we keep. The dates are
 * still available on `history`, which is the same series.
 */
function slimTrend(t, metric) {
	return {
		key: t.key,
		// Kept for the sparkline's accessible label. `unit` and `note` are not:
		// they are identical for every site and are emitted once under
		// report.metrics instead of ~26 times per site.
		label: metric.label,
		values: t.points.map((p) => p.value),
		current: t.current,
		previous: t.previous,
		first: t.first,
		min: t.min,
		max: t.max,
		count: t.count,
		vsPrevious: slimDelta(t.vsPrevious),
		sinceFirst: slimDelta(t.sinceFirst),
		lowerIsBetter: t.lowerIsBetter,
		significant: isSignificant(t),
	};
}

/** A delta's `current`/`previous` restate the trend they hang off. */
function slimDelta(d) {
	if (!d) return null;
	return { change: d.change, pct: d.pct, better: d.better, unchanged: d.unchanged };
}

/**
 * Stitch several URLs' series into one chronological history.
 *
 * Each point is tagged with the URL it was measured at, so the report can show
 * where a site changed address rather than letting the step-change look like a
 * performance regression.
 */
function mergeSeries(store, urls) {
	if (urls.length === 1) {
		return store.series(urls[0]).map((p) => ({ ...p, via: urls[0] }));
	}

	const merged = [];
	for (let url of urls) {
		for (let point of store.series(url)) merged.push({ ...point, via: url });
	}

	return merged.sort((a, b) => a.timestamp - b.timestamp);
}

/** Newest successful record across a move chain, current URL first. */
function latestSuccessAcross(store, urls) {
	for (let i = urls.length - 1; i >= 0; i--) {
		const record = store.latestSuccess(urls[i]);
		if (record) return record;
	}
	return null;
}

/**
 * The successful record before the newest, across a move chain.
 *
 * Slightly more than `previousSuccess` on one URL: when a site's newest record
 * is the first at a new address, the one before it lives under the old URL.
 */
function previousSuccessAcross(store, urls) {
	for (let i = urls.length - 1; i >= 0; i--) {
		const previous = store.previousSuccess(urls[i]);
		if (previous) return previous;

		// This URL had exactly one success, so the record before it is the
		// newest one at the address the site moved from.
		if (store.latestSuccess(urls[i])) {
			for (let j = i - 1; j >= 0; j--) {
				const older = store.latestSuccess(urls[j]);
				if (older) return older;
			}
			return null;
		}
	}
	return null;
}

/** The first point measured at the current URL — where the move happened. */
function findMoveBoundary(series) {
	const last = series[series.length - 1]?.via;
	if (!last) return null;

	const first = series.find((p) => p.via === last);
	return first ? first.date : null;
}

/**
 * Core Web Vitals pass/fail.
 *
 * Field data is authoritative — it is the measurement Google actually uses.
 * Stored field data always renders, even if the key is absent from this
 * particular build, because throwing away data we already collected would be
 * worse than a stale label.
 *
 * The lab approximation is only offered when CrUX is configured but this URL
 * lacks coverage (too little Chrome traffic). With no key at all, Core Web
 * Vitals are skipped outright rather than approximated.
 */
function coreWebVitals(latest, cruxEnabled, fieldHistory) {
	if (!latest) return null;

	// 1. Field data captured alongside the measurement itself — freshest.
	if (hasCoreWebVitals(latest.field?.metrics)) {
		return fromField(latest.field.metrics, "field", {
			first: latest.field.collectionPeriod?.first,
			last: latest.field.collectionPeriod?.last,
			scope: latest.field.scope,
		});
	}

	// 2. The newest week of backfilled history that actually has numbers in it.
	//    Same measurement, same shape, fetched by `speedlify backfill` rather
	//    than during a run — so a site measured before the API key existed still
	//    gets a real assessment instead of falling through to the approximation.
	const week = newestCoreWebVitalsWeek(fieldHistory?.series);
	if (week) {
		return fromField(week.metrics, "field-history", {
			first: week.period?.first,
			last: week.date,
			scope: fieldHistory.scope,
		});
	}

	// 3. Only now fall back to approximating from lab timings.
	if (!cruxEnabled) return null;

	const t = latest.lab?.timings;
	if (!t) return null;

	// Lab has no INP, so this is a two-of-three approximation. Labeled as such
	// in the UI so it is never mistaken for the real assessment.
	const parts = [
		{ key: "lcp", value: t.lcp, rating: band(t.lcp, 2500, 4000) },
		{ key: "cls", value: t.cls, rating: band(t.cls, 0.1, 0.25) },
		{ key: "tbt", value: t.tbt, rating: band(t.tbt, 200, 600), proxyFor: "inp" },
	];

	return {
		source: "lab",
		parts,
		pass: parts.every((p) => p.rating === "good"),
		assessed: parts.length,
	};
}

/**
 * How far back the history may be read for a current assessment.
 *
 * CrUX reports a 28-day trailing p75, so a month is the natural unit: within it
 * the newest week with numbers overlaps the period a fresh answer would cover.
 * Past that it is a different quarter's traffic, and labeling it as this
 * site's Core Web Vitals would be a claim about users who have long since been
 * replaced by other users.
 */
const FIELD_HISTORY_MAX_WEEKS = 4;

/**
 * Whether a CrUX metrics object carries any Core Web Vital at all.
 *
 * The object's presence proves nothing. CrUX answers with the full shape and
 * nulls inside it for a site it cannot report on, and it will hand back TTFB
 * and FCP for a site with too few samples to rate LCP, INP or CLS — so
 * `metrics` is truthy, `metrics.lcp` is truthy, and every number under them is
 * null. Reading that as an assessment produced 35 sites on this corpus whose
 * Core Web Vitals were three blanks presented as a measurement, rather than the
 * lab approximation they should have fallen through to.
 */
function hasCoreWebVitals(metrics) {
	return ["lcp", "inp", "cls"].some((key) => metrics?.[key]?.p75 != null);
}

/**
 * The most recent week of history with any Core Web Vital in it.
 *
 * Not simply the last week: CrUX drops a site from a week's dataset when its
 * traffic dips under the reporting threshold, so the newest week is blank for
 * 89 sites here whose earlier weeks are fine. Walking back a bounded distance
 * keeps the 24 of those whose data is merely a fortnight behind, and lets the
 * other 65 — median ten weeks stale — fall through to the lab approximation
 * rather than be reported as current field data.
 */
function newestCoreWebVitalsWeek(series) {
	if (!Array.isArray(series) || !series.length) return null;

	const start = Math.max(0, series.length - FIELD_HISTORY_MAX_WEEKS);
	for (let i = series.length - 1; i >= start; i--) {
		if (hasCoreWebVitals(series[i]?.metrics)) return series[i];
	}

	return null;
}

/** Shape a real CrUX metrics object into a Core Web Vitals assessment. */
function fromField(metrics, source, period) {
	const parts = ["lcp", "inp", "cls"].map((k) => ({
		key: k,
		value: metrics[k]?.p75 ?? null,
		rating: metrics[k]?.rating ?? null,
		distribution: metrics[k]?.distribution ?? null,
		// Set only on a value borrowed from the origin because the page's own
		// dataset was too small to report it — see fillFromOrigin in lib/crux.js.
		// Null means the value is at the record's own scope, which the period
		// beside it already names.
		scope: metrics[k]?.scope ?? null,
	}));

	const rated = parts.filter((p) => p.rating);

	return {
		source,
		period: period || null,
		parts,
		// Which of the three are the whole site's numbers rather than this page's.
		// Read by the pages to label them; empty is the ordinary case.
		borrowed: parts.filter((p) => p.scope === "origin").map((p) => p.key),
		// Null rather than false when nothing was rated — "no data" and "fails"
		// are different claims.
		pass: rated.length ? rated.every((p) => p.rating === "good") : null,
		assessed: rated.length,
	};
}

function band(v, good, poor) {
	if (typeof v !== "number") return null;
	if (v <= good) return "good";
	if (v <= poor) return "needs-improvement";
	return "poor";
}

/**
 * The stored loading filmstrip for a site, as URLs the built site can use.
 *
 * Written by ResultStore.writeFilmstrip from the median Lighthouse run, and
 * replaced whole on each measurement — so this is always the current strip
 * rather than a history of them.
 *
 * The paths point into `results/`, which the build copies through verbatim.
 * Frames are named by a hash of their contents, so they can be cached forever
 * and a re-measure that changes nothing changes no URL.
 */
/**
 * Our own screenshots of a site: as rendered, and with scripts disabled.
 *
 * Both are viewport captures from the axe pass, framed identically, because the
 * only reason to keep the second one is to hold it against the first.
 *
 * Absent for any site not measured since the pair was introduced, which is not
 * a fault — the page falls back to the screenshot service until that site comes
 * round again.
 */
function readOwnScreenshot(resultsDir, hash) {
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(resultsDir, hash, "screenshot.json"), "utf8"));
	} catch {
		return null;
	}

	// The manifest names the file, because the format is the capture's choice
	// rather than ours — WebP today, and the extension has to follow it.
	const slot = (entry) => {
		if (!entry?.file || !fs.existsSync(path.join(resultsDir, hash, entry.file))) return null;
		return {
			src: `/results/${hash}/${entry.file}`,
			width: entry.width ?? null,
			height: entry.height ?? null,
		};
	};

	const shot = slot(manifest);
	if (!shot) return null;

	// The same page with scripts disabled, where that load succeeded. Read on
	// the same manifest because the two are captured together and only mean
	// anything side by side.
	const noJs = slot(manifest.noJs);

	return {
		...shot,
		noJs,
		// Share of pixels JavaScript is responsible for, 0-100. Null unless both
		// images are present: it describes the pair, not either one of them.
		difference: noJs && typeof manifest.difference === "number" ? manifest.difference : null,
		// How much of the no-JS capture is empty rows, 0-100. See `clientRendered`.
		noJsText: noJs && typeof manifest.noJsText === "number" ? manifest.noJsText : null,
	};
}

/*
 * How many sites each generator has that draw nothing without JavaScript.
 *
 * Counts, not a distribution, so this is a tally rather than one of the strip
 * charts above: the question is "how many", and there is no second axis.
 *
 * Both numbers are carried, not just the flagged one. A tool with two flagged
 * sites out of two is a different statement from two out of ninety, and a bar
 * on its own cannot tell them apart. Rows with nothing flagged are kept for the
 * same reason — a tool that renders on the server everywhere is the finding
 * here as much as one that does not.
 *
 * Only sites with a no-JS capture can be judged at all, which is a minority of
 * the corpus and not a random one: it is whichever categories asked for
 * pictures. The section says so rather than implying a census.
 */
function buildClientRenderedByGenerator(entries) {
	const judged = entries.filter((e) => e.clientRendered !== null);
	if (!judged.length) return null;

	const byName = new Map();
	for (let entry of judged) {
		const tool = entry.generator ?? entry.presumedGenerator ?? null;
		// Sites with no generator tag are their own row rather than being dropped.
		// They are the largest group of flagged sites, and silently omitting them
		// would leave a chart claiming a handful of tools account for all of it.
		const name = tool?.name ?? "No generator tag";
		const row = byName.get(name) ?? { name, icon: tool?.icon ?? null, detected: Boolean(tool), flagged: 0, judged: 0 };
		row.judged += 1;
		if (entry.clientRendered) row.flagged += 1;
		byName.set(name, row);
	}

	const rows = [...byName.values()].sort(
		(a, b) => b.flagged - a.flagged || b.judged - a.judged || a.name.localeCompare(b.name),
	);
	const max = Math.max(...rows.map((r) => r.judged));

	return {
		rows: rows.map((r) => ({
			...r,
			// Widths as a share of the biggest row, so the bars compare against
			// each other rather than against the corpus, which is not all here.
			flaggedPct: round((r.flagged / max) * 100, 1),
			judgedPct: round((r.judged / max) * 100, 1),
		})),
		judged: judged.length,
		flagged: judged.filter((e) => e.clientRendered).length,
		tools: rows.filter((r) => r.detected).length,
		withFlagged: rows.filter((r) => r.flagged > 0).length,
	};
}

/*
 * Two measures, because each one alone gets a real site in this corpus wrong.
 *
 * How much of the no-JS capture is text answers "did the page say anything".
 * It is the measure that finally separates the arguable cases: ibm.com and
 * mistral.ai are within a tenth of a percent of each other on empty scanlines
 * — 74.2 against 74.1 — while ibm serves a headline and a paragraph and mistral
 * serves the words "Contact sales". By text rows they are 15.3% and 1.7%.
 *
 * The difference against the rendered capture answers "did running the scripts
 * change it". A page can be textless and still not client-rendered: a splash
 * image, a login wall, a site that is simply sparse. Those score near zero here
 * because JavaScript does nothing visible.
 *
 * Together: the page said nothing, and running the scripts changed that.
 *
 * Both lines fall in gaps rather than crowds. Sites that render nothing sit at
 * 0-1.7% text and the ones that render something start at 5%; x.ai needs the
 * difference floor no higher than 20% and the nearest exclusion is 17.4%.
 */
const CLIENT_RENDERED_MAX_TEXT = 3;
const CLIENT_RENDERED_MIN_DIFFERENCE = 20;

function clientRendered(screenshot) {
	if (!screenshot?.noJs) return null;
	if (typeof screenshot.noJsText !== "number" || typeof screenshot.difference !== "number") return null;

	return (
		screenshot.noJsText <= CLIENT_RENDERED_MAX_TEXT &&
		screenshot.difference >= CLIENT_RENDERED_MIN_DIFFERENCE
	);
}

function readFilmstrip(resultsDir, hash) {
	const file = path.join(resultsDir, hash, "filmstrip.json");
	if (!fs.existsSync(file)) return null;

	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}

	const frames = (manifest.frames || []).filter((f) => f?.file);
	if (!frames.length) return null;

	const src = (name) => `/results/${hash}/frames/${name}`;

	return {
		timestamp: manifest.timestamp ?? null,
		width: manifest.width ?? null,
		height: manifest.height ?? null,
		// How many of the frames differ from each other. A page that paints
		// before the first sample repeats one picture across the whole strip —
		// eight copies of the finished page is not a filmstrip, so the pages use
		// this rather than the frame count to decide whether to draw one.
		distinct: new Set(frames.map((f) => f.file)).size,
		// The finished page. Named in the manifest, but the last frame is the
		// same thing and is the answer if an older manifest lacks the field.
		final: src(manifest.final ?? frames[frames.length - 1].file),
		frames: frames.map((f) => ({ timing: f.timing ?? null, src: src(f.file) })),
	};
}

function readFieldHistory(resultsDir, hash) {
	const file = path.join(resultsDir, hash, "field-history.json");
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * The weekly field history as table rows, with runs of empty weeks collapsed
 * into one row carrying the range they cover.
 *
 * CrUX drops a site from a week's dataset when its traffic dips under the
 * reporting threshold, and a site that sits under it comes back blank for every
 * week at once: 61 sites here have twelve empty weeks running, 137 have a run
 * of two or more. One row per week renders those as a dozen identical rows of
 * five empty pills, which reads as a broken table rather than as an absence of
 * data — and pushes the weeks that do have numbers out of the display window.
 * One row per run says the same thing in a line and dates the gap.
 *
 * A single empty week collapses through the same path; it just has no range to
 * show, so it keeps its own date.
 */
function fieldHistoryRows(series) {
	if (!Array.isArray(series)) return [];

	const rows = [];
	for (const point of series) {
		// Empty by the columns the table shows. A week with a real LCP but no INP
		// is an ordinary row with one blank cell, not a gap — plenty of sites never
		// report INP at all, and folding those into a gap would hide the rest.
		const hasData = FIELD_METRICS.some((m) => point?.metrics?.[m.key]?.p75 != null);
		if (hasData) {
			rows.push({ date: point.date, metrics: point.metrics });
			continue;
		}

		const open = rows[rows.length - 1];
		if (open && !open.metrics) {
			open.to = point.date;
			open.weeks++;
			continue;
		}

		rows.push({ date: point.date, from: point.date, to: point.date, weeks: 1, metrics: null });
	}

	return rows;
}

/**
 * Attach ranks for each headline metric under `field`, so the same entry can
 * carry both its global and its within-group position.
 */
function rankEntries(entries, field, compare) {
	const withValues = entries.filter((e) => e.latest);

	const rankings = {
		performance: rank(withValues, (e) => e.latest.lab?.scores?.performance),
		accessibility: rank(withValues, (e) => e.latest.lab?.scores?.accessibility),
		lcp: rank(withValues, (e) => e.latest.lab?.timings?.lcp, { lowerBetter: true }),
		weight: rank(withValues, (e) => e.latest.lab?.weight?.total, { lowerBetter: true }),
		requests: rank(withValues, (e) => e.latest.lab?.weight?.requests, { lowerBetter: true }),
	};

	// The leaderboard rank: total Lighthouse score, then axe violations, then
	// Speed Index per KB. This is the one the # column shows.
	for (let { entry, rank: position } of rankLeaderboard(withValues, compare)) {
		assignRank(entry, field, "overall", position);
	}

	/*
	 * The same board re-run on everyone's previous measurement, to get the
	 * movement the # column shows.
	 *
	 * Two things this is not. It is not "the board yesterday": sites are
	 * measured on a rolling schedule, so the previous runs are scattered across
	 * different days and no such board was ever displayed. And it is not a
	 * record of past ranks — nothing stores those — it is recomputed each build
	 * from the current ranking rules, so a change to the rules re-scores both
	 * boards and never invents movement out of a rule change.
	 *
	 * What it is: where each site would have placed among these same sites, on
	 * the measurement before its latest. That is the question the column
	 * answers — did this site's own numbers move it — which is why a site with
	 * only one measurement stands in for itself rather than dropping out. A new
	 * arrival shifting everyone below it is churn in the population, not
	 * movement by the sites it displaced, and holding the population fixed keeps
	 * that out of the number.
	 *
	 * Core Web Vitals are the one input carried forward rather than rewound:
	 * they are field data attached to the site, not to a run. CrUX is a 28-day
	 * rolling average, so it barely moves between two runs, and holding it equal
	 * on both boards keeps the movement attributable to what was re-measured.
	 */
	const shadowOf = new Map();
	const previousBoard = withValues.map((e) => {
		const shadow = e.previous ? { ...e, latest: e.previous } : e;
		shadowOf.set(shadow, e);
		return shadow;
	});

	for (let { entry: shadow, rank: position } of rankLeaderboard(previousBoard, compare)) {
		const entry = shadowOf.get(shadow);
		assignRank(entry, field, "overallPrevious", position);
	}

	// Positive is a climb: rank 9 to rank 4 reads as +5.
	for (let entry of withValues) {
		const [scope, groupId] = field.split(":");
		const ranks = groupId ? entry[scope][groupId] : entry[scope];
		ranks.overallChange = entry.previous ? ranks.overallPrevious - ranks.overall : null;
		ranks.overallClimb = rankClimb(entry, ranks.overallChange);
	}

	for (let [metric, ranked] of Object.entries(rankings)) {
		for (let { entry, rank: position } of ranked) {
			assignRank(entry, field, metric, position);
		}
	}

	return entries;
}

/**
 * Row order is the leaderboard order, so the position of a row and the rank
 * printed on it can never disagree.
 */
function sortByLeaderboard(entries, compare) {
	return [...entries].sort(compare);
}

function findOrphans(entries, store, resultsDir) {
	// Every configured URL — retired ones included, since they are configured —
	// and every predecessor whose history is now stitched into one of them.
	const known = new Set();
	for (let entry of entries) {
		known.add(entry.hash);
		for (let previous of entry.previousUrls) known.add(urlHash(previous));
	}

	return store
		.hashes()
		.filter((h) => !known.has(h))
		.map((hash) => {
			const metaFile = path.join(resultsDir, hash, "meta.json");
			if (!fs.existsSync(metaFile)) return { hash, url: null, name: hash };
			try {
				return { hash, ...JSON.parse(fs.readFileSync(metaFile, "utf8")) };
			} catch {
				return { hash, url: null, name: hash };
			}
		});
}

/**
 * Coverage — how complete and how current the picture is.
 *
 * With rolling measurement the report is always a snapshot of an uneven
 * dataset: some sites measured minutes ago, some days ago, some never. Stating
 * that plainly is the difference between a dashboard you can trust and one
 * that quietly implies everything was measured together.
 */
function buildCoverage(entries, config) {
	const ages = entries.map((e) => e.ageHours).filter((n) => typeof n === "number");
	ages.sort((a, b) => a - b);

	return {
		total: entries.length,
		measured: entries.filter((e) => !e.neverMeasured).length,
		never: entries.filter((e) => e.neverMeasured).length,
		stale: entries.filter((e) => e.stale && !e.neverMeasured).length,
		failing: entries.filter((e) => e.currentlyFailing).length,
		staleAfterHours: config.staleAfterHours,
		// Median beats mean here: one site stuck at 400h shouldn't characterise
		// the other 999.
		medianAgeHours: ages.length ? round(ages[Math.floor(ages.length / 2)], 1) : null,
		oldestAgeHours: ages.length ? round(ages[ages.length - 1], 1) : null,
		newestAgeHours: ages.length ? round(ages[0], 1) : null,
	};
}

function round(v, places) {
	if (typeof v !== "number" || !Number.isFinite(v)) return null;
	const f = 10 ** places;
	return Math.round(v * f) / f;
}

/**
 * Re-run generator detection over what a stored record kept.
 *
 * Records keep the raw `meta[name=generator]` string alongside the detection,
 * so a rule added after the fact can be applied to data already on disk. A
 * detection that came from a DOM mark has nothing raw to re-read, and is passed
 * through untouched.
 */
/*
 * The six rings as bands alone, in the order the pages draw them — four
 * Lighthouse categories, then axe, then Core Web Vitals.
 *
 * Enough to color a dot and nothing more: a row of these is a glance, and the
 * numbers behind them are one click away on the site's own page. Shared, so the
 * two lists in the Recently Measured card cannot end up drawing their dots from
 * different rules.
 */
/**
 * The same six circles, for one measurement in the log.
 *
 * `ringBands` reads an entry, which is the newest measurement plus field data
 * attached to the site. A log row is a single run, so its circles have to come
 * from the point itself — otherwise every row would show today's verdict and
 * the column would say nothing that the row above it did not.
 *
 * Core Web Vitals are the exception, and are read from the point's own stored
 * p75 figures where it has them. CrUX is a 28-day rolling average, so those
 * move slowly and a row's vitals are genuinely the vitals of that week.
 *
 * A point with no field figures shows an unknown vital rather than borrowing
 * the site's current one: absence is the honest answer for a run taken before
 * CrUX had a sample.
 */
function pointBands(point) {
	const vitals = [
		["field-lcp", 2500, 4000],
		["field-inp", 200, 500],
		["field-cls", 0.1, 0.25],
	];

	const rated = vitals.filter(([key]) => typeof point[key] === "number");
	const failing = rated.filter(([key, good]) => point[key] > good).length;

	return [
		...SCORES.map((score) => scoreBand(point[score.key])),
		axeBand(typeof point.axeViolations === "number" ? point.axeViolations : null),
		rated.length ? cwvBand(failing) : "none",
	];
}

function ringBands(entry) {
	return [
		...SCORES.map((score) => scoreBand(entry.latest?.lab?.scores?.[score.key])),
		axeBand(entry.axeViolations),
		cwvBand(entry.cwvFailures, entry.cwvWorst ?? "poor"),
	];
}

/*
 * Axe violations per site, banded as the ring is: clean, a handful, or more.
 *
 * No perfect/good split here. Zero violations is the only passing state axe has
 * — there is no "green but short of full marks" — so the bar that is stacked on
 * the performance chart is a single block on this one.
 */
function axeTiers(measured) {
	const tally = { good: 0, warn: 0, bad: 0 };
	let unknown = 0;

	for (const entry of measured) {
		const band = axeBand(entry.axeViolations);
		if (band === "none") unknown++;
		else if (band === "good") tally.good++;
		else if (band === "average") tally.warn++;
		else tally.bad++;
	}

	const rated = tally.good + tally.warn + tally.bad;
	const pct = (n) => Math.round((n / (rated || 1)) * 1000) / 10;
	return {
		rated,
		unknown,
		total: rated + unknown,
		bars: [
			{ key: "good", tick: "Good", label: "No violations", count: tally.good, share: pct(tally.good) },
			{ key: "warn", tick: "Warn", label: `1 to ${AXE_BAND_AVERAGE} violations`, count: tally.warn, share: pct(tally.warn) },
			{ key: "bad", tick: "Bad", label: `More than ${AXE_BAND_AVERAGE} violations`, count: tally.bad, share: pct(tally.bad) },
		],
	};
}

/*
 * Every site's Lighthouse performance score, banded.
 *
 * One circle per site rather than all six. Counting every ring mixed four
 * different questions into one distribution — an SEO score and a Core Web Vitals
 * verdict are not comparable quantities — and the resulting shape was dominated
 * by the categories most sites pass easily. Performance alone is the one people
 * come here to read, and its spread is the one worth showing.
 *
 * `perfect` is a straight 100; `good` is Lighthouse's own green short of that,
 * which is 90 to 99. Sites with no score are counted apart and named under the
 * chart rather than drawn, so the bars divide the sites that have one.
 */
function performanceTiers(measured) {
	const tally = { perfect: 0, good: 0, warn: 0, bad: 0 };
	let unknown = 0;

	for (const entry of measured) {
		const value = entry.latest?.lab?.scores?.performance;
		const band = scoreBand(value);
		if (band === "none") {
			unknown++;
		} else if (band === "good") {
			if (value === 100) tally.perfect++;
			else tally.good++;
		} else if (band === "average") {
			tally.warn++;
		} else {
			tally.bad++;
		}
	}

	const rated = tally.perfect + tally.good + tally.warn + tally.bad;
	const pct = (n, of) => Math.round((n / (of || 1)) * 1000) / 10;
	const green = tally.perfect + tally.good;

	return {
		rated,
		unknown,
		total: rated + unknown,
		bars: [
			{
				key: "green",
				tick: "Good",
				label: "90 or better",
				count: green,
				segments: [
					{ key: "perfect", label: "A straight 100", count: tally.perfect, height: pct(tally.perfect, green) },
					{ key: "good", label: "90 to 99", count: tally.good, height: pct(tally.good, green) },
				],
			},
			{ key: "warn", label: "50 to 89", tick: "Warn", count: tally.warn },
			{ key: "bad", label: "Below 50", tick: "Bad", count: tally.bad },
		].map((b) => ({ ...b, share: pct(b.count, rated) })),
	};
}

/**
 * Is every ring on this row green?
 *
 * Reads the same banding the rings are drawn from, so the answer and the
 * picture cannot disagree.
 */
function allRingsGreen({ latest, cwv }) {
	if (!latest?.lab?.scores) return false;

	for (let { key } of SCORES) {
		if (scoreBand(latest.lab.scores[key]) !== "good") return false;
	}

	if (axeBand(accessibilityViolations({ latest })) !== "good") return false;

	// Green or gray. `cwvBand` returns "none" when CrUX has no sample.
	return cwvBand(coreWebVitalFailures({ cwv })) !== "poor";
}

/**
 * The points at which a site's generator tag changed, oldest first.
 *
 * Read out of the series rather than remembered when a category reassignment
 * happens, which is the other way this could work and the worse one. A stored
 * "moved to Emeritus on Tuesday" records when *we noticed*: it depends on when
 * the site happened to come up in a rolling schedule, it would be wrong for
 * everything measured before the feature existed, and re-running the report
 * could not correct it. The series says when the site actually changed, to
 * within one measurement, and a detection rule added later re-reads the same
 * stored tags and gets a better answer.
 *
 * Each entry is the first measurement to report the new generator, with the one
 * it replaced. Sites that never emit a tag — most of them — produce nothing,
 * which is correct: no tag is not a change.
 */
function generatorChanges(series) {
	const changes = [];
	let previous;

	for (let point of series) {
		// Only measurements that carried a tag. A run that failed, or a page that
		// dropped the tag for one measurement, must not read as a migration.
		if (!point.gen) continue;

		const detected = detectGenerator({ meta: point.gen });
		const id = detected?.id ?? point.gen;

		if (previous !== undefined && id !== previous.id) {
			changes.push({
				date: new Date(point.t).toISOString(),
				from: previous.name,
				fromId: previous.id,
				to: detected?.name ?? point.gen,
				toId: detected?.id ?? null,
				// Whether this is the move the Emeritus category is about.
				leftEleventy: ELEVENTY_IDS.has(previous.id) && !ELEVENTY_IDS.has(id),
				returnedToEleventy: !ELEVENTY_IDS.has(previous.id) && ELEVENTY_IDS.has(id),
			});
		}

		previous = { id, name: detected?.name ?? point.gen };
	}

	return changes;
}

function reDetectGenerator(stored) {
	if (!stored) return null;
	if (!stored.raw) return stored;
	return detectGenerator({ meta: stored.raw }) ?? stored;
}

/**
 * Tally detected generators and hosts across every measured site.
 *
 * Counted from the newest successful measurement of each, so a site is one
 * vote regardless of how many times it has been measured or how many
 * categories it appears in. `unknown` is the sites measured but with nothing
 * detected — kept visible so the percentages are honest about their base.
 */
function buildStacks(entries) {
	const tally = (pick, iconOf) => {
		const counts = new Map();
		let unknown = 0;

		for (let entry of entries) {
			if (!entry.latest) continue;

			const detected = pick(entry);
			if (!detected?.name) {
				unknown++;
				continue;
			}

			const existing = counts.get(detected.name);
			if (existing) existing.count++;
			else counts.set(detected.name, { name: detected.name, icon: iconOf(detected), count: 1 });
		}

		const all = [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
		const detectedTotal = all.reduce((sum, i) => sum + i.count, 0);

		/*
		 * One site running something nobody else runs, with no brand mark to
		 * recognize it by, is a row of noise in a summary — `build.lua`, `blag`
		 * and `x-log` are one person's own generator. Two sites is a pattern and
		 * earns its row. They stay in `detected` either way: they were detected,
		 * and the totals have to keep adding up.
		 *
		 * Two conditions on doing it at all, both learned from small categories,
		 * where the rule read as a bug:
		 *
		 * Folding one name saves no space. "…and 1 one-off" takes the row the
		 * name would have taken and says less, so Zola and Lume were being hidden
		 * to no purpose.
		 *
		 * And when nothing in the list has more than one site, `icon || count > 1`
		 * is just `icon` — the list then sorts by whether we happen to ship a
		 * brand mark, which is a fact about our icons and not about the sites. A
		 * category where every generator appears once has no noise tier to
		 * separate out, so nothing is separated.
		 */
		const oneOffs = all.filter((i) => !i.icon && i.count === 1);
		const fold = oneOffs.length > 1 && all.some((i) => i.count > 1);
		const items = fold ? all.filter((i) => i.icon || i.count > 1) : all;
		const rare = fold ? oneOffs : [];

		return {
			items,
			// What the list is not showing, so the page can say so rather than
			// quietly disagreeing with its own count.
			rare: rare.length,
			rareNames: rare.map((i) => i.name),
			detected: detectedTotal,
			unknown,
			distinct: all.length,
		};
	};

	return {
		generators: tally((e) => e.generator, (d) => d.icon ?? null),
		hosts: tally((e) => e.host, (d) => d.icon ?? null),
		eleventyVersions: eleventyVersions(entries),
	};
}

/**
 * How many sites run which major version of Eleventy.
 *
 * Both names count as one project: "Build Awesome" is Eleventy's newer
 * branding, and the point of this is the upgrade curve, not the rename — a
 * site on v4 is on v4 whichever word its generator tag uses.
 *
 * Major only. The exact versions run to dozens of rows with a long tail of one
 * site each, and nobody is asking whether more sites run 3.1.0 than 3.1.5; the
 * question a histogram answers here is how far along the fleet is.
 *
 * Sites that say Eleventy but no version are counted separately rather than
 * dropped, so the bars and the total do not quietly disagree. Two thirds of a
 * corpus this size emit no version at all, and hiding that would overstate how
 * much the bars represent.
 */
function eleventyVersions(entries) {
	const counts = new Map();
	let unversioned = 0;
	let total = 0;
	// Every site with a measurement, Eleventy or not. The heading counts against
	// this rather than against the Eleventy sites alone, so it means the same
	// thing as the "detected" beside it on the tally next door — a card reading
	// "10 of 10" while the category holds eleven sites reads as completeness,
	// and the eleventh site is exactly the one the reader is looking for.
	let measured = 0;

	for (let entry of entries) {
		if (!entry.latest) continue;
		measured++;
		if (!ELEVENTY_IDS.has(entry.generator?.id)) continue;
		total++;

		const major = Number.parseInt(entry.generator.version ?? "", 10);
		if (!Number.isFinite(major)) {
			unversioned++;
			continue;
		}

		counts.set(major, (counts.get(major) ?? 0) + 1);
	}

	const versioned = total - unversioned;
	const items = [...counts.entries()]
		.sort((a, b) => b[0] - a[0])
		.map(([major, count]) => ({
			major,
			label: `v${major}`,
			count,
			// Of the sites that told us, which is what the bars are drawn from.
			share: versioned ? count / versioned : 0,
		}));

	return {
		items,
		versioned,
		unversioned,
		total,
		measured,
		// The two marks this counts as one project, newer name first. Resolved
		// from the generator list rather than named again in a template — two
		// places to edit is how a rename ends up half-applied.
		marks: ["build-awesome", "eleventy"].map(generatorById).filter(Boolean),
	};
}

/**
 * The lower of the two middle values on an even count, rather than their mean.
 *
 * The textbook median of an even set is the mean of the pair, which here
 * produces figures no site can have: 90 Emeritus sites with 91 and 92 in the
 * middle gave "91.5", a Lighthouse score that does not exist, drawn in a ring
 * that otherwise always shows a real one. Same for "4.5 violations".
 *
 * Taking the lower keeps the figure to something actually observed, and errs
 * toward the worse of the two — the right direction for a summary of a fleet.
 */
function median(values) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length / 2) - 1];
}

/**
 * The arithmetic mean, rounded to a whole number.
 *
 * Rounded because these are drawn inside rings that otherwise always show a
 * real score, and because the extra digits are false precision: the difference
 * between 90.26 and 90.3 says nothing about a fleet whose members are measured
 * on a rolling schedule. The unrounded figure survives in the ring's label.
 */
function mean(values) {
	if (!values.length) return null;
	return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * One reducer applied down each of the six ring columns, across everything
 * measured.
 *
 * Six separate medians, not one site: no site necessarily has this combination,
 * and the row is a summary of the fleet rather than a portrait of a typical
 * member. That is the honest reading of "the median of each" and it is also the
 * only one available — there is no ordering of sites that makes all six medians
 * land on the same row.
 *
 * The median rather than the mean, which is what this replaces. Scores here are
 * piled against the ceiling — three of the four categories sit at 100 for more
 * than half the fleet — and a mean of that distribution reports a number almost
 * nobody has, dragged down by a long tail. The median says what the middle site
 * actually scores.
 *
 * Each column drops its own missing values rather than counting them as zero: a
 * site axe never ran on is not a site with no violations, and — the big one —
 * only the sites CrUX has data for can have a Core Web Vitals median at all.
 * The counts come along so the page can say how many each figure rests on.
 */
function ringStats(measured, reduce) {
	const column = (pick) => measured.map(pick).filter((v) => typeof v === "number" && Number.isFinite(v));

	const scores = Object.fromEntries(
		SCORES.map(({ key }) => [key, column((e) => e.latest.lab?.scores?.[key])]),
	);
	const axe = column((e) => e.axeViolations);
	const cwv = column((e) => e.cwvFailures);

	return {
		scores: Object.fromEntries(Object.entries(scores).map(([key, values]) => [key, reduce(values)])),
		axe: reduce(axe),
		cwvFailures: reduce(cwv),
		// How many sites each figure is drawn from. The Core Web Vitals one is
		// far smaller than the rest and saying so is the difference between a
		// summary and a claim.
		counts: {
			scores: scores[SCORES[0].key].length,
			axe: axe.length,
			cwv: cwv.length,
		},
	};
}

/**
 * Full marks in every Lighthouse category.
 *
 * Derived rather than hardcoded to 400, so adding or removing a category cannot
 * leave this quietly counting a bar nothing can reach.
 */
const PERFECT_TOTAL = SCORES.length * 100;

/**
 * Full marks in every Lighthouse category, a clean axe run, and no Core Web
 * Vital failing for real users.
 *
 * One predicate rather than the condition written out at each call site: the
 * home page's leaderboard filters on the same rule, and a definition of
 * "perfect" that drifts between the count and the table it heads is worse than
 * either definition on its own.
 *
 * The two tiebreakers treat a missing measurement differently, deliberately.
 * Axe runs on every measurement we take, so a null there means the run failed
 * and the site is unchecked — not perfect. CrUX only reports sites with enough
 * traffic to sample, so a null there says nothing about the site at all, and
 * demanding a number would disqualify most of this corpus for being small
 * rather than slow. Green or gray passes for Core Web Vitals; amber and red do
 * not.
 */
/**
 * Perfect, and eligible to be shown as such on the home page.
 *
 * The count in the stat tile and the rows in the board underneath it are the
 * same claim, so they filter on the same predicate — a tile reading 50 above a
 * table of 30 rows is a bug report waiting to be filed.
 */
const isPerfectFeatured = (entry) => isPerfect(entry) && !entry.excludedFromPerfectScores;

/**
 * One perfect site, the same one all day, chosen without anything to store.
 *
 * The site is rebuilt every hour, so a plain random pick would change on every
 * publish and "of the day" would be a lie. Seeding from the calendar date fixes
 * it for the day and moves it at midnight UTC — the same clock the measurement
 * schedule runs on — with no state, no file to write and nothing to keep in
 * sync across the four shards.
 *
 * Highest hash of `date + url` wins, rather than indexing at `hash(date) %
 * length`. With a modulo, a site entering or leaving the perfect list — which
 * happens continuously, since it is decided by live measurements — shifts every
 * index and can change the pick mid-afternoon. Here a newcomer only takes the
 * day if it out-hashes the current holder, which is a 1-in-n chance rather than
 * a certainty, and the rest of the list is unaffected.
 */
function siteOfTheDay(entries, now) {
	// Never a site behind a bot check: the card is mostly a screenshot, and that
	// screenshot would be a waiting room.
	const featured = entries.filter((e) => isPerfectFeatured(e) && !e.interstitial);
	if (!featured.length) return null;

	// UTC, so the day turns at the same moment for every reader and for CI.
	const day = new Date(now).toISOString().slice(0, 10);

	const chosen = selectSiteOfTheDay(featured, day);
	if (!chosen) return null;

	// Every eligible site is featured once before any repeats. Derived rather
	// than stored — see lib/site-of-the-day.js.
	return { date: day, ...chosen };
}

const isPerfect = (entry) =>
	entry.lighthouseTotal === PERFECT_TOTAL && entry.axeViolations === 0 && !(entry.cwvFailures > 0);

/** Eleventy under either name — the project is mid-rename to Build Awesome. */
const ELEVENTY_IDS = new Set(["eleventy", "build-awesome"]);

/**
 * Average page weight per day, across everything measured that day.
 *
 * Withheld until there are `MIN_WEIGHT_HISTORY_DAYS` of them. A handful of days
 * is not a trend: the fleet is measured on a rolling schedule, so each day's
 * average is drawn from whichever slice happened to come up, and over a short
 * window that composition moves the line far more than the sites do. Given
 * enough days the sampling evens out and the shape means something.
 */
const MIN_WEIGHT_HISTORY_DAYS = 14;

/**
 * Whether one stored measurement was a perfect score.
 *
 * Lighthouse and axe come from the point itself, which is what makes this a
 * history: full marks in every category and a clean run, as they stood that
 * day.
 *
 * Core Web Vitals do not, and cannot. The series carries a point's `field-*`
 * values only when CrUX was sampled during that run, so most points have none —
 * and reading their absence as "not failing" counted 181 sites perfect against
 * the headline's 152, a fifth too many. The entry's current verdict is used for
 * every one of its points instead. That is defensible rather than a fudge: CrUX
 * reports a 28-day trailing window, so the figure barely moves across a history
 * this short, and the alternative is a line that disagrees with the number
 * printed beside it.
 */
function pointIsPerfect(point, cwvFailures) {
	if (cwvFailures > 0) return false;

	const total = SCORES.reduce((sum, { key }) => sum + (typeof point[key] === "number" ? point[key] : NaN), 0);
	return total === PERFECT_TOTAL && point.axeViolations === 0;
}

/**
 * How many sites were perfect on each day.
 *
 * Not "how many of the sites measured that day were perfect" — measurement is
 * rolling, so each day sees roughly a thousand of the fifteen hundred sites,
 * and that number would rise and fall with which slice came up rather than with
 * anything about the sites. This carries each site's last known verdict forward
 * until it is measured again, which is the same rule the headline count uses:
 * every site, judged on its most recent measurement.
 *
 * Withheld under the same minimum as the weight history — a handful of days is
 * not a trend.
 */
function buildPerfectHistory(perfectDays, entries) {
	// Only sites that count toward the board: in `entries` at all — which rules
	// out archived and orphaned — and not excluded as a starter.
	const eligible = entries
		.filter((e) => !e.excludedFromPerfectScores && perfectDays.has(e.url))
		.map((e) => perfectDays.get(e.url));

	const days = new Set();
	for (let site of eligible) for (let { day } of site) days.add(day);

	const ordered = [...days].sort();
	if (ordered.length < MIN_WEIGHT_HISTORY_DAYS) return [];

	// Each site's verdict as of each day, then swept forward together.
	const latest = eligible.map((site) => {
		const byDay = new Map();
		for (let { day, perfect } of site) byDay.set(day, perfect);
		return byDay;
	});

	const known = new Array(latest.length).fill(null);

	return ordered.map((date) => {
		let count = 0;
		for (let i = 0; i < latest.length; i++) {
			if (latest[i].has(date)) known[i] = latest[i].get(date);
			if (known[i]) count++;
		}
		return { date, perfect: count };
	});
}

function buildWeightHistory(weightByDay) {
	const days = Object.keys(weightByDay).sort();
	if (days.length < MIN_WEIGHT_HISTORY_DAYS) return [];

	return days.map((date) => {
		const values = weightByDay[date];
		return {
			date,
			avgWeight: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
			sites: values.length,
		};
	});
}

/**
 * The figures behind a stat bar, for any set of entries.
 *
 * `featuredOnly` is the home page's rule and only the home page's: categories
 * that opt out of the Perfect Scores board still have perfect sites, and a
 * starters page reading "0 perfect" when a third of it is perfect would be
 * describing a presentation choice as a fact about the sites.
 */
/**
 * Durations a person would choose for an axis, in milliseconds.
 *
 * 2500 and 4000 are in here deliberately: they are Google's good and poor
 * boundaries for LCP, so a window that spans them puts the thresholds on the
 * axis instead of hiding them inside a bar.
 */
const TIME_LADDER = [250, 500, 1e3, 1500, 2e3, 2500, 4e3, 6e3, 10e3, 15e3, 30e3, 60e3, 120e3];

/**
 * The two scales these histograms come in.
 *
 * A scale is a ladder of round values plus the two ways of naming one: the
 * short form under a bar, and the long form in its tooltip.
 */
const SCALES = {
	bytes: {
		ladder: [1e3, 2.5e3, 5e3, 10e3, 25e3, 50e3, 100e3, 250e3, 500e3, 1e6, 2.5e6, 5e6, 10e6, 25e6, 50e6, 100e6],
		tick: (v) => (v >= 1e6 ? `${Math.round((v / 1e6) * 10) / 10}M` : `${Math.round(v / 1e3)}k`),
		name: (v) => (v >= 1e6 ? `${Math.round((v / 1e6) * 10) / 10} MB` : `${Math.round(v / 1e3)} kB`),
	},
	ms: {
		ladder: TIME_LADDER,
		tick: (v) => (v >= 1e3 ? `${Math.round((v / 1e3) * 10) / 10}s` : `${v}ms`),
		name: (v) => (v >= 1e3 ? `${Math.round((v / 1e3) * 100) / 100} s` : `${v} ms`),
	},
};

/** Human bucket label from a pair of edges. */
function ladderLabel(floor, max, name) {
	if (max === Infinity) return `Over ${name(floor)}`;
	if (floor === 0) return `Under ${name(max)}`;
	return `${name(floor)}–${name(max)}`;
}

/**
 * Bucket edges chosen from the data rather than fixed.
 *
 * Fixed edges only work for one distribution, and these histograms are drawn
 * per category as well as for the fleet. On the fleet's 1,400 sites a scale
 * running to 5 MB is right; on Web Hosts it put 18 of 20 in the final bucket,
 * and on zachleat.com all eleven landed in a single bar. Neither said anything.
 *
 * The window is anchored on the 90th percentile, not the maximum: one 58 MB
 * outlier would otherwise stretch the axis until every real site sat in the
 * first bar, which is the same failure in the other direction.
 *
 * `zeroBucket` gives values of zero a bar of their own. JavaScript wants it —
 * 298 sites ship none, and that is a different statement from "a little" — and
 * page weight does not, since every page has bytes.
 */
function scaleBuckets(values, { zeroBucket = false, scale = "bytes" } = {}) {
	if (!values.length) return [];

	const { ladder, tick, name } = SCALES[scale];
	const rungs = zeroBucket ? 5 : 6;
	const sorted = [...values].filter((v) => v > 0).sort((a, b) => a - b);
	const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : 0;

	// The lowest rung that still covers the 90th percentile, then the ones below
	// it. Clamped at both ends so a tiny or a huge category still gets a window.
	let top = ladder.findIndex((v) => v >= p90);
	if (top === -1) top = ladder.length - 1;
	const first = Math.max(0, Math.min(top - rungs + 1, ladder.length - rungs));
	const edges = ladder.slice(first, first + rungs);

	const buckets = [];
	if (zeroBucket) buckets.push({ max: 1, label: "None", tick: "0" });

	let floor = zeroBucket ? 1 : 0;
	for (let edge of edges) {
		buckets.push({
			max: edge,
			label: ladderLabel(zeroBucket && floor === 1 ? 0 : floor, edge, name),
			tick: tick(edge),
		});
		floor = edge;
	}
	buckets.push({ max: Infinity, label: ladderLabel(floor, Infinity, name), tick: "+" });

	return buckets;
}

/** Count values into a bucket list, with the share each holds. */
function bucketize(values, buckets) {
	if (!values.length) return [];

	let floor = 0;
	return buckets.map((bucket) => {
		const count = values.filter((v) => v >= floor && v < bucket.max).length;
		floor = bucket.max;
		return {
			label: bucket.label,
			tick: bucket.tick,
			count,
			share: Math.round((count / values.length) * 1000) / 10,
		};
	});
}

/**
 * Tally what built a set of sites, commonest first.
 *
 * Detected generator first, then the category's presumption — the same order
 * the pages use, so a site is attributed here exactly as its own row shows it.
 * Sites with neither are counted together at the end rather than dropped: a
 * perfect score with no generator tag is still a perfect score, and omitting it
 * would make the rows fail to sum to the total beside them.
 */
function perfectGenerators(entries) {
	const tally = new Map();

	for (let entry of entries) {
		const generator = entry.generator ?? entry.presumedGenerator ?? null;
		// Eleventy and Build Awesome are one project under two names, counted
		// together everywhere else on this site — see ELEVENTY_IDS. Two rows here
		// would split the same thing in half and let a third project outrank it.
		const united = generator && ELEVENTY_IDS.has(generator.id);
		const key = united ? "eleventy" : (generator?.id ?? null);

		// Canonical marks, not this entry's detection — a detected generator
		// carries the version it was found at, and the shortcode puts that in the
		// icon's label. A tally row would then claim the whole group runs whatever
		// version the first site in it happened to have.
		//
		// Newer name first, matching the Technology section's own pair.
		const marks = united
			? ["build-awesome", "eleventy"].map(generatorById).filter(Boolean)
			: [key ? generatorById(key) : null].filter(Boolean);

		const row = tally.get(key) ?? {
			id: key,
			// "None" rather than a sentence: this is a row in a two-column tally, and
			// the page italicises it to mark the absence of a value rather than the
			// name of one.
			name: united ? "Build Awesome" : (generator?.name ?? "None"),
			marks,
			count: 0,
		};
		row.count++;
		tally.set(key, row);
	}

	return [...tally.values()].sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
}

/**
 * How many recent measurements the summary lists.
 *
 * Fourteen. The cards in the bar stretch to the tallest of them, so this number
 * sets the height of the whole row — which is the reason it is a constant with a
 * note rather than a figure someone raises without noticing what it costs.
 */
const RECENTLY_MEASURED = 12;

/*
 * The same list on /runs/, at the length a page can hold.
 *
 * The stat bar's card is one column in a scrolling row and shows a dozen; this
 * page is about the measurement loop itself, so it can afford to show most of a
 * day's work. Sixty is roughly what the rolling schedule gets through between
 * builds, which makes the list read as "what just happened" rather than as an
 * arbitrary top slice.
 */
const RECENTLY_MEASURED_LONG = 60;

/*
 * How far back a site can have turned perfect and still be called "newly".
 *
 * A window rather than a count: the list is uncapped, so its length is however
 * many sites qualify, and something has to keep a good week from filling the
 * card. A count did that by silently dropping the oldest qualifier, which meant
 * a site could turn green and never appear at all. A window drops sites only
 * once they stop being news, and every site gets its turn on the way.
 */
const NEWLY_PERFECT_WINDOW_HOURS = 48;

function buildStats(entries, { featuredOnly = false, now = Date.now() } = {}) {
	const perfect = featuredOnly ? isPerfectFeatured : isPerfect;

	


	const measured = entries.filter((e) => e.latest);

	/*
	 * Sites whose latest run is perfect and whose run before it was not.
	 *
	 * A transition rather than a state: the headline above counts how many
	 * sites are perfect, which barely moves, while this says which ones just
	 * got there. It is the only thing on this bar that reports a change a
	 * person made rather than a level the corpus sits at.
	 *
	 * Judged on the same `perfect` predicate as the headline so a site cannot
	 * appear here without being counted there, and on `pointIsPerfect` for the
	 * previous run — the stored point carries the four scores and the axe
	 * count, which is what that predicate needs. Failed runs are skipped when
	 * looking back: a site that errored once has not "become" perfect by being
	 * measured again.
	 */
	const newlyPerfect = measured
		.filter((e) => perfect(e))
		.map((e) => {
			const points = (e.history ?? []).filter((h) => !h.error);
			if (points.length < 2) return null;
			const previous = points[points.length - 2];
			if (pointIsPerfect(previous, e.cwvFailures)) return null;
			return {
				displayUrl: e.displayUrl,
				slug: e.slug,
				timestamp: points[points.length - 1].t,
				// The same six dots the list above draws. All green by
				// definition here — that is the point of the row.
				bands: ringBands(e),
			};
		})
		.filter(Boolean)
		.filter((n) => now - n.timestamp <= NEWLY_PERFECT_WINDOW_HOURS * 3600 * 1000)
		.sort((a, b) => b.timestamp - a.timestamp);
	const scores = measured.map((e) => e.latest.lab?.scores?.performance).filter((n) => typeof n === "number");
	const weights = measured.map((e) => e.latest.lab?.weight?.total).filter((n) => typeof n === "number");
	const scripts = measured.map((e) => e.latest.lab?.weight?.byType?.script?.bytes).filter((n) => typeof n === "number");
	// Bytes from somebody else's domain. A zero bucket, as with scripts: loading
	// nothing third-party is a real and common answer, not a small number.
	const thirdParty = measured
		.map((e) => e.latest.lab?.weight?.byType?.["third-party"]?.bytes)
		.filter((n) => typeof n === "number");
	const lcps = measured.map((e) => e.latest.lab?.timings?.lcp).filter((n) => typeof n === "number");

	const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);

	return {
		total: entries.length,
		measured: measured.length,
		failing: entries.filter((e) => e.currentlyFailing).length,
		// Nothing amber or red across the six rings: four Lighthouse categories
		// at 100, a clean axe run, and no Core Web Vital failing for real users.
		// What Speedlify calls a "hundo", with both of the claims Lighthouse only
		// approximates checked against something better. Counting the score alone
		// would call a site perfect while it failed real users: Lighthouse's
		// accessibility category samples the rules axe runs in full, and its
		// timings are one simulated load on one machine, where CrUX is 28 days of
		// actual visits.
		perfect: measured.filter(perfect).length,

		// The performance circle across every measured site, and the axe circle
		// beside it.
		ringTiers: performanceTiers(measured),
		axeTiers: axeTiers(measured),
		// How many of those perfect scores are Eleventy, under either name.
		// Counts a mark presumed from a curated list alongside a detected one:
		// most static sites emit no generator tag, so detections alone would
		// undercount the thing this number exists to measure.
		perfectEleventy: measured.filter(
			(e) => perfect(e) && ELEVENTY_IDS.has(e.generator?.id ?? e.presumedGenerator?.id),
		).length,
		// The marks to show beside that number, resolved from the generator list
		// rather than named again in a template — two places to edit is how a
		// rename ends up half-applied.
		perfectEleventyMarks: [...ELEVENTY_IDS].map(generatorById).filter(Boolean),
		// What built the perfect scores, one row per generator, commonest first.
		// A presumption counts the same as a detection here, for the same reason
		// perfectEleventy does: most static sites emit no generator tag, so
		// counting detections alone would credit the wrong thing and leave a
		// third of the board unattributed.
		perfectGenerators: perfectGenerators(measured.filter(perfect)),
		// Sites at 100 in at least one category, which is a much easier bar and
		// is not what "perfect" means.
		anyHundred: measured.filter((e) => {
			const s = e.latest.lab?.scores || {};
			return [s.performance, s.accessibility, s["best-practices"], s.seo].some((v) => v === 100);
		}).length,
		avgTotal: avg(measured.map((e) => e.lighthouseTotal).filter((n) => typeof n === "number")),
		// The middle and the average of each ring across the fleet, each column
		// reduced independently.
		medians: ringStats(measured, median),
		means: ringStats(measured, mean),
		avgPerformance: avg(scores),
		avgWeight: avg(weights),
		// The middle site, which on this corpus is a quarter of the mean — the
		// average is dragged by a handful of sites in the tens of megabytes, and
		// showing it alone described almost nobody.
		medianWeight: median(weights),
		/*
		 * Thumbnails of two of the charts on /charts/, linking through to them.
		 *
		 * Two rather than one because they answer different questions: the first
		 * is the page's own weight against how fast it paints, the second is what
		 * other people's code costs. A second tile restating the first at a
		 * different zoom would be a wasted slot.
		 *
		 * The color means the same on both even though the axes run opposite ways
		 * — green is a good LCP low down on one and a good score high up on the
		 * other — because the band, not the position, carries the verdict.
		 */
		scatterPreview: buildScatterPreview(entries, {
			xOf: (e) => e.latest?.lab?.weight?.total,
			yOf: (e) => e.latest?.lab?.timings?.lcp,
			rate: (v) => (v <= LCP_GOOD ? "good" : v <= LCP_POOR ? "average" : "poor"),
		}),
		thirdPartyPreview: buildScatterPreview(entries, {
			xOf: (e) => e.latest?.lab?.weight?.byType?.["third-party"]?.bytes,
			yOf: (e) => e.latest?.lab?.scores?.performance,
			rate: (v) => (v >= 90 ? "good" : v >= 50 ? "average" : "poor"),
			yLinear: true,
			yDomain: [0, 100],
		}),
		// The most recent measurements, newest first. Measurement is rolling and
		// mostly invisible — the coverage figures say how much of the corpus has
		// data, not that anything happened in the last hour — so this is the one
		// place the site shows the process actually running.
		newlyPerfect,
		/*
		 * Shortened by however many newly-perfect rows sit under it, to nothing
		 * at all if that list fills the card on its own.
		 *
		 * The two lists share one card, and the card's height is the row's height
		 * — so a day when a dozen sites turn perfect should not push every other
		 * card in the bar a dozen rows taller. Newly perfect has the stronger
		 * claim on the space: it reports a change somebody made, while this list
		 * reports the measurement loop doing its rounds. So it yields, and the
		 * template drops its heading entirely at zero rather than printing a label
		 * over an empty list.
		 */
		recentlyMeasured: buildRecents(measured, RECENTLY_MEASURED - newlyPerfect.length),
		weightBuckets: bucketize(weights, scaleBuckets(weights)),
		// The same shape for JavaScript alone, which is the half of page weight
		// a site's own choices move most.
		medianScript: median(scripts),
		scriptBuckets: bucketize(scripts, scaleBuckets(scripts, { zeroBucket: true })),
		thirdPartyBuckets: bucketize(thirdParty, scaleBuckets(thirdParty, { zeroBucket: true })),
		// Largest Contentful Paint across the set, on the time scale.
		medianLcp: median(lcps),
		lcpBuckets: bucketize(lcps, scaleBuckets(lcps, { scale: "ms" })),
		totalMeasurements: entries.reduce((sum, e) => sum + e.historyCount, 0),
		cwvPassing: measured.filter((e) => e.cwv?.pass).length,
		// Denominator for the pass count: only sites that actually have an
		// assessment, not every measured site.
		cwvAssessed: measured.filter((e) => e.cwv).length,
		// The three-way split, on `cwvFailures` rather than on `cwv.pass` — see
		// coreWebVitalFailures in lib/rank.js. Null there means "not assessed",
		// which covers both a site CrUX has never sampled and one whose only
		// assessment is the lab approximation. Reading `cwv.pass` instead would
		// count that approximation as a verdict and report 1,255 sites as judged
		// on real users when 1,255 of them have no real users on record.
		//
		// The three are exhaustive over measured sites, so they always sum.
		/*
		 * The same three states, shaped for the same histogram the circles use.
		 *
		 * Bars rather than a table because the point is the proportion: unknown is
		 * the majority answer, and a column of numbers lets that slide past where
		 * a bar four times the height of the others cannot.
		 */
		cwvVerdicts: (() => {
			const passing = measured.filter((e) => e.cwvFailures === 0).length;
			const failing = measured.filter((e) => e.cwvFailures > 0).length;
			const unknown = measured.filter((e) => e.cwvFailures == null).length;
			/*
			 * Shares are of the sites that have a verdict, not of everything
			 * measured. Unknown is not a bar here — the chart is about how the
			 * judged sites divide — so counting it in the denominator would leave
			 * two bars that add to a sixth of the total and look like an error.
			 *
			 * It is still returned, because the note under the chart has to say how
			 * many sites this leaves out. A pass rate over a seventh of the corpus
			 * reads very differently once you know that is what it covers.
			 */
			const rated = passing + failing || 1;
			const pct = (n) => Math.round((n / rated) * 1000) / 10;
			return {
				passing,
				failing,
				unknown,
				rated: passing + failing,
				total: passing + failing + unknown,
				bars: [
					// `good`, not `green`: that key belongs to the stacked bar in the
					// circles histogram, whose rule drops its own background so the
					// segments show through. Reusing it here left this bar with no
					// color at all and it fell back to the accent.
					{ key: "good", tick: "Passing", label: "Every vital CrUX reports is good at p75", count: passing, share: pct(passing) },
					{ key: "bad", tick: "Failing", label: "At least one vital is not good at p75", count: failing, share: pct(failing) },
				],
			};
		})(),
	};
}

/**
 * Store a rank under `ranks` or `groupRanks[groupId]`.
 *
 * The field name carries the scope: "ranks" for the global pass, and
 * "groupRanks:ssg" for a group. A site in several categories needs a rank in
 * each, so those are nested rather than sharing one key — writing them flat
 * would have the last group silently overwrite the others, which is exactly
 * the bug that made a site show its global position inside a group table.
 */
/*
 * The rank movement worth printing in the # column, or null for silence.
 *
 * Two filters, and both are about not making a claim the data doesn't support.
 *
 * Climbs only. A rank is a position among other people's sites, so a fall is
 * as often someone else's improvement as it is your own decline, and the table
 * already reports every number a site is judged on. This is the same rule the
 * charts follow: name the sites doing well, don't point at the rest.
 *
 * And only when something the ranking scores actually moved. This board is
 * dense — 250 sites tie on a Lighthouse total of 400 — so inside the pack the
 * order comes down to Speed Index per KB, which drifts a little on every run.
 * Left ungated, 450 sites would show movement with a Lighthouse total identical
 * to the run before: a badge saying a site improved, on a site that measured
 * exactly the same. So the scored inputs have to have changed before the number
 * is allowed to appear. The size of the move is still the true rank distance;
 * this only decides whether it is shown.
 */
const RANK_CLIMB_MIN = 3;

export function rankClimb(entry, change) {
	if (!entry.previous || change === null || change < RANK_CLIMB_MIN) return null;

	const before = { ...entry, latest: entry.previous };
	const scoredMoved =
		lighthouseSum(entry) !== lighthouseSum(before) ||
		accessibilityViolations(entry) !== accessibilityViolations(before);

	return scoredMoved ? change : null;
}

function assignRank(entry, field, metric, position) {
	const [scope, groupId] = field.split(":");

	if (!groupId) {
		entry[scope] = entry[scope] || {};
		entry[scope][metric] = position;
		return;
	}

	entry[scope] = entry[scope] || {};
	entry[scope][groupId] = entry[scope][groupId] || {};
	entry[scope][groupId][metric] = position;
}
