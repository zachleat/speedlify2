import { createHash } from "node:crypto";

/**
 * When a site's HTML is generated: at build time, on each request, or on request and then cached.
 *
 * Read from the main document of page loads the measurement already makes, so it costs no extra requests.
 */

/** Response headers that say how a document was produced or cached. */
export const RENDER_HEADERS = [
	"age",
	"etag",
	"last-modified",
	"cache-status",
	"cf-cache-status",
	"cf-apo-via",
	"x-cache",
	"x-vercel-cache",
	"x-nextjs-cache",
	"x-nextjs-prerender",
	"x-litespeed-cache",
	"x-kinsta-cache",
	"x-proxy-cache",
	"x-nananana",
	"content-security-policy",
];

/** Generators whose output is always static files. */
const STATIC_GENERATORS = new Set([
	"build-awesome",
	"eleventy",
	"hugo",
	"jekyll",
	"docusaurus",
	"hexo",
	"gridsome",
	"quarto",
	"pandoc",
	"lume",
	"silex",
	"vitepress",
	"vuepress",
	"mkdocs",
	"pelican",
	"zola",
	"publii",
]);

/** Generators that render on the server for every request unless a page cache sits in front. */
const SERVER_GENERATORS = /^(wordpress|elementor|drupal|ghost)/;

/** Page cache plugins and the comment each leaves in the HTML. */
const CACHE_PLUGINS = [
	{ name: "WP Super Cache", comment: /WP-Super-Cache|Dynamic page generated in/i },
	{ name: "W3 Total Cache", comment: /W3 Total Cache/i },
	{ name: "WP Rocket", comment: /WP Rocket/i },
	{ name: "LiteSpeed Cache", comment: /LiteSpeed Cache/i },
	{ name: "WP Fastest Cache", comment: /WP Fastest Cache/i },
];

/** Headers set by a page cache in front of a server renderer, and its name. */
const CACHE_HEADERS = [
	{ header: "x-litespeed-cache", name: "LiteSpeed Cache" },
	{ header: "x-kinsta-cache", name: "Kinsta" },
	{ header: "cf-apo-via", name: "Cloudflare APO" },
	{ header: "x-nananana", name: "Batcache" },
	{ header: "x-proxy-cache", name: "a proxy cache" },
];

const STAMP = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|\d{2}-\d{2}-\d{2,4} \d{2}:\d{2}:\d{2}|cached@\d+|(?:generated|created) in [\d.]+ seconds/i;

function shortHash(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function pickRenderHeaders(headers = {}) {
	const out = {};
	for (const [key, value] of Object.entries(headers || {})) {
		const k = key.toLowerCase();
		if (RENDER_HEADERS.includes(k)) out[k] = String(value).slice(0, 120);
	}
	return out;
}

/** Every per-request nonce on the document, from the CSP header and `nonce` attributes. */
function nonces(html, csp = "") {
	const found = new Set();
	for (const m of csp.matchAll(/'nonce-([^']+)'/g)) found.add(m[1]);
	for (const m of html.matchAll(/\snonce=["']?([^"'\s>]+)/gi)) found.add(m[1]);
	return [...found].sort();
}

/**
 * The document with what varies per request for reasons other than rendering removed.
 *
 * Comments hold cache timestamps and render timings, and Cloudflare injects per-request tokens into static files.
 */
export function normalizeDocument(html) {
	return html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\snonce=("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*__CF\$cv\$params[\s\S]*?<\/script>/g, "")
		.replace(/\sdata-cf(?:email|-beacon|-settings)=("[^"]*"|'[^']*')/g, "")
		.replace(/\/cdn-cgi\/l\/email-protection#[0-9a-f]+/g, "")
		.replace(/\b[0-9a-f]{20,}-(text\/javascript|module)\b/g, "$1");
}

/** Build and render flags a framework writes into the document. */
function frameworkMarks(html) {
	const marks = [];
	const next = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
	if (next) {
		try {
			const data = JSON.parse(next[1]);
			if (data.gssp) marks.push("next-gssp");
			if (data.gsp) marks.push("next-gsp");
			if (data.nextExport) marks.push("next-export");
			if (data.autoExport) marks.push("next-auto-export");
		} catch {}
	}
	const nuxt = html.match(/<script[^>]+id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
	if (nuxt && /"prerenderedAt"/.test(nuxt[1])) marks.push("nuxt-prerendered");
	// Nuxt 2's `nuxt generate` points its payloads at a build-stamped static directory.
	if (/window\.__NUXT__[\s\S]{0,20000}staticAssetsBase/.test(html)) marks.push("nuxt-prerendered");
	return marks;
}

/** The page cache plugin comment on a document, and the timestamp or timing it carries. */
function cacheStamp(html) {
	for (const m of html.matchAll(/<!--([\s\S]*?)-->/g)) {
		const plugin = CACHE_PLUGINS.find((p) => p.comment.test(m[1]));
		if (plugin) return { plugin: plugin.name, at: m[1].match(STAMP)?.[0] ?? null };
	}
	return null;
}

/** What one page load's main document says about how it was produced, small enough to store on every record. */
export function documentSample(html, headers = {}, { fromCache = false } = {}) {
	if (typeof html !== "string" || !html) return null;
	const picked = pickRenderHeaders(headers);
	const found = nonces(html, picked["content-security-policy"]);
	delete picked["content-security-policy"];

	return {
		hash: shortHash(normalizeDocument(html)),
		nonce: found.length ? shortHash(found.join(" ")) : null,
		stamp: cacheStamp(html),
		marks: frameworkMarks(html),
		headers: picked,
		...(fromCache ? { fromCache: true } : {}),
	};
}

/** The main document of a Lighthouse run, read from artifacts it already gathered. */
export function lighthouseSample(artifacts) {
	const html = artifacts?.MainDocumentContent;
	const url = artifacts?.URL?.mainDocumentUrl;
	const response = (artifacts?.DevtoolsLog || []).find(
		(e) => e.method === "Network.responseReceived" && e.params?.type === "Document" && e.params.response?.url === url,
	)?.params?.response;
	return documentSample(html, response?.headers, { fromCache: Boolean(response?.fromDiskCache) });
}

/** Whether a page cache served this load, or null when no header says. */
export function cacheStatus(headers = {}) {
	const h = headers || {};
	const status = (value) => (/\b(hit|stale)\b/i.test(value) ? "hit" : /\b(miss|expired|bypass)\b|fwd=/i.test(value) ? "miss" : null);
	for (const key of ["x-litespeed-cache", "x-kinsta-cache", "x-proxy-cache", "x-nextjs-cache", "x-vercel-cache", "cf-cache-status", "x-cache", "cache-status"]) {
		if (h[key]) {
			const s = status(h[key]);
			if (s) return s;
		}
	}
	if (/tcache/i.test(h["cf-apo-via"] ?? "")) return "hit";
	if (/batcache-hit/i.test(h["x-nananana"] ?? "")) return "hit";
	if (Number(h.age) > 0) return "hit";
	return null;
}

function cacheLayer(samples) {
	for (const s of samples) {
		const found = CACHE_HEADERS.find(({ header }) => s.headers?.[header]);
		if (found) return found.name;
	}
	return samples.find((s) => s.stamp)?.stamp.plugin ?? null;
}

const RESULTS = {
	build: "At build time",
	request: "On each request",
	cached: "On request, then cached",
	likely: "Probably at build time",
};

function result(id, detail) {
	return { id, name: RESULTS[id], detail };
}

const differs = (values) => new Set(values).size > 1;

/**
 * When the document was generated, from the samples of one measurement.
 *
 * Request-time is only claimed on positive evidence, and an unknown degrades to null.
 */
export function detectRender(samples, generator = null) {
	const all = (samples || []).filter(Boolean);
	if (!all.length) return null;
	const fresh = all.filter((s) => !s.fromCache);
	const has = (mark) => all.some((s) => s.marks?.includes(mark));
	const header = (name, pattern) => all.some((s) => pattern.test(s.headers?.[name] ?? ""));

	if (has("next-gssp")) return result("request", "getServerSideProps in __NEXT_DATA__");
	if (header("x-nextjs-prerender", /^1$/)) return result("build", "x-nextjs-prerender header");
	if (header("x-vercel-cache", /^prerender$/i)) return result("build", "x-vercel-cache: PRERENDER");
	if (has("next-export") || has("next-auto-export")) return result("build", "Static export in __NEXT_DATA__");
	if (has("next-gsp")) return result("build", "getStaticProps in __NEXT_DATA__");
	if (has("nuxt-prerendered")) return result("build", "Prerendered Nuxt payload");

	if (fresh.length >= 2) {
		if (differs(fresh.map((s) => s.nonce))) return result("request", "CSP nonce changed between loads");
		const stamps = fresh.map((s) => s.stamp?.at).filter(Boolean);
		if (differs(stamps)) return result("request", `${fresh.find((s) => s.stamp).stamp.plugin} timestamp changed between loads`);
		if (differs(fresh.map((s) => s.hash))) return result("request", "Document changed between loads");
	}

	if (generator?.id && SERVER_GENERATORS.test(generator.id)) {
		const layer = cacheLayer(all);
		const hit = all.some((s) => cacheStatus(s.headers) === "hit");
		if (hit || layer) return result("cached", layer ? `Served by ${layer}` : "Page cache hit");
		return result("request", `${generator.name}, no page cache detected`);
	}

	if (generator?.id && STATIC_GENERATORS.has(generator.id)) return result("build", `${generator.name} builds static pages`);
	if (header("x-nextjs-cache", /./)) return result("cached", "Next.js cache");
	if (fresh.length >= 2) return result("likely", `Same document on ${fresh.length} loads`);
	return null;
}
