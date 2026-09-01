/**
 * What built a site, and who serves it.
 *
 * Both are read from the page we already load for the axe pass — no extra
 * request. That matters: the address book is thousands of personal sites, and
 * a second page load per site to satisfy curiosity would be rude.
 *
 * Detection is best-effort and always degrades to `null` rather than guessing.
 * A wrong badge is worse than no badge.
 */

/** Response headers worth keeping; anything else is noise. */
export const HOST_HEADERS = [
	"server",
	"x-powered-by",
	"via",
	"x-vercel-id",
	"x-nf-request-id",
	"x-served-by",
	"cf-ray",
	"x-github-request-id",
	"x-amz-cf-id",
	"x-fastly-request-id",
	"fly-request-id",
	"x-render-origin-server",
	"x-deno-execution-id",
	"x-cloud-trace-context",
];

/**
 * Hosts, most specific first.
 *
 * Order is the whole trick here. A site can sit on Netlify *behind* Cloudflare
 * and send signals for both — docusaurus.io does exactly that. The origin is
 * the more interesting answer, so origin-specific request ids are checked
 * before the generic CDN `server` header that fronts them.
 */
const HOSTS = [
	{ id: "netlify", name: "Netlify", icon: "Netlify", header: "x-nf-request-id" },
	{ id: "vercel", name: "Vercel", icon: "Vercel", header: "x-vercel-id" },
	{ id: "github", name: "GitHub Pages", icon: "Github", header: "x-github-request-id" },
	{ id: "fly", name: "Fly.io", icon: "Flydotio", header: "fly-request-id" },
	{ id: "render", name: "Render", icon: "Render", header: "x-render-origin-server" },
	{ id: "deno", name: "Deno Deploy", icon: "Deno", header: "x-deno-execution-id" },

	/*
	 * Fall back to whatever `server` says.
	 *
	 * Several providers stamp the responding point-of-presence into this header
	 * — Bunny sends `BunnyCDN-MSP1-1084` from one PoP and `Bunny-NET-CDN-KC1-937`
	 * from another. Without a rule per provider each PoP becomes its own "host"
	 * in the tally, so one CDN shows up as a dozen entries of one.
	 */
	{ id: "bunny", name: "Bunny CDN", icon: null, server: /bunny/i },
	// Railway's TLS terminator identifies itself as railway-hikari; its newer
	// edge proxy as railway-edge. Both are Railway.
	{ id: "railway", name: "Railway", icon: "Railway", server: /^railway[-\s]/i },
	// simple-icons carries no Amazon mark — drop one at src/icons/Amazon.svg and
	// it appears; without the file this falls back to a text chip.
	{ id: "amazons3", name: "Amazon S3", icon: "Amazon", server: /^amazons3/i },
	/*
	 * Akamai answers as `AkamaiGHost`, which without a rule becomes the host's
	 * display name — eight of the Big Tech sites read "AkamaiGHost" rather than
	 * "Akamai". Matched loosely because the same edge also answers as
	 * `AkamaiNetStorage` and `Akamai Resource Optimizer` depending on the product
	 * in front of the origin, and all of them are Akamai.
	 */
	{ id: "akamai", name: "Akamai", icon: "Akamai", server: /akamai/i },
	{ id: "cloudflare", name: "Cloudflare", icon: "Cloudflare", server: /cloudflare/i },
	{ id: "netlify", name: "Netlify", icon: "Netlify", server: /netlify/i },
	{ id: "vercel", name: "Vercel", icon: "Vercel", server: /vercel/i },
	{ id: "github", name: "GitHub Pages", icon: "Github", server: /github\.com/i },
	{ id: "fastly", name: "Fastly", icon: "Fastly", server: /fastly/i },
	// Google's edge, which fronts App Engine, Cloud Run, Firebase Hosting and
	// Blogger alike — so the name stays as the header gives it rather than
	// claiming a product. Anchored: the string is the whole value, and an
	// unanchored /google/ would also catch a proxy that merely mentions it.
	{ id: "google", name: "Google Frontend", icon: "Google", server: /^google frontend/i },
	{ id: "cloudfront", name: "CloudFront", icon: null, server: /cloudfront/i },
];

/**
 * Web servers, which are not hosts.
 *
 * `server: nginx` says which daemon answered, not who runs the machine — and
 * every provider above runs one of these too, they just say something more
 * useful instead. So a bare daemon name is the *absence* of a provider
 * signature, which in practice means self-hosted or an unidentified host.
 *
 * Checked only after every provider rule has missed, so `cloudflare-nginx`
 * still reads as Cloudflare.
 */
const SERVER_SOFTWARE = [
	{ name: "nginx", pattern: /nginx|tengine/i, icon: "Nginx" },
	{ name: "Apache", pattern: /apache|httpd/i, icon: "Apache" },
	{ name: "LiteSpeed", pattern: /litespeed/i },
	{ name: "Caddy", pattern: /caddy/i, icon: "Caddy" },
	{ name: "OpenResty", pattern: /openresty/i },
	{ name: "IIS", pattern: /iis|microsoft-httpapi/i },
	{ name: "lighttpd", pattern: /lighttpd/i },
	{ name: "Traefik", pattern: /traefik/i, icon: "Traefikproxy" },
	{ name: "Envoy", pattern: /envoy/i, icon: "Envoyproxy" },
	{ name: "HAProxy", pattern: /haproxy/i },
	{ name: "Varnish", pattern: /varnish/i },
	{ name: "Jetty", pattern: /jetty/i, icon: "Eclipsejetty" },
	{ name: "Tomcat", pattern: /tomcat|coyote/i, icon: "Apachetomcat" },
	// Kestrel ships as part of ASP.NET Core and has no mark of its own.
	{ name: "Kestrel", pattern: /kestrel/i, icon: "Dotnet" },
	{ name: "gunicorn", pattern: /gunicorn/i, icon: "Gunicorn" },
	{ name: "uvicorn", pattern: /uvicorn/i },
	// No icons for these three on purpose. simple-icons' Werkzeug and Cowboy
	// candidates are Flask's and Erlang's marks — the platform, not the server —
	// and its `Puma` is the sportswear company, not the Ruby app server.
	{ name: "Werkzeug", pattern: /werkzeug/i },
	{ name: "Cowboy", pattern: /cowboy/i },
	{ name: "Puma", pattern: /puma/i },
	{ name: "CERN httpd", pattern: /^cern/i },
	// Codeberg/Forgejo Pages, which is the software rather than the instance —
	// anyone can run it, so it says self-hosted the same way nginx does.
	{ name: "git-pages", pattern: /git-pages|pages-server/i, icon: "Forgejo" },
];

/**
 * Generators, in order of confidence.
 *
 * `meta[name=generator]` is the standard and is preferred wherever a site
 * bothers to emit it. The DOM and header fingerprints below exist because
 * several popular frameworks — Next.js, Nuxt — do not.
 */
const GENERATORS = [
	// "Build Awesome" is Eleventy's newer branding, reported under its own name
	// so the tally can show the rename happening. Must be tested before the
	// Eleventy rule below: the transitional tag is "Eleventy (Build Awesome)
	// v4.0.0", which both patterns match, and the newer name is the answer.
	// Carries its own mark, from src/icons/BuildAwesome.svg.
	{ id: "build-awesome", name: "Build Awesome", icon: "BuildAwesome", meta: /build\s*awesome/i },
	{ id: "eleventy", name: "Eleventy", icon: "Eleventy", meta: /eleventy|\b11ty\b/i },
	{ id: "hugo", name: "Hugo", icon: "Hugo", meta: /^hugo/i },
	{ id: "jekyll", name: "Jekyll", icon: "Jekyll", meta: /jekyll/i },
	{ id: "astro", name: "Astro", icon: "Astro", meta: /astro/i, mark: "astro" },
	{ id: "docusaurus", name: "Docusaurus", icon: "Docusaurus", meta: /docusaurus/i, mark: "docusaurus" },
	{ id: "hexo", name: "Hexo", icon: "Hexo", meta: /hexo/i },
	{ id: "gridsome", name: "Gridsome", icon: "Gridsome", meta: /gridsome/i },
	{ id: "quarto", name: "Quarto", icon: "Quarto", meta: /quarto/i },
	{ id: "lume", name: "Lume", icon: null, meta: /^lume/i },
	// Silex publishes through Eleventy and stamps both tags, its own first.
	// Deferred so the underlying generator wins when both are present — see the
	// pass loop in detectGenerator. Not `secondary`: that also drops the version,
	// and "Silex v3.0.0" is Silex's own number, not a plugin's.
	{ id: "silex", name: "Silex", icon: null, meta: /silex/i, deferred: true },
	{ id: "gatsby", name: "Gatsby", icon: "Gatsby", meta: /gatsby/i, mark: "gatsby" },
	{ id: "wordpress", name: "WordPress", icon: "Wordpress", meta: /wordpress/i },
	// Themes and plugins that stamp their own generator tag over WordPress's.
	// All three are WordPress-only, so the tag still answers "what built this"
	// — just not with the name it meant to.
	{ id: "wordpress-aioseo", name: "WordPress", icon: "Wordpress", meta: /all in one seo|aioseo/i, secondary: true },
	{ id: "wordpress-sitekit", name: "WordPress", icon: "Wordpress", meta: /site kit by google/i, secondary: true },
	{ id: "wordpress-divi", name: "WordPress", icon: "Wordpress", meta: /\bdivi\b/i, secondary: true },
	// A WordPress page builder that stamps its own generator tag, like the three
	// above — but named rather than folded into WordPress, because unlike an SEO
	// plugin it is the thing that produced the markup, and it is a brand a reader
	// recognizes on its own.
	{ id: "elementor", name: "Elementor", icon: "Elementor", meta: /elementor/i },
	{ id: "drupal", name: "Drupal", icon: "Drupal", meta: /drupal/i },
	{ id: "ghost", name: "Ghost", icon: "Ghost", meta: /ghost/i },
	{ id: "vitepress", name: "VitePress", icon: "Vitepress", meta: /vitepress/i, mark: "vitepress" },
	{ id: "vuepress", name: "VuePress", icon: "Vuedotjs", meta: /vuepress/i },
	{ id: "mkdocs", name: "MkDocs", icon: "Materialformkdocs", meta: /mkdocs/i },
	{ id: "pelican", name: "Pelican", icon: null, meta: /pelican/i },
	{ id: "zola", name: "Zola", icon: null, meta: /zola/i },
	{ id: "publii", name: "Publii", icon: null, meta: /publii/i },
	{ id: "squarespace", name: "Squarespace", icon: "Squarespace", meta: /squarespace/i },
	{ id: "wix", name: "Wix", icon: "Wix", meta: /wix/i },
	{ id: "webflow", name: "Webflow", icon: "Webflow", meta: /webflow/i, mark: "webflow" },
	// The generator tag carries a build SHA rather than a version — "Framer
	// 831f5a1" — which versionFrom already declines to read as one, because the
	// digits are not followed by a word boundary. No suppression needed here.
	{ id: "framer", name: "Framer", icon: "Framer", meta: /^framer\b/i },
	{ id: "bear", name: "Bear Blog", icon: null, meta: /bear/i },

	// Usually no generator meta tag — recognized by shape instead. They still
	// carry a `meta` pattern, because a handful of these do emit the tag and
	// without a rule they would fall through to the unknown-generator path and
	// lose their icon.
	{ id: "nextjs", name: "Next.js", icon: "Nextdotjs", meta: /next\.js|^next\b/i, mark: "next", poweredBy: /next\.js/i },
	{ id: "nuxt", name: "Nuxt", icon: "Nuxt", meta: /^nuxt/i, mark: "nuxt" },
	/*
	 * A bundler rather than a site generator, and the only one listed. It earns
	 * the column because for a site that ships no generator tag and no framework
	 * marker, "built with Vite" is the most specific true thing available — and
	 * the alternative in that cell is nothing at all. See `fallback` in
	 * detectGenerator: it is consulted after even an unrecognized generator tag,
	 * so a site's own claim about itself always wins.
	 */
	{ id: "vite", name: "Vite", icon: "Vite", mark: "vite", fallback: true },
	{ id: "sveltekit", name: "SvelteKit", icon: "Svelte", meta: /sveltekit/i, mark: "sveltekit" },
	/*
	 * Svelte without SvelteKit — the component framework on somebody else's
	 * server. huggingface.co is the case: Svelte's runtime and scoped styles,
	 * none of SvelteKit's routing markers, and no generator tag.
	 *
	 * After SvelteKit on purpose. Marks are matched in this order and the first
	 * wins, so a SvelteKit site — which carries both — keeps the more specific
	 * name. This one only answers when the framework is there and the meta-
	 * framework is not.
	 */
	{ id: "svelte", name: "Svelte", icon: "Svelte", meta: /^svelte\b/i, mark: "svelte" },
	{ id: "remix", name: "Remix", icon: "Remix", meta: /^remix/i, mark: "remix" },
	{ id: "reactrouter", name: "React Router", icon: "Reactrouter", meta: /^react router/i, mark: "reactrouter" },
	{ id: "qwik", name: "Qwik", icon: "Qwik", meta: /^qwik/i, mark: "qwik" },
	// A hosted publishing product rather than a generator you run, but it is what
	// built the page, which is the question this column answers. Detected by DOM
	// mark only: the pages carry no generator tag at all.
	{ id: "obsidian-publish", name: "Obsidian Publish", icon: "Obsidian", mark: "obsidian-publish" },
];

/**
 * A generator's display details by id, without having detected it.
 *
 * For the presumed case: a site in a curated list that emits no generator tag
 * is not evidence of anything, but the list itself is a claim worth showing —
 * faded, to say "listed as, not detected as".
 */
export function generatorById(id) {
	const found = GENERATORS.find((g) => g.id === id);
	return found ? { id: found.id, name: found.name, icon: found.icon } : null;
}

/** Run inside the page. Kept dependency-free — it is serialized to the browser. */
export function pageProbe() {
	// All of them, not just the first: WordPress SEO plugins add a second
	// generator tag ahead of the CMS's own, and reading only the first would
	// report the plugin as the thing that built the site.
	const metas = [...document.querySelectorAll('meta[name="generator" i]')]
		.map((el) => el.getAttribute("content"))
		.filter(Boolean);

	const marks = [];
	const add = (id, found) => found && marks.push(id);

	/*
	 * A script that *might* mean Vite: a module script pointing at
	 * /assets/<name>-<8 chars>.js, which is Rollup's output naming as Vite
	 * configures it. Not proof — a hand-rolled Rollup build looks the same — so
	 * this is reported as a candidate rather than added to `marks`.
	 *
	 * The proof is `__vitePreload` inside the bundle, and reading it costs a
	 * request. `confirmVite` in lib/axe.js spends that request only when nothing
	 * else identified the site, so the common case pays nothing.
	 */
	const viteCandidate =
		[...document.querySelectorAll('script[type="module"][src]')]
			.map((el) => el.getAttribute("src") || "")
			.find((src) => /\/assets\/[\w.-]+-[A-Za-z0-9_-]{8}\.(js|mjs)(\?|$)/.test(src)) || null;

	add("astro", document.querySelector("astro-island, [class*='astro-']"));
	// The build-output path is the most durable Next/Nuxt tell: the root element
	// ids come and go between major versions, but `/_next/` and `/_nuxt/` have
	// been stable throughout and survive static export, where no runtime hook is
	// left on `window` at all.
	/*
	 * `*=` not `^=`: the build output is not always at the site root. cursor.com
	 * serves it from a basePath — /marketing-static/_next/static/chunks/… — and
	 * an anchored selector missed all twenty-six of its script tags.
	 *
	 * `__next_f` alongside `__NEXT_DATA__`: the latter is the Pages Router's
	 * hydration payload and is absent in the App Router, which streams into
	 * `__next_f` instead. Checking only the old one made every App Router site
	 * depend on the path selector above, and devin.ai had both problems at once.
	 */
	add(
		"next",
		document.querySelector("#__next, script#__NEXT_DATA__, script[src*='/_next/'], link[href*='/_next/']") ||
			"__NEXT_DATA__" in window ||
			"__next_f" in window,
	);
	add(
		"nuxt",
		document.querySelector("#__nuxt, #__nuxt_error, script[src^='/_nuxt/']") || "__NUXT__" in window,
	);
	/*
	 * Webflow stamps the document element: data-wf-page, data-wf-site,
	 * data-wf-domain, data-wf-status. The meta generator is the usual tell and
	 * catches most of them, but it is content a site can edit away while these
	 * attributes are what the runtime reads, so they survive an export or a
	 * hand-edited head.
	 */
	add("webflow", document.querySelector("[data-wf-page], [data-wf-site], [data-wf-domain]"));
	add("docusaurus", document.querySelector("#__docusaurus"));
	add("gatsby", document.querySelector("#___gatsby"));
	add("vitepress", document.querySelector("#VPContent, .VPDoc"));
	add("sveltekit", document.querySelector("[data-sveltekit-preload-data]"));
	/*
	 * `__svelte` is the runtime's own version registry — an object of { v, uid }
	 * that Svelte sets for its devtools. The scoped-style element corroborates
	 * it: Svelte hashes component styles into `style#svelte-<hash>`.
	 */
	add("svelte", "__svelte" in window || document.querySelector("style[id^='svelte-']"));
	add("remix", "__remixContext" in window);
	/*
	 * React Router in framework mode — what Remix became at v7. It sets a family
	 * of globals where Remix set `__remixContext`, so a v7 site matched nothing:
	 * replicate.com reports `__reactRouterVersion` 7.9.1 and no generator tag.
	 *
	 * After `remix` so a site carrying both is named by the older, more specific
	 * one rather than by the library underneath it.
	 */
	add("reactrouter", "__reactRouterManifest" in window || "__reactRouterVersion" in window);
	add("qwik", document.querySelector("[q\\:container]"));
	/*
	 * Obsidian Publish serves every site from its own origin and rewrites the
	 * document to a shell: no generator tag, no framework markers, two kilobytes
	 * of loader. The `<base>` is the durable tell — every relative URL on the
	 * page has to resolve against publish.obsidian.md for the site to work at
	 * all, so it cannot be dropped without breaking the product.
	 *
	 * `window.siteInfo.host` is the corroborating one, naming the specific
	 * publish node. Either alone is enough; both is the normal case.
	 */
	add(
		"obsidian-publish",
		document.querySelector("base[href*='publish.obsidian.md']") ||
			/(^|\.)obsidian\.md$/.test(window.siteInfo?.host ?? ""),
	);

	// `meta` stays alongside `metas` so a record written by an older build still
	// reads correctly here.
	// The page's own title, for spotting a challenge page. A site behind a bot
	// check serves the interstitial to us exactly as it does to any other
	// automated client, and every number we then record — and every screenshot
	// taken of it — describes Cloudflare's waiting room rather than the site.
	/*
	 * A little body text, for bot checks the title cannot catch.
	 *
	 * Cloudflare's newer challenge titles the page after the domain — the visible
	 * heading says "Performing security verification" but `document.title` reads
	 * "www.hawksworx.com", which is indistinguishable from the real site. That
	 * page was measured, stored, and ranked at #1310 on the strength of it.
	 *
	 * Capped hard and taken from the body only. This is not for reading the page;
	 * it is for spotting a handful of fixed phrases in what is, on these pages,
	 * a couple of hundred characters of boilerplate around a checkbox.
	 */
	const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400);

	return { meta: metas[0] ?? null, metas, marks, viteCandidate, title: (document.title || "").slice(0, 200), bodyText };
}

/**
 * Phrases that mean we measured a bot check rather than a site.
 *
 * Titles only. The body of these pages is mostly script and a spinner, and the
 * title is the one part that is stable across the several products that do this
 * — Cloudflare, and the handful of WAFs that copy its wording.
 *
 * Deliberately narrow. A false positive hides a real site's screenshot and
 * quietly writes off its numbers, which is worse than showing one waiting room.
 */
const INTERSTITIAL_TITLES = [
	// Anchored *and* terminated: Cloudflare's is "Just a moment..." exactly, and
	// a photography blog called "Just a Moment in Time" is not a bot check.
	/^just a moment[.…\s]*$/i,
	/performing security verification/i,
	/^checking your browser/i,
	/^attention required/i,
	/verifying you are human/i,
	/^access denied/i,
	/^one more step/i,
];

/**
 * Phrases that mean a bot check regardless of what the page is titled.
 *
 * Matched against the first few hundred characters of body text, and much
 * narrower than the title list because body text is not boilerplate the way a
 * title is: a page *about* Cloudflare could say "Cloudflare", so nothing here
 * matches a product name on its own. Each of these is a sentence these checks
 * print and ordinary pages do not.
 */
const INTERSTITIAL_BODY = [
	// Cloudflare, and the WAFs that copy its wording.
	/performing security verification/i,
	/verify you are human/i,
	/checking if the site connection is secure/i,
	/enable javascript and cookies to continue/i,
	/needs to review the security of your connection/i,

	/*
	 * Vercel's checkpoint, which shares none of Cloudflare's phrasing and so
	 * went undetected: devin.ai served "Vercel Security Checkpoint — We're
	 * verifying your browser" and was measured, stored and ranked at #987 on it.
	 *
	 * The vendor line is the anchor; the sentence above it is included because a
	 * checkpoint can be rebranded and that phrasing is not Vercel's alone. The
	 * apostrophe is optional and either kind: pages serve both.
	 */
	/vercel security checkpoint/i,
	/we\u2019?'?re verifying your browser/i,
];

/**
 * Whether a probed page looks like a bot check rather than the site itself.
 *
 * Returns the matched phrase, so a page can say which check it hit rather than
 * asserting an unexplained absence, and null when nothing matched.
 */
export function detectInterstitial(probe) {
	const title = typeof probe?.title === "string" ? probe.title.trim() : "";
	if (title && INTERSTITIAL_TITLES.some((re) => re.test(title))) return title;

	// Then the body, for the checks that borrow the site's own title.
	const body = typeof probe?.bodyText === "string" ? probe.bodyText : "";
	const matched = INTERSTITIAL_BODY.find((re) => re.test(body));
	if (!matched) return null;

	// The title where there is one, so the report still names the page; the
	// phrase that fired otherwise, which is more use than an empty string.
	return title || String(body.match(matched)?.[0] ?? "bot check");
}

/** Identify the generator from a page probe plus response headers. */
export function detectGenerator({ meta, metas, marks = [] } = {}, headers = {}) {
	const poweredBy = headers["x-powered-by"] || "";
	const candidates = metas?.length ? metas : meta ? [meta] : [];

	// The meta tag is authoritative when present. Tags are tried in document
	// order, but a tag naming a generator we know beats an earlier one we don't.
	//
	// Rules marked `secondary` only infer the generator from something built on
	// top of it, so they run in a second pass — otherwise a plugin's tag would
	// win on document order and we'd report the plugin's version number as the
	// CMS's.
	//
	// `deferred` is the same ordering without the version suppression: for a
	// tool that stamps its own tag alongside the generator it publishes through,
	// where both names are true and the version belongs to the tool. Silex, which
	// emits "Silex v3.0.0" ahead of "Eleventy v3.0.0", is the case in point —
	// reading it in document order filed a site built with Eleventy under Silex,
	// and moved it out of the community list for not being Eleventy.
	for (let secondPass of [false, true]) {
		for (let candidate of candidates) {
			for (let g of GENERATORS) {
				if (!g.meta || ((g.secondary || g.deferred) && !secondPass)) continue;
				if (g.meta.test(candidate)) {
					return {
						id: g.id,
						name: g.name,
						icon: g.icon,
						// A secondary tag carries the plugin's version, not the
						// generator's — "WordPress 1.185.0" is Site Kit's number.
						version: g.secondary ? null : versionFrom(candidate),
						source: "meta",
						raw: candidate,
					};
				}
			}
		}
	}

	for (let g of GENERATORS) {
		// Fallbacks wait until every other signal has been tried, including an
		// unrecognized generator tag below.
		if (g.fallback) continue;
		if (g.mark && marks.includes(g.mark)) {
			return { id: g.id, name: g.name, icon: g.icon, version: null, source: "dom", raw: candidates[0] ?? null };
		}
		if (g.poweredBy && g.poweredBy.test(poweredBy)) {
			return { id: g.id, name: g.name, icon: g.icon, version: null, source: "header", raw: poweredBy };
		}
	}

	// A generator we don't know: still worth showing the name it gave.
	const unknown = candidates[0];
	if (unknown) {
		// Cut at the first digit or separator, then strip a dangling "v", "v."
		// or punctuation so "Divi v.4.2" reads as "Divi", not "Divi v.".
		const name = unknown
			.split(/[\d,;(]/)[0]
			.replace(/[\s\-–—_.]*v\.?\s*$/i, "")
			.replace(/[\s\-–—_.]+$/, "")
			.trim();
		if (name) {
			return { id: null, name, icon: null, version: versionFrom(unknown), source: "meta", raw: unknown };
		}
	}

	// Last resort: a build tool inferred from how the page was bundled. Only
	// reached when the site named no generator and carried no framework marker.
	for (let g of GENERATORS) {
		if (g.fallback && g.mark && marks.includes(g.mark)) {
			return { id: g.id, name: g.name, icon: g.icon, version: null, source: "dom", raw: null };
		}
	}

	return null;
}

/** Identify the host from response headers. */
export function detectHost(headers = {}) {
	for (let h of HOSTS) {
		if (h.header && headers[h.header]) {
			return { id: h.id, name: h.name, icon: h.icon, source: h.header };
		}
	}

	const server = headers.server || "";
	for (let h of HOSTS) {
		if (h.server && h.server.test(server)) {
			return { id: h.id, name: h.name, icon: h.icon, source: "server" };
		}
	}

	// No provider signature, just a daemon: the honest answer to "who hosts
	// this" is nobody in particular. The daemon rides along as `detail` so the
	// tooltip can still say which one it was.
	for (let s of SERVER_SOFTWARE) {
		if (s.pattern.test(server)) {
			return {
				id: "self-hosted",
				name: "Self-hosted",
				// No mark of its own — "Self-hosted" isn't a brand. `detailIcon` is
				// the daemon's, shown inside the chip rather than in place of it,
				// so the cell still reads as a bucket and not as a host.
				icon: null,
				detail: s.name,
				detailIcon: s.icon ?? null,
				source: "server",
			};
		}
	}

	// Unknown but named: better than nothing. Cut at the first version, comment
	// or list separator — a chain of proxies concatenates into one header, so
	// "git-pages (git-pages), pages-server" is a single name wearing its own
	// echo. The first entry is the one that answered.
	if (server) {
		const name = server.split(/[/(,;]/)[0].trim();
		if (name) return { id: null, name, icon: null, source: "server" };
	}

	return null;
}

/** Pull a version out of a generator string: "Hugo 0.165.0" -> "0.165.0". */
function versionFrom(text) {
	const str = String(text);

	/*
	 * Prefer a number that announces itself as a version — `v3.0.0`, or one
	 * following the product name — over the first digits in the string.
	 *
	 * Taking the first digits found "11" out of every one of these:
	 *
	 *     "@11ty/eleventy v1.0.1"   -> 11, where the real answer is 1.0.1
	 *     "Eleventy - 11ty - ..."   -> 11, where there is no version at all
	 *     "11ty"                    -> 11, likewise
	 *
	 * and 11 is not a version Eleventy has ever had. The `11ty` in a package
	 * name is part of the name.
	 */
	const dotted = str.match(/(?:^|[\s/@-])v?(\d+\.[\d.]*\d)/);
	if (dotted) return dotted[1];

	// A bare major, but only where a `v` says it is one: `Hugo v5`, not `11ty`.
	const prefixed = str.match(/(?:^|[\s/@-])v(\d+)\b/);
	if (prefixed) return prefixed[1];

	// A bare major after the product name: `Publii 1`, `Drupal 10 (drupal.org)`.
	// Anchored to a letter and a space so the `11` in `11ty` cannot reach it.
	const bare = str.match(/[a-z]\s+(\d+)(?:\b|$)/i);
	return bare ? bare[1] : null;
}

/** Keep only the headers worth storing, lowercased. */
export function pickHostHeaders(headers = {}) {
	const out = {};
	for (let [key, value] of Object.entries(headers)) {
		const k = key.toLowerCase();
		if (HOST_HEADERS.includes(k)) out[k] = String(value).slice(0, 120);
	}
	return out;
}
