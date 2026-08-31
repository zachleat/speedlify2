/**
 * Leaderboard ranking, ported from `performance-leaderboard`.
 *
 * https://www.zachleat.com/web/eleventy-leaderboard-speedlify/#the-algorithm-and-tiebreaker-changes
 *
 * Ordering, in sequence:
 *
 *  1. **Band profile**, worst ring first, across the four Lighthouse categories
 *     and axe. The bands come first so the leaderboard cannot contradict what
 *     the rings show: five green circles outrank any site carrying an amber one,
 *     and an amber one outranks a red, whatever the arithmetic says. Core Web
 *     Vitals is not banded — it is unknown for most of the corpus — and ranks
 *     at its own tier below.
 *  2. **Sum of all four Lighthouse categories** (0–400), higher wins. Using all
 *     four rather than Performance alone stops a fast but inaccessible site
 *     outranking a well-rounded one. Now settles order *within* a band profile
 *     rather than across bands.
 *  3. **Fewest accessibility violations**, counted as violating *nodes*.
 *  4. **Tiebreaker value**, lower wins:
 *
 *         50000 * speedIndex / weight + TTFB + TBT
 *
 *     Speed Index per KB. The point is that a fast *heavy* site is more
 *     impressive than a fast empty one — so with Speed Index equal the larger
 *     site wins, and with weight equal the lower Speed Index wins. TTFB and TBT
 *     are added so server latency and main-thread blocking still cost you.
 *
 * The weight used in that ratio caps images and fonts, otherwise a site could
 * climb the board by shipping enormous images it doesn't need.
 *
 * Why the bands outrank the sum: a total treats the categories as a currency,
 * so a category can be sold off to buy points elsewhere. 100/100/100/60 sums to
 * 360 and beats 90/90/90/89 on 359, while showing an amber circle against four
 * greens — a row that looks worse than the row beneath it. Banding first says
 * that a category dropping out of green is a fact about the site that no amount
 * of points elsewhere buys back.
 */

import { SCORES } from "./report-metrics.js";

/** Bytes past which extra images/fonts stop earning credit. */
const UPPER_LIMIT_IMAGES = 400000;
const UPPER_LIMIT_FONTS = 100000;

/** Scale factor, so the ratio lands in the same order of magnitude as ms. */
const SPEED_INDEX_SCALE = 50000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Lighthouse's own banding, and the single definition of it.
 *
 * The rings on the site color themselves from these same thresholds via
 * `scoreBand` — a second copy of "90" somewhere else is how a site ends up
 * ranked as all-green while displaying an amber circle.
 */
export const SCORE_BAND_GOOD = 90;
export const SCORE_BAND_AVERAGE = 50;

/** "good" | "average" | "poor" | "none" for one category score. */
export function scoreBand(value) {
	const v = num(value);
	if (v === null) return "none";
	if (v >= SCORE_BAND_GOOD) return "good";
	if (v >= SCORE_BAND_AVERAGE) return "average";
	return "poor";
}

/**
 * Banding for the axe ring, where the scale runs the other way.
 *
 * A Lighthouse score is better when higher; a violation count is better when
 * zero. Banding it by the score thresholds would paint "2 violations" green for
 * being a small number, so it gets its own: clean, nearly clean, or not.
 */
export const AXE_BAND_AVERAGE = 5;

export function axeBand(violations) {
	const v = num(violations);
	if (v === null) return "none";
	if (v === 0) return "good";
	return v <= AXE_BAND_AVERAGE ? "average" : "poor";
}

/** Banding for the Core Web Vitals ring: a verdict, so green or red only. */
/**
 * The ring's color, which has three states where the assessment has two.
 *
 * `failures` counts every metric that is not `good`, because that is what
 * passing means: Google's assessment is all-good-or-fail, and "needs
 * improvement" is not a pass. That count is what the ranking reads.
 *
 * The color is allowed to be more specific. Given `worst` — the worst rating
 * among the failing metrics — a site whose metrics are all merely short of the
 * good threshold shows amber, and red is kept for one that is genuinely poor
 * for real users. Without it the band stays two-way, so every existing caller
 * behaves exactly as before.
 *
 * Three quarters of the failing rings in this corpus are the amber case: 64 of
 * 86, at the time this was added. Painting them the same red as a site with a
 * four-second LCP said something the numbers underneath did not.
 */
export function cwvBand(failures, worst = "poor") {
	const v = num(failures);
	if (v === null) return "none";
	if (v === 0) return "good";
	return worst === "poor" ? "poor" : "average";
}

/**
 * The worst rating among a site's assessed Core Web Vitals.
 *
 * "poor" if any metric is genuinely poor, "needs-improvement" if some are
 * failing but none that badly, null when nothing was assessed. Only meaningful
 * for field data, on the same grounds as `coreWebVitalFailures`: a lab
 * approximation is not a verdict about real users.
 */
export function coreWebVitalWorst(entry) {
	const cwv = entry?.cwv;
	if (!cwv || cwv.source === "lab") return null;

	const rated = (cwv.parts ?? []).filter((p) => p.rating);
	if (!rated.length) return null;
	if (rated.some((p) => p.rating === "poor")) return "poor";
	return rated.some((p) => p.rating !== "good") ? "needs-improvement" : null;
}

/**
 * Where each band sits when rings are compared, worst wins the comparison.
 *
 * Gray sits between amber and red. It means the check produced no answer — the
 * run failed, or axe never got to it — and unchecked is not clean, so it must
 * cost more than any real amber: a site cannot climb the board by failing to be
 * measured. But it used to rank *level with* red, which said something stronger
 * than the evidence supports, and produced orderings nobody could read off the
 * rings. surge.sh showed two ambers, a gray and a red and sat below vercel.com
 * showing one amber and two reds, because the gray was scored as a second red.
 *
 * Unknown is now the worst thing we are willing to assume rather than the worst
 * thing possible.
 */
const BAND_RANK = { good: 0, average: 2, none: 2.5, poor: 3 };

/**
 * The six rings counted by color: how many green, how many amber, how many red.
 *
 * Gray is ignored outright rather than bucketed. On the Lighthouse rings and
 * axe it means the check did not run; on Core Web Vitals it means CrUX has
 * never sampled the site, which most of this corpus is too small for. Neither
 * is evidence of quality, so neither is counted — though a site with a gray
 * ring does have one fewer green to show for it, which is the cost of an
 * unchecked ring rather than a penalty for it.
 */
export function bandCounts(entry, { useFieldData = true } = {}) {
	if (!entry?.latest?.lab?.scores) return null;

	const bands = [
		...SCORES.map(({ key }) => scoreBand(entry.latest.lab.scores[key])),
		axeBand(accessibilityViolations(entry)),
	];

	if (useFieldData) {
		/*
		 * An unsampled vital counts as green, not as a gray ring and not as a ring
		 * that is missing.
		 *
		 * Uncounted, it cost a green: a site CrUX has never seen showed five where
		 * a sampled site showed six, and 171 of the 179 perfect sites on this
		 * board — every one of them too small for CrUX — fell below rank 36 behind
		 * the eight that had data. That is demoting sites for being small, which
		 * is the one thing this ring must never do.
		 *
		 * Unlike a Lighthouse category with no score or an axe run that never
		 * happened, no sample is not an unfinished measurement. Nothing was
		 * skipped; there is simply no traffic to report on, and that says nothing
		 * about the page.
		 *
		 * Off entirely when field data is switched out of the ranking: a
		 * configuration that says "ignore CrUX" has to mean the ring is not there
		 * at all.
		 */
		const vital = cwvBand(coreWebVitalFailures(entry), coreWebVitalWorst(entry) ?? "poor");
		bands.push(vital === "none" ? "good" : vital);
	}

	return {
		good: bands.filter((b) => b === "good").length,
		average: bands.filter((b) => b === "average").length,
		poor: bands.filter((b) => b === "poor").length,
		/*
		 * Gray rings, counted separately rather than dropped.
		 *
		 * Left uncounted a site could climb by not being measured: a failed axe
		 * run showed zero ambers and outranked a site that was measured and got
		 * one. Unchecked is not clean.
		 *
		 * Not lumped in with red either — a check that did not run is not a
		 * measured failure. It sits between the two, which is where the old
		 * worst-first profile put it as well.
		 *
		 * The vital never reaches here: an unsampled one is counted green above.
		 */
		unchecked: bands.filter((b) => b === "none").length,
	};
}

/**
 * Reds first, then unchecked rings, then ambers, then greens. Best first.
 *
 * A red circle is worth less than an amber, and an amber less than a green, so
 * the count of the worst color is the first question asked: a site showing any
 * red ranks below a site showing none, whatever else it has. Ambers settle the
 * next tier down, and the green count is the last word.
 *
 * This is what keeps "no red beats one red" true in every case. Ordering by
 * greens first — which reads naturally, and was tried here — lets a site buy
 * its way past a clean one with volume: four green and two red would outrank
 * three green and three amber, and digitalocean.com sat above heroku.com on
 * exactly that trade.
 */
function compareBands(a, b) {
	if (a.poor !== b.poor) return a.poor - b.poor;
	// Between red and amber: worse than a ring that was measured and came back
	// middling, better than one that measurably failed.
	if (a.unchecked !== b.unchecked) return a.unchecked - b.unchecked;
	if (a.average !== b.average) return a.average - b.average;
	return b.good - a.good;
}

/** Sum of the four Lighthouse categories, 0–400. Null if any is missing. */
export function lighthouseSum(entry) {
	const scores = entry?.latest?.lab?.scores;
	if (!scores) return null;

	const parts = [scores.performance, scores.accessibility, scores["best-practices"], scores.seo].map(num);
	if (parts.some((v) => v === null)) return null;

	return parts.reduce((a, b) => a + b, 0);
}

/**
 * The weight the Speed Index is measured against.
 *
 * Document, CSS and JS count in full — those are the bytes you chose to ship.
 * Images and fonts are capped so that padding them cannot buy you rank.
 */
export function tiebreakerWeight(entry) {
	const byType = entry?.latest?.lab?.weight?.byType;
	if (!byType) return null;

	const bytes = (key) => num(byType[key]?.bytes) ?? 0;

	return (
		bytes("document") +
		bytes("stylesheet") +
		bytes("script") +
		Math.min(bytes("font"), UPPER_LIMIT_FONTS) +
		Math.min(bytes("image"), UPPER_LIMIT_IMAGES)
	);
}

/** Speed Index per KB, plus TTFB and TBT. Lower is better. */
export function tiebreakerValue(entry) {
	const timings = entry?.latest?.lab?.timings;
	if (!timings) return null;

	const speedIndex = num(timings.si);
	if (speedIndex === null) return null;

	const weight = tiebreakerWeight(entry);
	if (weight === null) return null;

	// A zero-weight page would divide to Infinity; clamping keeps it merely
	// terrible rather than unsortable.
	const divisor = Math.max(weight, 1);

	return SPEED_INDEX_SCALE * (speedIndex / divisor) + (num(timings.ttfb) ?? 0) + (num(timings.tbt) ?? 0);
}

/**
 * Accessibility violations from the standalone axe run, counted as violating
 * nodes rather than broken rules.
 *
 * This is deliberately not Lighthouse's accessibility audit. Lighthouse runs a
 * subset of axe's rules and folds the outcome into a weighted score; a page can
 * score in the nineties there and still fail a dozen axe checks. The tiebreaker
 * wants the strict count.
 *
 * Returns null when axe did not run or errored, which the comparator treats as
 * "no data" rather than "no violations" — otherwise a site whose axe pass timed
 * out would win the tiebreaker for it.
 */
export function accessibilityViolations(entry) {
	return num(entry?.latest?.axe?.violations);
}

/**
 * How many Core Web Vitals are failing at p75, from real user data.
 *
 * Counting *failures* rather than passes is what makes partial coverage fair:
 * CrUX reports different metrics for different sites (a quiet site may have LCP
 * and CLS but no INP), so "2 good" means nothing without its denominator, while
 * "0 failing" means the same thing whether two metrics were assessed or three.
 *
 * Returns null — meaning "not assessed", not "perfect" — when:
 *  - the site has no CrUX data, or
 *  - the assessment came from the **lab approximation**. That is derived from
 *    the same lab timings already counted in the Lighthouse total, so letting
 *    it in here would score the same numbers twice and let a site with no real
 *    users compete against sites judged on actual traffic.
 */
export function coreWebVitalFailures(entry) {
	const cwv = entry?.cwv;
	if (!cwv || cwv.source === "lab") return null;

	const rated = cwv.parts.filter((p) => p.rating);
	if (!rated.length) return null;

	return rated.filter((p) => p.rating !== "good").length;
}

/**
 * The comparator. Sorts best first.
 *
 * Sites with no successful measurement sort last rather than being treated as
 * a zero score — never measured is not the same as measured badly.
 */
/** Lower wins, with null ("not assessed") sorting after any real value. */
function byLowest(aValue, bValue) {
	if (aValue === bValue) return 0;
	if (aValue === null) return 1;
	if (bValue === null) return -1;
	return aValue - bValue;
}

export const RANKING_DEFAULTS = {
	// Include real-user Core Web Vitals as a tier. Turn off to rank purely on
	// what a synthetic run can reproduce.
	useFieldData: true,
	// Where that tier sits: "afterTotal" (ahead of axe) or "last" (final
	// tiebreak, so it only separates otherwise-identical sites).
	fieldDataTier: "afterTotal",
};

/**
 * Build the comparator. Sorts best first.
 *
 * A note on why this is a factory: the position of the field-data tier changes
 * the leaderboard substantially, so it is a configuration decision rather than
 * something baked in.
 */
export function createComparator(options = {}) {
	const { useFieldData, fieldDataTier } = { ...RANKING_DEFAULTS, ...options };

	return function compare(a, b) {
		const aMeasured = Boolean(a?.latest);
		const bMeasured = Boolean(b?.latest);
		if (aMeasured !== bMeasured) return aMeasured ? -1 : 1;
		if (!aMeasured) return 0;

		/*
		 * 1. The rings, counted by color: fewest red, then gray, then amber, then
		 *    most green.
		 *
		 * All six, Core Web Vitals included. That ring used to be tested ahead of
		 * this as a pass/fail gate, which let a site with red rings outrank a site
		 * with none — neocities.org showed a red axe ring and digitalocean.com two
		 * reds, and both sat above pages.github.com, which had no red at all and
		 * lost on a single amber vital.
		 *
		 * Worst color first, not best. Counting greens first reads more naturally
		 * and was tried here, but it lets a site buy its way past a clean one with
		 * volume: four green and two red would outrank three green and three
		 * amber. Starting from red keeps "no red beats any red" true in every
		 * case, which is the rule the leaderboard states.
		 */
		const aBands = bandCounts(a, { useFieldData });
		const bBands = bandCounts(b, { useFieldData });
		if (aBands && bBands) {
			const byBand = compareBands(aBands, bBands);
			if (byBand !== 0) return byBand;
		} else if (aBands !== bBands) {
			// One site has no scores at all. Unscored sorts after scored, the same
			// way an unmeasured site does.
			return aBands ? -1 : 1;
		}

		/*
		 * 2. The axe ring's color: green, then amber, then gray, then red.
		 *
		 * The band, not the count. Two sites showing the same six colors can still
		 * differ in which ring is the amber one, and this asks whose amber is the
		 * accessibility ring — a green axe ring beats an amber one before any
		 * points are read.
		 *
		 * Ahead of the vitals below it as well: a slow site is a better site than
		 * an inaccessible one, and a page somebody cannot use at all is not
		 * redeemed by loading quickly for everybody else.
		 *
		 * How many nodes are failing is a separate question, and a finer one than
		 * belongs this high — one violation and thirty are the same color, and the
		 * difference between them is settled below the total.
		 */
		const axeColor = BAND_RANK[axeBand(accessibilityViolations(a))] - BAND_RANK[axeBand(accessibilityViolations(b))];
		if (axeColor !== 0) return axeColor;

		/*
		 * 3. Failing Core Web Vitals from real users: how badly, then how many.
		 *
		 * Ahead of the Lighthouse total, not behind it. Two sites showing the same
		 * rings are not distinguished by points — a ring is amber at 89 and at 50
		 * — and what actually happened to real people is better evidence than the
		 * arithmetic behind an identical row of circles.
		 *
		 * A site with no CrUX coverage is not assessed here and falls through, so
		 * it is neither credited nor blamed for data that does not exist.
		 */
		if (useFieldData && fieldDataTier === "afterTotal") {
			const cwv = compareFieldFailures(a, b);
			if (cwv !== 0) return cwv;
		}

		/*
		 * 4. Total Lighthouse score, higher wins.
		 *
		 * Below the two criteria above rather than directly under the rings. By
		 * the time it is read, two sites have shown the same circles, the same
		 * real-user verdict and the same number of accessibility violations — the
		 * points are what is left to separate them.
		 */
		const aSum = lighthouseSum(a);
		const bSum = lighthouseSum(b);
		if (aSum !== bSum) {
			if (aSum === null) return 1;
			if (bSum === null) return -1;
			return bSum - aSum;
		}

		/*
		 * 5. Fewest accessibility violations, counted as failing nodes.
		 *
		 * The same ring as step 2, read at full resolution. Up there it is one of
		 * six colors and one violation looks like thirty; here, once two sites
		 * have shown the same rings and the same points, the count is what is left
		 * to separate them — and thirty failing nodes is a worse page than one.
		 *
		 * Below the total rather than beside it, because a color that has already
		 * been compared should not be compared twice before anything else is.
		 */
		const axeCount = byLowest(accessibilityViolations(a), accessibilityViolations(b));
		if (axeCount !== 0) return axeCount;

		// 6. Speed Index per KB, plus TTFB and TBT. Lower wins.
		const tie = byLowest(tiebreakerValue(a), tiebreakerValue(b));
		if (tie !== 0) return tie;

		// 7. Field data as a final separator, when configured that way.
		if (useFieldData && fieldDataTier === "last") {
			return compareFieldFailures(a, b);
		}

		return 0;
	};
}

/**
 * Compare failing Core Web Vitals, treating "not assessed" as **no known
 * failures** rather than as worse than everyone.
 *
 * This is the difference between a tier that demotes sites for failing real
 * users and one that demotes them for being small. Sorting unassessed sites
 * last did the latter: vuepress.vuejs.org, whose CrUX record has no rated
 * metrics, was pushed below a site with thirteen accessibility violations that
 * it otherwise beat — the axe tier was never reached.
 *
 * Absence of evidence is not evidence of failure, so an unassessed site is
 * neither credited nor blamed here and simply carries on to the next tier.
 * Skipping the tier outright would be the other way to express that, but a
 * comparator that ignores a criterion for some pairs and not others is not
 * transitive, and an intransitive comparator makes the sort order undefined.
 */
function compareFieldFailures(a, b) {
	// How badly first, then how many. Two failing metrics that are merely short
	// of the good threshold are a better result than one that is poor for real
	// users, and the count alone says the opposite.
	const bySeverity = severityRank(a) - severityRank(b);
	if (bySeverity !== 0) return bySeverity;

	return (coreWebVitalFailures(a) ?? 0) - (coreWebVitalFailures(b) ?? 0);
}

/**
 * 0 passing or unsampled, 1 failing but nothing poor, 2 poor for real users.
 *
 * Unsampled ranks with passing, not between passing and failing. Ranking it
 * below a measured pass was tried and reverted: this step sits above the
 * Lighthouse total, so having CrUX data outranked scoring 400 — a11yproject.com
 * on 399 rose to #9 while 171 perfect sites fell behind it, none of them for
 * anything about the page. Demoting a site for having no traffic is the thing
 * this ring must never do, wherever in the order it is done.
 */
function severityRank(entry) {
	const band = cwvBand(coreWebVitalFailures(entry), coreWebVitalWorst(entry) ?? "poor");
	if (band === "poor") return 2;
	return band === "average" ? 1 : 0;
}

/** The default comparator, using the settings above. */
export const compareEntries = createComparator();

/**
 * Rank a list with the leaderboard algorithm.
 *
 * Genuinely equal entries share a rank and the next position skips, the same
 * way the per-metric rankings behave. In practice the tiebreaker is continuous
 * enough that exact ties are rare.
 */
export function rankLeaderboard(entries, compare = compareEntries) {
	const sorted = [...entries].sort(compare);

	let lastRank = 0;
	return sorted.map((entry, i) => {
		const tied = i > 0 && compare(sorted[i - 1], entry) === 0;
		const rank = tied ? lastRank : i + 1;
		lastRank = rank;
		return { entry, rank };
	});
}
