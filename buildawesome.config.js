import { HtmlBasePlugin } from "@awesome.me/buildawesome";
import fontAwesomePlugin from "@11ty/font-awesome";
import { library, findIconDefinition } from "@fortawesome/fontawesome-svg-core";
import { fab } from "@fortawesome/free-brands-svg-icons";
import { faForwardFast } from "@fortawesome/free-solid-svg-icons";

// Must stay first: loads .env before the data files read process.env.
import "./lib/env.js";

import fs from "node:fs";
import path from "node:path";

import * as simpleIcons from "simple-icons";
import { lowerIsBetter } from "./lib/compare.js";
import { scoreBand, axeBand, cwvBand } from "./lib/rank.js";

const ICONS_DIR = "src/icons";

/**
 * Marks Font Awesome carries, mapped from the simple-icons name we detect under.
 *
 * Font Awesome first where it has the brand, because the plugin emits one
 * `<symbol>` per page and a `<use>` per occurrence. A leaderboard row inlines
 * its marks, and the big categories run to hundreds of rows: inlining the
 * WordPress path 300 times is 300 copies of the same 700 bytes, where the
 * sprite is one copy and 300 short references.
 *
 * Only exact brand matches belong here. Font Awesome has `markdown`, which is
 * not MkDocs, and a plausible-looking wrong logo is worse than the initials
 * chip it would replace.
 *
 * Two of these have no simple-icons entry at all — Amazon's marks were removed
 * from that project at Amazon's request, and Build Awesome was shipped as a
 * local file — so for those this is not an optimisation but the only mark
 * available.
 */
/**
 * Brand colors, overriding or supplying what simple-icons ships.
 *
 * The color normally comes from simple-icons, which ships a hex with every
 * icon. Two cases need this table instead: a brand that only exists in Font
 * Awesome, whose marks are monochrome by design and so have no color to
 * inherit, and a brand whose official color does not survive this page's dark
 * background.
 */
const BRAND_COLORS = {
	// Build Awesome's balloon, from its own mark.
	BuildAwesome: "00A776",
};

/**
 * The phases of LCP, in the order they happen.
 *
 * Named as Lighthouse names them in `lcp-breakdown-insight`, which is where the
 * numbers come from. Order is the point: the bar is a timeline, so it is fixed
 * here rather than sorted by size at render time.
 */
/**
 * The LCP the bar is drawn full-width at, in milliseconds.
 *
 * Three seconds is a little over the median for this corpus, so half the sites
 * read as a length and the slower half peg at full width. That is the trade
 * being made: resolution where most of the rows are, at the cost of telling a
 * four-second site from a forty-second one — for which the number is right
 * there beside the bar. Scaling to the true maximum of 203 seconds would render
 * every other site as a couple of pixels.
 *
 * The track is 7.5rem wide in the stylesheet, which is 40px per second at the
 * default root size. Change one and the other stops being true.
 */
const LCP_BAR_SCALE_MS = 3000;

/**
 * Pixels per second, which has to match the `.lcp-bar` width in the stylesheet.
 *
 * The scale above is one line's worth. Past it the bar wraps onto another line
 * rather than stopping, so length keeps meaning duration all the way up instead
 * of everything slow looking equally slow.
 */
const LCP_BAR_PX_PER_SECOND = 40;

/**
 * How many lines the bar may wrap onto before it gives up.
 *
 * There has to be a limit: the slowest site here takes 203 seconds, which is 68
 * lines, and a table row cannot be 400 pixels tall because one site is broken.
 * Four lines is twelve seconds, which is about 95% of this corpus, and stacks
 * to 22px — inside the height the score rings already give a row, so wrapping
 * costs the table nothing.
 */
const LCP_BAR_MAX_ROWS = 4;

const LCP_SUBPARTS = [
	{ key: "timeToFirstByte", label: "Time to first byte" },
	{ key: "resourceLoadDelay", label: "Resource load delay" },
	{ key: "resourceLoadDuration", label: "Resource load duration" },
	{ key: "elementRenderDelay", label: "Element render delay" },
];

/**
 * The tab icon, built from Font Awesome's own path data.
 *
 * An SVG data URI rather than a file: it is one path, so inlining costs less
 * than the request would, and there is nothing to keep in sync in `src/`.
 *
 * Taken from the package rather than pasted, so upgrading Font Awesome updates
 * the mark instead of leaving a copy of an old one behind. The viewBox comes
 * from the icon too — Font Awesome's are 512-wide, not 16.
 *
 * Painted in the brand green, which reads on both the light and dark browser
 * chrome a favicon has no way to ask about.
 */
const FAVICON = (() => {
	const [width, height, , , path] = faForwardFast.icon;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><path fill="#00a776" d="${path}"/></svg>`;

	// Encoded whole: the path data is full of characters a URL treats as
	// structure, and `#` in the fill would otherwise start a fragment.
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
})();

/*
 * The brand pack, registered once so `findIconDefinition` can be asked about it.
 */
library.add(fab);

/**
 * simple-icons names that Font Awesome spells differently.
 *
 * Only the irregular ones. A brand both sets carry under the same name, or one
 * Font Awesome knows by an alias, needs no entry here.
 */
const FONT_AWESOME_ALIASES = {
	Vuedotjs: "vuejs",
	Flydotio: "fly",
};

/**
 * Font Awesome's own name for a brand, or null if it does not carry one.
 *
 * Font Awesome is preferred wherever it has the mark, because of how it is
 * delivered: the plugin rewrites `<i class="fa-brands fa-x">` into a `<use>`
 * against a per-page spritesheet, so a logo repeated down a thousand-row
 * leaderboard costs one symbol. simple-icons is inlined as path data at every
 * occurrence.
 *
 * Asked of the library rather than matched against a list, for two reasons.
 * `findIconDefinition` resolves aliases — `11ty` returns the `eleventy`
 * definition, which scraping the exports would miss — and it returns the
 * canonical `iconName`, so the class is correct whichever spelling matched.
 *
 * A slug is only ever emitted for a definition the library actually returned,
 * so `failOnError` below cannot fire on a guess.
 */
function fontAwesomeSlug(name) {
	if (!name) return null;

	// Compound names are the one place the two projects disagree in a way no
	// alias covers: simple-icons writes `BuildAwesome`, Font Awesome writes
	// `build-awesome`.
	const candidates = [
		FONT_AWESOME_ALIASES[name],
		name.toLowerCase(),
		name.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "-").toLowerCase(),
	];

	for (const iconName of candidates) {
		if (!iconName) continue;
		const found = findIconDefinition({ prefix: "fab", iconName });
		if (found) return found.iconName;
	}

	return null;
}

/**
 * Brand marks kept in the repo rather than pulled from simple-icons.
 *
 * simple-icons is the source for everything it carries, but it does not carry
 * every brand — Amazon's marks were removed from the project at Amazon's
 * request, so `Amazon` and `CloudFront` have to be supplied locally or go
 * without. Drop a square-viewBox, single-path SVG in `src/icons/<Name>.svg`
 * and any host or generator with `icon: "<Name>"` picks it up.
 *
 * The brand color is read from `data-hex="RRGGBB"` on the root `<svg>` if
 * present; otherwise the mark follows the theme's text color, which is what
 * the luminance guard below would do for a black mark anyway.
 */
function loadLocalIcons(dir = ICONS_DIR) {
	const icons = {};
	if (!fs.existsSync(dir)) return icons;

	for (let file of fs.readdirSync(dir)) {
		if (!file.endsWith(".svg")) continue;
		const svg = fs.readFileSync(path.join(dir, file), "utf8");
		const paths = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
		if (!paths.length) {
			console.warn(`[speedlify] ${dir}/${file} has no <path d="…"> — skipped`);
			continue;
		}
		if (paths.length > 1) {
			console.warn(`[speedlify] ${dir}/${file} has ${paths.length} paths — only the first is used`);
		}
		icons[path.basename(file, ".svg")] = {
			path: paths[0],
			hex: svg.match(/data-hex="#?([0-9a-f]{6})"/i)?.[1] ?? "000000",
			viewBox: svg.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 24 24",
		};
	}

	return icons;
}

const localIcons = loadLocalIcons();

/**
 * Decimal bytes: 1 kB is 1,000 bytes, 1 MB is 1,000,000. See the filter below.
 *
 * The kB ceiling is 999,950 rather than a round million because the figure is
 * rounded to one decimal before anyone reads it: 999,999 B is under a megabyte
 * but prints as "1000.0 kB", which is the same failure to roll over in smaller
 * type. Anything that would round to 1000.0 is already a megabyte on the page.
 */
function formatBytes(v) {
	if (typeof v !== "number") return "—";
	if (v < 1000) return `${v} B`;
	// The tenth of a kilobyte stops being worth a column's width once there are
	// three digits in front of it: 847 kB and 847.3 kB say the same thing, and
	// the second one says it in a wider cell.
	if (v < 99950) return `${(v / 1000).toFixed(1)} kB`;
	if (v < 999500) return `${Math.round(v / 1000)} kB`;
	return `${(v / 1000 / 1000).toFixed(2)} MB`;
}

export default async function ($config) {
	/*
	 * Where this instance is served from.
	 *
	 * "/" for a custom domain, which is what speedlify.dev is. A fork on GitHub
	 * Pages without one is served at `user.github.io/repo/`, where root-relative
	 * URLs would resolve a directory too high and 404 the whole site — so the
	 * path has to be known at build time. `publish.yml` sets this from
	 * `actions/configure-pages`, which reports the path it is about to publish
	 * under: empty for a custom domain, "/repo" for a project page.
	 */
	$config.addPlugin(HtmlBasePlugin, {
		baseHref: process.env.SPEEDLIFY_BASE_HREF || "/"
	});

	/*
	 * Font Awesome, in transform mode: it rewrites `<i class="fa-brands fa-x">`
	 * in the built HTML into a `<use>` against a per-page spritesheet, which is
	 * emitted by the `getBundle` call in the layout.
	 *
	 * The transform rather than the shortcode because `stackIcon` is itself a
	 * shortcode, and nesting one inside another would mean reaching into the
	 * bundle manager by hand. Rewriting the finished HTML needs none of that.
	 *
	 * failOnError stays on: a class this config emits that Font Awesome cannot
	 * resolve would be a bug in fontAwesomeSlug, and the default behavior —
	 * leaving the `<i>` in place — would ship an invisible empty element instead
	 * of a logo, on every row of a leaderboard, silently.
	 */
	$config.addGlobalData("favicon", FAVICON);

	$config.addPlugin(fontAwesomePlugin, {
		failOnError: true,
	});

	$config.addPassthroughCopy({ "src/css": "css" });
	$config.addPassthroughCopy({ "src/js": "js" });

	// Lighthouse's filmstrip frames for each site, captured during measurement
	// and stored beside the numbers. Copied rather than passed through an image
	// pipeline: they are already small JPEGs at the size they are shown, and
	// they are named by a hash of their own bytes, so the URL changes only when
	// the picture does.
	$config.addPassthroughCopy("results/*/frames");

	// The pair from the axe pass — the page as rendered, and with scripts
	// disabled — which sit beside the frames directory rather than inside it.
	//
	// The extension is part of the glob because these are not hash-named: the
	// filename is fixed and the format is the capture's choice, so a switch away
	// from WebP upstream has to keep being copied. See writeScreenshots in
	// lib/store.js, which sweeps the file of the old type when that happens.
	$config.addPassthroughCopy("results/*/screenshot*.{webp,jpg,jpeg,png,avif}");

	// Emulated passthrough copy: during `--serve`, files are served from where
	// they already are instead of being copied into the output first. Opt-in —
	// Eleventy defaults to "copy" — and worth opting into here, because the
	// frames directory is one folder per site and copying all of it on every
	// rebuild is the difference between an instant reload and a noticeable one.
	//
	// No effect on a production build, which still writes real files.
	$config.setServerPassthroughCopyBehavior("passthrough");

	// Brand marks are inlined into the pages that use them, so the directory
	// itself is a source of build inputs rather than output — and its README
	// would otherwise render as a page.
	$config.ignores.add(`${ICONS_DIR}/**`);

	// The report is deliberately NOT published. It is the build's input, not an
	// artifact for the site — and at full coverage it is tens of megabytes, which
	// is not something to serve by accident. The per-site files under
	// /api/site/<slug>.json are the ones consumers actually use.
	//
	// The report is the only input; rebuild when it changes.
	$config.addWatchTarget(process.env.SPEEDLIFY_REPORT_FILE || "report.json");

	/*
	 * Keep the watcher out of the dataset.
	 * Depends on https://github.com/11ty/buildawesome/issues/4351 in v4.0.0-alpha.11
	 */
	$config.watchIgnores.add("results/**");
	$config.watchIgnores.add("logs/**");

	// 8080 is a busy port on most machines, and this project is often running
	// alongside whatever else is being measured.
	$config.setServerOptions({ port: 2830 });
	$config.setQuietMode(true);

	/* ---------------------------------------------------------------- format */

	/**
	 * Bytes, in the units the label actually names.
	 *
	 * Decimal, not binary. `kB` means a thousand bytes and `MB` a million — the
	 * convention Chrome DevTools reports transfer sizes in, and the one anybody
	 * reading "MB" assumes. Dividing by 1024 while writing `kB` produced figures
	 * like "1015.8 kB", which is over a million bytes and so, by its own label,
	 * over a megabyte: a number that has visibly failed to roll over.
	 *
	 * The binary units exist and are correct for memory. They are called KiB and
	 * MiB, and page weight is not measured in them.
	 */
	$config.addFilter("bytes", formatBytes);

	$config.addFilter("ms", (v) => {
		if (typeof v !== "number") return "—";
		if (v < 1000) return `${Math.round(v)} ms`;
		return `${(v / 1000).toFixed(2)} s`;
	});

	$config.addFilter("num", (v, places = 0) => {
		if (typeof v !== "number") return "—";
		return v.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
	});

	/** Format by declared unit so one template row handles ms, bytes and counts. */
	$config.addFilter("unit", function (v, unit) {
		if (typeof v !== "number") return "—";
		if (unit === "ms") return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`;
		if (unit === "bytes") return formatBytes(v);
		// Unitless: CLS needs decimals, counts do not.
		return Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(3);
	});

	/**
	 * A timestamp, formatted in UTC and labeled as such.
	 *
	 * The zone is pinned rather than left to the machine. Everything here is
	 * rendered once at build time, so "local" would mean local to whoever ran
	 * the build — the same page reads differently after a CI build than after
	 * one on your laptop, and neither says which. UTC is the one zone that is
	 * the same answer for every reader.
	 */
	$config.addFilter("date", (v, style = "short") => {
		if (!v) return "never";
		const d = new Date(v);
		if (style === "long") {
			// Explicit components, not dateStyle/timeStyle: Intl rejects those in
			// combination with timeZoneName, which is the whole point here.
			return d.toLocaleString("en-US", {
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
				timeZone: "UTC",
				timeZoneName: "short",
			});
		}
		return d.toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			timeZone: "UTC",
		});
	});

	/**
	 * Elapsed time as a bare duration: "12m", "5h", "3d".
	 *
	 * No "ago" and no "yesterday" — these sit in a column headed *Updated*,
	 * where the word is redundant and the mixed forms ("yesterday" next to
	 * "5h ago") make a column of values hard to scan. Anywhere the surrounding
	 * sentence needs a word, the template supplies it.
	 */
	/**
	 * A timestamp as the machine-readable form `<time datetime>` wants.
	 *
	 * Ages on this site are computed at build time and frozen into the HTML —
	 * "13m old" stays 13m however long the page sits open. Pairing each one with
	 * its own timestamp costs nothing now and is what a script would need to
	 * recompute them later, or to render them in the reader's own time zone.
	 *
	 * Both forms occur: measurement records carry an ISO string, while anything
	 * derived in the report carries epoch milliseconds.
	 */
	$config.addFilter("iso", (v) => {
		if (!v) return "";
		const d = v instanceof Date ? v : new Date(typeof v === "number" ? v : String(v));
		return Number.isNaN(d.getTime()) ? "" : d.toISOString();
	});

	$config.addFilter("since", (v) => {
		if (!v) return "never";

		const diff = Date.now() - new Date(v).getTime();
		const minutes = Math.floor(diff / 60000);
		if (minutes < 60) return `${Math.max(1, minutes)}m`;

		const hours = Math.floor(diff / 3600000);
		if (hours < 48) return `${hours}h`;

		return `${Math.floor(diff / 86400000)}d`;
	});

	/* ----------------------------------------------------------------- class */

	/**
	 * Lighthouse's own banding: <50 poor, 50–89 average, 90+ good.
	 *
	 * From lib/rank.js, because the leaderboard now ranks on these bands before
	 * it ranks on points. A local copy of "90" here would be a way for a row to
	 * be ranked as all-green while drawing an amber ring.
	 */
	$config.addFilter("scoreClass", scoreBand);

	$config.addFilter("ratingClass", (r) => {
		if (r === "good") return "good";
		if (r === "needs-improvement") return "average";
		if (r === "poor") return "poor";
		return "none";
	});

	$config.addFilter("deltaClass", (d) => {
		if (!d || d.unchanged || d.better === null) return "flat";
		return d.better ? "better" : "worse";
	});

	$config.addFilter("deltaArrow", (d) => {
		if (!d || d.unchanged) return "→";
		return d.change > 0 ? "↑" : "↓";
	});

	/** Signed, readable change text. */
	$config.addFilter("deltaText", function (d, unit = "") {
		if (!d) return "";
		if (d.unchanged) return "no change";

		const sign = d.change > 0 ? "+" : "-";
		const abs = Math.abs(d.change);

		let value;
		if (unit === "bytes") {
			value = abs < 1024 ? `${sign}${Math.round(abs)} B` : `${sign}${(abs / 1024).toFixed(1)} kB`;
		} else if (unit === "ms") {
			value = `${sign}${Math.round(abs)} ms`;
		} else {
			value = `${sign}${Number.isInteger(abs) ? abs : abs.toFixed(3)}`;
		}

		// A percentage that rounds to 0.0 adds nothing but noise — a 15 byte move
		// on a 3 MB page is not "0%", it's not worth a percentage at all.
		if (d.pct === null || Math.abs(d.pct) < 0.05) return value;

		return `${value} (${d.pct > 0 ? "+" : ""}${d.pct}%)`;
	});

	$config.addFilter("lowerIsBetter", lowerIsBetter);

	/**
	 * Pluralize a noun to match a count.
	 *
	 * `{{ 1 | plural("score") }}` -> "score", `{{ 2 | plural("score") }}` -> "scores".
	 * Pass an explicit plural for irregular nouns: `plural("entry", "entries")`.
	 */
	$config.addFilter("plural", (count, singular, plural) => {
		return count === 1 ? singular : plural || `${singular}s`;
	});

	/**
	 * A redirect-confirmation reason as a sentence.
	 *
	 * `confirmRedirect` returns machine-readable slugs. They read as jargon in a
	 * list — and "not-enough-measurements" repeated a hundred times says nothing
	 * at all about what is actually happening.
	 */
	$config.addFilter("redirectReason", (reason) => {
		return (
			{
				"not-enough-measurements": "Waiting for more measurements",
				unstable: "Destination keeps changing",
				temporary: "Temporary redirect",
				"no-redirect": "No longer redirecting",
			}[reason] || "Not yet confirmed"
		);
	});

	/**
	 * Why a reason means what it means, for the paragraph under each heading.
	 */
	$config.addFilter("redirectExplanation", (reason) => {
		return (
			{
				"not-enough-measurements":
					"A redirect has to lead to the same place on several consecutive runs before history follows it. We don’t know yet!",
				unstable:
					"The destination has not been consistent across recent runs. That pattern usually means an A/B test or a geo split rather than a move.",
				temporary:
					"An HTTP 302, 303 or 307 means a detour (not a move). History stays at the original URL.",
				"no-redirect": "These stopped redirecting before the move could be confirmed.",
			}[reason] || "Still being assessed."
		);
	});

	/** Count and correctly-pluralized noun together: "1 site", "3 sites". */
	$config.addFilter("countOf", (count, singular, plural) => {
		const word = count === 1 ? singular : plural || `${singular}s`;
		return `${(count ?? 0).toLocaleString("en-US")} ${word}`;
	});

	/**
	 * A data key as words. Lighthouse hands back camelCase identifiers, and they
	 * are rendered as labels rather than read as code.
	 *
	 *   styleLayout          -> style layout
	 *   paintCompositeRender -> paint composite render
	 *   parseHTML            -> parse HTML
	 *   third-party          -> third party
	 *
	 * Acronyms are kept whole — the second pass is what stops `parseHTML` from
	 * coming out as "parse H T M L", and the all-caps test is what keeps it from
	 * then being lowercased back to "parse html".
	 *
	 * Display casing is the stylesheet's job, so what lands in the markup is
	 * ordinary words — a copy-paste gives "time to first byte", not the
	 * half-capitalized "time To First Byte" the split leaves behind.
	 */
	$config.addFilter("humanize", (value) => {
		return String(value ?? "")
			.replace(/([a-z\d])([A-Z])/g, "$1 $2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
			.replace(/[-_]+/g, " ")
			.trim()
			.split(/\s+/)
			.map((word) => (/^[A-Z\d]+$/.test(word) ? word : word.toLowerCase()))
			.join(" ");
	});

	/** Subject-verb agreement for a count: "1 site **has**", "3 sites **have**". */
	$config.addFilter("verb", (count, singular, plural) => (count === 1 ? singular : plural));

	/* ------------------------------------------------------------- sparkline */

	/**
	 * Inline SVG sparkline, rendered at build time.
	 *
	 * Deliberately not a charting library: the whole point of this project is
	 * static output, and a 40-point trend line does not justify shipping
	 * JavaScript to draw it.
	 */
	$config.addShortcode("sparkline", function (trend, opts = {}) {
		const width = opts.width || 120;
		const height = opts.height || 28;
		const padding = 2;

		const values = trend?.values;
		if (!values?.length) return "";
		if (values.length === 1) {
			return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><circle cx="${width / 2}" cy="${height / 2}" r="2" class="spark-dot"/></svg>`;
		}

		const min = Math.min(...values);
		const max = Math.max(...values);
		const range = max - min || 1;
		const stepX = (width - padding * 2) / (values.length - 1);

		const points = values.map((v, i) => {
			const x = padding + i * stepX;
			// Flip: SVG y grows downward, and we always draw "up" as the larger value.
			const y = height - padding - ((v - min) / range) * (height - padding * 2);
			return [x, y];
		});

		const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
		const area = `${line} L${points[points.length - 1][0].toFixed(1)},${height} L${points[0][0].toFixed(1)},${height} Z`;

		// Color by whether the series moved in the good direction overall.
		const better = trend.sinceFirst?.better;
		const tone = better === null || better === undefined ? "flat" : better ? "better" : "worse";
		const [lastX, lastY] = points[points.length - 1];

		const label = `${trend.label || trend.key}: ${values.length} measurements, ${min} to ${max}`;

		return [
			`<svg class="spark spark-${tone}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"`,
			` role="img" aria-label="${escapeAttr(label)}">`,
			`<path class="spark-area" d="${area}"/>`,
			`<path class="spark-line" d="${line}"/>`,
			`<circle class="spark-dot" cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2"/>`,
			`</svg>`,
		].join("");
	});

	/**
	 * A score as a ring, rendered at build time.
	 *
	 * Speedlify draws these with a web component that inlines the whole result
	 * as JSON per row. The same picture is a circle with a dash offset, so it
	 * costs one SVG and no JavaScript.
	 *
	 * The geometry is shared with <speedlify-score> — see `static geometry` in
	 * src/js/speedlify-score.js. 37 across with 3 of stroke leaves a 31-unit
	 * hole for 12-unit text, which is the padding the component has always had;
	 * the two draw the same ring, so a badge embedded elsewhere and the ring it
	 * links back to here do not read as two different components.
	 *
	 * `pct` is what fills the arc, and it is not always the value: an axe count
	 * and a Core Web Vitals verdict have no percentage, so they pass 1 and read
	 * as a closed ring whose color carries the answer. `null` leaves the track
	 * bare, which is how "no data" looks in both renderers.
	 */
	function ring({ band, text, label, pct, sublabel = "", size = 37 }) {
		const stroke = 3;
		const r = (size - stroke) / 2;
		const c = size / 2;
		const circumference = 2 * Math.PI * r;
		// Dash the arc to the value, and rotate so it starts at 12 o'clock.
		const dash = `${(circumference * Math.max(0, Math.min(1, pct ?? 0))).toFixed(2)} ${circumference.toFixed(2)}`;

		/*
		 * A sublabel shifts the value up to make room beneath it, both still
		 * inside the ring. The pair is centered as a block rather than the value
		 * staying put: a glyph pinned to the middle with text under it reads as
		 * top-heavy, and there is only so much room before the descender of the
		 * label meets the stroke.
		 */
		const valueY = sublabel ? c - 3.5 : c;

		return [
			`<svg class="ring ring-${band}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"`,
			` role="img" aria-label="${escapeAttr(label)}">`,
			`<circle class="ring-track" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${stroke}"/>`,
			typeof pct === "number"
				? `<circle class="ring-arc" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${stroke}"` +
					` stroke-dasharray="${dash}" stroke-linecap="round" transform="rotate(-90 ${c} ${c})"/>`
				: "",
			`<text class="ring-text" x="${c}" y="${valueY}" text-anchor="middle" dominant-baseline="central">`,
			`${escapeAttr(text)}</text>`,
			sublabel
				? `<text class="ring-sublabel" x="${c}" y="${c + 7}" text-anchor="middle" dominant-baseline="central">` +
					`${escapeAttr(sublabel)}</text>`
				: "",
			`</svg>`,
		].join("");
	}

	/** One of the four Lighthouse categories: the arc is the score itself. */
	$config.addShortcode("scoreRing", function (value, label = "", size = 37) {
		return ring({
			band: scoreBand(value),
			text: value ?? "–",
			label: label ? `${label}: ${value ?? "no data"}` : String(value ?? "no data"),
			pct: typeof value === "number" ? value / 100 : null,
			size,
		});
	});

	/**
	 * A violation count short enough to fit inside a ring.
	 *
	 * The only ring value that can outgrow its circle. Lighthouse scores stop at
	 * 100 and Core Web Vitals is a glyph, but axe counts violating *nodes* — one
	 * bad rule on a long table is thousands — and four digits at this size render
	 * 32 units wide in a 31-unit hole, spilling over the stroke and onto the
	 * neighboring rings, which do not clip because the stroke's round cap needs
	 * overflow visible.
	 *
	 * The exact number stays in the label, so this costs nothing but precision no
	 * one reads off a 12-unit glyph anyway.
	 */
	function shortCount(n) {
		if (n < 1000) return String(n);
		const k = n / 1000;
		if (k < 10) return `${k.toFixed(1).replace(/\.0$/, "")}k`;
		if (k < 99.5) return `${Math.round(k)}k`;
		return "99k+";
	}

	/**
	 * Axe violations. Banded by lib/rank.js, which ranks on these bands before it
	 * ranks on points — a local copy of the thresholds here is how a row ends up
	 * ranked above one it visibly ties with.
	 */
	/**
	 * Accessibility violations, shown as a verdict rather than a count.
	 *
	 * Three glyphs for the three bands: clean, some, many. A number here was the
	 * odd one out on a row of six rings — the other five are read as "higher is
	 * better" or as a tick, and "13" in the middle of them reads as a score of
	 * thirteen rather than as thirteen faults. The count is still the whole
	 * point, so it stays: in the tooltip, and in the ranking, which bands on the
	 * raw figure exactly as before.
	 */
	$config.addShortcode("axeRing", function (axe, size = 37, label = null) {
		// A number where the caller has one already — the median tile passes a
		// figure rather than a site's axe record.
		const value = typeof axe === "number" ? axe : axe && !axe.error ? axe.violations : null;
		if (typeof value !== "number") {
			return ring({ band: "none", text: "–", sublabel: "AXE", label: label ?? "Axe: did not run", pct: null, size });
		}

		const rules = typeof axe === "number" ? null : axe.violationRules;
		const band = axeBand(value);
		return ring({
			band,
			// ✓ clean · ! some · ✗ many. The bands are unchanged, so the glyph and
			// the ranking always agree — see axeBand in lib/rank.js.
			text: band === "good" ? "✓" : band === "average" ? "!" : "✗",
			// Labeled like the CWV ring beside it: without it a tick is read by
			// guesswork, and the others are read by position.
			sublabel: "AXE",
			label:
				label ??
				`Axe: ${value} violating node${value === 1 ? "" : "s"}` +
					(typeof rules === "number" ? ` across ${rules} rule${rules === 1 ? "" : "s"}` : ""),
			pct: 1,
			size,
		});
	});

	/**
	 * Core Web Vitals, which is a verdict rather than a number.
	 *
	 * A glyph instead of a count, matching the component: the underlying figure
	 * is three separate metrics, and one of them failing is the whole answer as
	 * far as the ranking is concerned. How many, and which, is in the label.
	 */
	$config.addShortcode("cwvRing", function (failures, assessed, size = 37, label = null) {
		if (typeof failures !== "number") {
			return ring({
				band: "none",
				text: "–",
				sublabel: "CWV",
				label: label ?? "Core Web Vitals: no real-user data — not counted in the ranking",
				pct: null,
				size,
			});
		}

		return ring({
			band: cwvBand(failures),
			text: failures === 0 ? "✓" : "✗",
			// The one ring whose value is a verdict rather than a number, so it is
			// the one that does not say what it is measuring. The others are read
			// by position; a tick is read by guesswork without this.
			sublabel: "CWV",
			// Overridable because the same ring serves a site's own verdict and a
			// median across the fleet, and "0 of ? failing" is only true of one.
			label: label ?? `Core Web Vitals: ${failures} of ${assessed ?? "?"} failing at p75`,
			pct: 1,
			size,
		});
	});

	/**
	 * A freshness window as a cadence: "once a day", "once a week".
	 *
	 * The stored figure is a *minimum age* — a site is not eligible again until
	 * its data is this old — which is the same thing as a cadence only because
	 * there is capacity to measure everything that becomes eligible. That holds
	 * today at roughly 960 sites a day against 1,566 configured; it would stop
	 * holding if the list grew much faster than the schedule.
	 */
	/**
	 * A span of hours, said the way someone would say it.
	 *
	 * Hours up to two days, because "36h" is a length a reader holds in their
	 * head; days past that, because "336h" is not — it is a number to be divided
	 * before it means anything.
	 *
	 * Distinct from `cadence` above, which answers "how often" and returns a
	 * phrase. This answers "how long" and returns a quantity.
	 */
	$config.addFilter("duration", (hours) => {
		if (typeof hours !== "number" || hours <= 0) return "";
		if (hours < 48) return `${hours}h`;

		const days = hours / 24;
		const rounded = Number.isInteger(days) ? days : Math.round(days * 10) / 10;
		return `${rounded} ${rounded === 1 ? "day" : "days"}`;
	});

	$config.addFilter("cadence", (hours) => {
		if (typeof hours !== "number" || hours <= 0) return null;
		if (hours === 24) return "once a day";
		if (hours === 24 * 7) return "once a week";
		if (hours % (24 * 7) === 0) return `every ${hours / (24 * 7)} weeks`;
		if (hours % 24 === 0) return `every ${hours / 24} days`;
		if (hours === 1) return "once an hour";
		return `every ${hours} hours`;
	});

	/** A number with its sign always shown: +27, -12, 0. */
	$config.addFilter("signed", (value) => {
		if (typeof value !== "number") return "";
		return value > 0 ? `+${value}` : String(value);
	});

	/** One group from the report's list, by id. */
	$config.addFilter("groupById", (groups, id) => (groups || []).find((g) => g.id === id) ?? null);

	/**
	 * A copy of an array sorted by one property, case-insensitively.
	 *
	 * On a copy, for the same reason `shuffle` is: these arrays belong to the
	 * report and are shared with every other template on the page.
	 *
	 * `localeCompare` rather than `<`, so accented and non-Latin names sort where
	 * a reader would look for them instead of by code point. `numeric` keeps
	 * `2.example` before `10.example`.
	 */
	$config.addFilter("sortBy", (list, key) => {
		if (!Array.isArray(list)) return list;

		return [...list].sort((a, b) =>
			String(a?.[key] ?? "").localeCompare(String(b?.[key] ?? ""), "en", {
				sensitivity: "base",
				numeric: true,
			}),
		);
	});

	/**
	 * A copy of an array in random order.
	 *
	 * Fisher–Yates, and on a copy: the arrays these come from are the report's
	 * own, shared with every other template on the page, and shuffling one in
	 * place would reorder a leaderboard somewhere else.
	 *
	 * Reshuffles on every build, which is the point where it is used — a list too
	 * long to read has no fair order, and a fixed one would put the same sites at
	 * the bottom of it for ever.
	 */
	$config.addFilter("shuffle", (list) => {
		if (!Array.isArray(list)) return list;

		const out = [...list];
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	});

	/** 🥇🥈🥉 for the top three, nothing for everyone else. */
	$config.addFilter("trophy", (rank) => {
		if (rank === 1) return "🥇";
		if (rank === 2) return "🥈";
		if (rank === 3) return "🥉";
		return "";
	});

	/**
	 * A site's URL substituted into an image service's URL template.
	 *
	 * These are the only external requests the built site makes: a favicon per
	 * leaderboard row, and a screenshot per site page. Set the matching
	 * `meta.*Service` to "" to drop either and keep the output self-contained —
	 * worth considering for a tool that measures page weight.
	 *
	 * The URL is encoded because both services take it as a path segment, where
	 * an unescaped `https://` would read as three segments.
	 */
	function imageService(url, service) {
		if (!service) return "";
		return service.replace("{url}", encodeURIComponent(url));
	}

	$config.addFilter("avatar", imageService);
	$config.addFilter("screenshot", imageService);

	/**
	 * Brand icon for a detected generator or host, as inline SVG.
	 *
	 * Path data comes from simple-icons at build time, so the published page
	 * stays self-contained — no icon font, no sprite sheet, no extra request.
	 * Falls back to a text chip when there is no icon for the brand, which is
	 * common for smaller hosts and one-off generators.
	 *
	 * `src/icons/<Name>.svg` overrides or supplies a mark simple-icons doesn't
	 * carry — Amazon and CloudFront are the notable gaps, their marks having
	 * been removed from the project at Amazon's request.
	 */
	$config.addShortcode("stackIcon", function (detected, size = 16) {
		if (!detected) return "";

		// `detail` is the finer-grained thing behind a bucketed name — the actual
		// daemon behind "Self-hosted". Worth a tooltip, not a column.
		let label = detected.version ? `${detected.name} ${detected.version}` : detected.name;
		if (detected.detail) label += ` · ${detected.detail}`;
		// A presumption is the category's claim, not a measurement. Same glyph so
		// it is recognizable, faded so it never reads as a detection.
		if (detected.presumed) label = `Listed as ${detected.name} — no generator tag found on the page`;
		const presumed = detected.presumed ? " stack-presumed" : "";
		// Font Awesome first where it has the brand: one symbol per page and a
		// short reference per row, rather than the same path inlined once per
		// site. Brand color is carried over from simple-icons when that project
		// has an entry, since Font Awesome's marks are monochrome by design.
		const faName = fontAwesomeSlug(detected.icon);
		if (faName) {
			// BRAND_COLORS first, for brands simple-icons has no entry for and so
			// no hex to lend.
			const hex = BRAND_COLORS[detected.icon] ?? simpleIcons[`si${detected.icon}`]?.hex ?? null;
			const luminance = hex ? relativeLuminance(hex) : null;
			const usesBrandColor = luminance !== null && luminance > 0.06 && luminance < 0.85;

			return [
				`<i class="fa-brands fa-${faName} stack-icon${usesBrandColor ? "" : " stack-icon-mono"}${presumed}"`,
				` width="${size}" height="${size}"`,
				usesBrandColor ? ` style="color:#${hex}"` : "",
				`>${escapeAttr(label)}</i>`,
			].join("");
		}

		const icon = detected.icon ? (localIcons[detected.icon] ?? simpleIcons[`si${detected.icon}`]) : null;

		if (!icon) {
			// A bucketed row has no mark of its own, but the thing behind it might
			// — nginx and Apache have logos, "Self-hosted" does not. Put that mark
			// inside the chip: the chip still says "this is a bucket", and the mark
			// says which member. Always monochrome, since it is sitting on the
			// chip's own muted background rather than the page.
			const detailIcon = detected.detailIcon
				? (localIcons[detected.detailIcon] ?? simpleIcons[`si${detected.detailIcon}`])
				: null;
			if (detailIcon) {
				return [
					`<span class="stack-chip stack-chip-icon${presumed}" title="${escapeAttr(label)}">`,
					`<svg width="11" height="11" viewBox="${escapeAttr(detailIcon.viewBox ?? "0 0 24 24")}"`,
					` role="img" aria-label="${escapeAttr(label)}" fill="currentColor">`,
					`<title>${escapeAttr(label)}</title>`,
					`<path d="${detailIcon.path}"/>`,
					`</svg></span>`,
				].join("");
			}

			// Nothing to show but a name — initial letters. The detail is what
			// distinguishes one bucketed row from the next, so it names the chip
			// when there is one.
			const chip = (detected.detail ?? detected.name).slice(0, 2);
			return `<span class="stack-chip${presumed}" title="${escapeAttr(label)}">${escapeAttr(chip)}</span>`;
		}

		// Several brands — Vercel, Next.js, GitHub, Eleventy — are pure black, and
		// a black mark on a #2e2e2e page is invisible. Any brand color too close
		// to either end of the range is dropped in favour of `currentColor`, so
		// the icon follows the theme's text color instead. Those marks are
		// recognizable by shape, and a visible glyph beats an accurate one.
		// BRAND_COLORS wins over the icon's own hex, same as in the Font Awesome
		// branch above — an override there has to mean the same thing here.
		const hex = BRAND_COLORS[detected.icon] ?? icon.hex;
		const luminance = relativeLuminance(hex);
		const usesBrandColor = luminance > 0.06 && luminance < 0.85;
		const fill = usesBrandColor ? `#${hex}` : "currentColor";

		return [
			`<svg class="stack-icon${usesBrandColor ? "" : " stack-icon-mono"}${presumed}"`,
			` width="${size}" height="${size}" viewBox="${escapeAttr(icon.viewBox ?? "0 0 24 24")}"`,
			` role="img" aria-label="${escapeAttr(label)}" fill="${fill}">`,
			`<title>${escapeAttr(label)}</title>`,
			`<path d="${icon.path}"/>`,
			`</svg>`,
		].join("");
	});

	/**
	 * The four phases of LCP as one stacked proportion bar.
	 *
	 * Deliberately normalized to the sum of the phases rather than to the LCP
	 * value shown beside it, because the two are not on the same scale. With
	 * simulated throttling — which is how everything here is measured — the
	 * reported LCP is Lantern's simulation of a slow connection, while these
	 * subparts come from the observed trace, which ran at the machine's own
	 * speed. On this corpus that is a factor of ten to twenty, varying by site,
	 * so drawing the phases against the LCP number would produce a bar that
	 * covers a tenth of its track and means nothing.
	 *
	 * What survives the difference is the shape: which phase dominates. That is
	 * the whole question the breakdown answers — server, discovery, download or
	 * render — and it is what this bar shows.
	 *
	 * Lighthouse omits the two resource phases entirely when the LCP element is
	 * text, so the bar is two segments there rather than four.
	 */
	$config.addShortcode("lcpBar", function (breakdown, lcp) {
		if (!breakdown) return "";

		const parts = LCP_SUBPARTS.map((part) => ({ ...part, value: breakdown[part.key] })).filter(
			(part) => typeof part.value === "number" && part.value > 0,
		);

		const total = parts.reduce((sum, part) => sum + part.value, 0);
		if (!total) return "";

		// Length carries the LCP, so a two-second bar is twice a one-second bar.
		// Against a fixed scale rather than the table's own maximum: one slow
		// outlier would otherwise squash every other row on the page, and the
		// bars would mean something different on each page they appear.
		if (typeof lcp !== "number" || lcp <= 0) return "";

		const rowPx = (LCP_BAR_SCALE_MS / 1000) * LCP_BAR_PX_PER_SECOND;
		const wanted = (lcp / 1000) * LCP_BAR_PX_PER_SECOND;
		const drawn = Math.min(wanted, rowPx * LCP_BAR_MAX_ROWS);
		const clipped = wanted > drawn + 0.5;

		// Percentage only, no milliseconds. The subpart durations are observed
		// rather than simulated, so printing "4.1ms" beside a cell reading "1.2s"
		// would read as a contradiction rather than as a different measurement of
		// the same load.
		const title = (part) => `${part.label} — ${Math.round((part.value / total) * 100)}% of the time to LCP`;

		// Lay the phases end to end along the whole length, then cut that ribbon
		// into lines. A phase landing on a line break is split across both — the
		// bar is one timeline that happens to be folded, not four bars.
		const rows = [[]];
		let used = 0;

		for (let part of parts) {
			let remaining = (part.value / total) * drawn;

			while (remaining > 0.05) {
				const take = Math.min(remaining, rowPx - used);

				rows[rows.length - 1].push(
					`<span class="lcp-seg lcp-seg-${part.key}" style="width:${take.toFixed(1)}px" title="${escapeAttr(title(part))}"></span>`,
				);

				used += take;
				remaining -= take;

				if (used >= rowPx - 0.05 && remaining > 0.05) {
					rows.push([]);
					used = 0;
				}
			}
		}

		return [
			`<span class="lcp-bar${clipped ? " lcp-bar-clipped" : ""}"`,
			clipped ? ` title="${escapeAttr(`Bar stops at ${(rowPx * LCP_BAR_MAX_ROWS) / LCP_BAR_PX_PER_SECOND}s — see the number for the rest`)}"` : "",
			`>`,
			rows.map((row) => `<span class="lcp-row">${row.join("")}</span>`).join(""),
			`</span>`,
		].join("");
	});

	/** Horizontal proportion bar, used for resource-type and third-party splits. */
	$config.addShortcode("bar", function (value, max, tone = "neutral") {
		if (typeof value !== "number" || !max) return "";
		const pct = Math.max(0, Math.min(100, (value / max) * 100));
		return `<span class="bar bar-${tone}"><span class="bar-fill" style="width:${pct.toFixed(1)}%"></span></span>`;
	});

	/* --------------------------------------------------------------- helpers */

	$config.addFilter("sortByValue", (obj) => {
		if (!obj) return [];
		return Object.entries(obj)
			.filter(([, v]) => typeof v === "number" && v > 0)
			.sort((a, b) => b[1] - a[1])
			.map(([key, value]) => ({ key, value }));
	});

	$config.addFilter("maxValue", (list, key) => {
		const nums = (list || []).map((i) => (key ? i[key] : i)).filter((n) => typeof n === "number");
		return nums.length ? Math.max(...nums) : 0;
	});

	$config.addFilter("keep", (list, key) => (list || []).filter((i) => i && i[key]));

	$config.addFilter("limit", (list, n) => (list || []).slice(0, n));

	$config.addFilter("json", (v) => JSON.stringify(v, null, 2));

	return {
		dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
		markdownTemplateEngine: "njk",
		htmlTemplateEngine: "njk",
	};
}

function escapeAttr(s) {
	return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** WCAG relative luminance for a 6-digit hex color, 0 (black) to 1 (white). */
function relativeLuminance(hex) {
	const n = Number.parseInt(hex, 16);
	if (!Number.isFinite(n)) return 0.5;

	const channel = (v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};

	const r = channel((n >> 16) & 255);
	const g = channel((n >> 8) & 255);
	const b = channel(n & 255);

	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
