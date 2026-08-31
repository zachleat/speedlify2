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
 * Core Web Vitals as a two-way band: passing-or-unknown, then failing.
 *
 * Unlike the other five rings, gray does *not* rank with red. On axe or a
 * Lighthouse category, no answer means the check did not run, and unchecked is
 * not clean. On Core Web Vitals it means CrUX has never sampled the site, which
 * is a fact about the site's traffic rather than about its quality — most of
 * this corpus is below that threshold, and ranking those sites with the ones
 * that measurably fail real users would demote a thousand sites for being
 * small.
 *
 * So good and unknown band together at the top, and a measured failure ranks
 * below them — in two steps rather than one.
 *
 * Amber sits between: every failing metric is short of the good threshold but
 * none is poor. That is a different statement from a four-second LCP, and the
 * ring says so, so the ranking should too — otherwise a site 2ms over the LCP
 * threshold is placed level with one taking six seconds. It stays *below* every
 * passing site, because the assessment it fails is all-good-or-fail; it simply
 * no longer sits level with the sites that fail it badly.
 *
 * Three quarters of the failing rings here are the amber case, so this moves
 * real ground: those sites now outrank the genuinely poor ones rather than
 * tying with them.
 */
export function cwvTier(entry) {
	const band = cwvBand(coreWebVitalFailures(entry), coreWebVitalWorst(entry) ?? "poor");
	if (band === "poor") return 2;
	return band === "average" ? 1 : 0;
}

/**
 * The banded rings, worst first, for comparing one site against another.
 *
 * Five of the six: the four Lighthouse categories and axe. Core Web Vitals is
 * not in here, and not because it does not matter — it is compared *before*
 * this, by cwvTier above. Putting it in the sorted profile would make a failing
 * Core Web Vital interchangeable with any other red, so a site failing real
 * users would tie with one that merely has an axe violation, which is the thing
 * this ordering is meant to prevent.
 *
 * Sorted worst-first and compared position by position, which is what makes
 * "all green beats any amber" hold without turning the bands into a second
 * currency to trade in. One amber beats two ambers; any red loses to any site
 * without one.
 */
export function bandProfile(entry) {
	if (!entry?.latest?.lab?.scores) return null;

	return [
		...SCORES.map(({ key }) => BAND_RANK[scoreBand(entry.latest.lab.scores[key])]),
		BAND_RANK[axeBand(accessibilityViolations(entry))],
	].sort((x, y) => y - x);
}

/** Lexicographic on the sorted profiles: the worst ring decides first. */
function compareBands(a, b) {
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
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

		// 1. Core Web Vitals, as a three-way band: a site CrUX says is failing real
		//    users cannot outrank one it says is passing, whatever else is true of
		//    them — and a site that is failing badly cannot outrank one that is
		//    barely failing. Ahead of the band profile rather than inside it, because inside
		//    it a failing vital would merely be one more red and could be traded
		//    against an axe violation — which is exactly how a failing host came
		//    to sit above a passing one.
		//
		//    Unknown ranks with passing, not with failing: it means CrUX has never
		//    sampled the site, which most of this corpus is too small for, and
		//    that is not evidence of anything.
		if (useFieldData) {
			const aTier = cwvTier(a);
			const bTier = cwvTier(b);
			if (aTier !== bTier) return aTier - bTier;
		}

		// 2. Band profile — the four categories and axe — worst band first. A ring
		//    that has dropped out of green is not something points elsewhere can
		//    buy back: 90/90/90/90 beats 100/100/100/80 despite giving up twenty
		//    points, because the second site is showing an amber ring and the
		//    first is not. Core Web Vitals is not banded here; it ranks below.
		const aBands = bandProfile(a);
		const bBands = bandProfile(b);
		if (aBands && bBands) {
			const byBand = compareBands(aBands, bBands);
			if (byBand !== 0) return byBand;
		} else if (aBands !== bBands) {
			// One site has no scores at all. Unscored sorts after scored, the same
			// way an unmeasured site does.
			return aBands ? -1 : 1;
		}

		// 2. Total Lighthouse score, higher wins. Settles order within a band
		//    profile rather than across band profiles.
		const aSum = lighthouseSum(a);
		const bSum = lighthouseSum(b);
		if (aSum !== bSum) {
			if (aSum === null) return 1;
			if (bSum === null) return -1;
			return bSum - aSum;
		}

		// 3. Failing Core Web Vitals from real users, fewest wins.
		//
		//    Deliberately ahead of axe and the lab tiebreaker: once two sites
		//    score the same in the lab, what actually happened to real people is
		//    the better evidence. A site with no CrUX coverage is not assessed
		//    here and falls through to the tiers below — it is neither credited
		//    nor blamed for data that does not exist.
		if (useFieldData && fieldDataTier === "afterTotal") {
			const cwv = compareFieldFailures(a, b);
			if (cwv !== 0) return cwv;
		}

		// 4. Fewest accessibility violations.
		const axe = byLowest(accessibilityViolations(a), accessibilityViolations(b));
		if (axe !== 0) return axe;

		// 5. Speed Index per KB, plus TTFB and TBT. Lower wins.
		const tie = byLowest(tiebreakerValue(a), tiebreakerValue(b));
		if (tie !== 0) return tie;

		// 6. Field data as a final separator, when configured that way.
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
	return (coreWebVitalFailures(a) ?? 0) - (coreWebVitalFailures(b) ?? 0);
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
