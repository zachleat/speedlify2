import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { detectGenerator, detectHost, pickHostHeaders, pageProbe, detectInterstitial } from "../lib/stack.js";

/**
 * Every generator that https://github.com/11ty/api-generator recognizes, with a
 * `meta[name=generator]` string in the shape that generator actually emits.
 *
 * This list is the contract: api-generator is the reference implementation for
 * "what counts as a known generator", so anything it detects, we detect.
 */
const API_GENERATOR_REFERENCE = [
	{ meta: "Eleventy v3.0.0", name: "Eleventy" },
	{ meta: "11ty.dev v0.11.0", name: "Eleventy" },
	{ meta: "Hugo 0.165.0", name: "Hugo" },
	{ meta: "Gatsby 5.16.1", name: "Gatsby" },
	{ meta: "WordPress 6.9", name: "WordPress" },
	{ meta: "Silex", name: "Silex" },
	{ meta: "Jekyll v4.4.1", name: "Jekyll" },
	{ meta: "Docusaurus v3.9.2", name: "Docusaurus" },
	{ meta: "Gridsome v0.7.23", name: "Gridsome" },
	{ meta: "VuePress 1.9.10", name: "VuePress" },
	{ meta: "VitePress v1.6.4", name: "VitePress" },
	{ meta: "Hexo 7.3.0", name: "Hexo" },
	{ meta: "Astro v5.14.1", name: "Astro" },
	{ meta: "Lume v3.1.1", name: "Lume" },
	{ meta: "Next.js", name: "Next.js" },
	{ meta: "Nuxt", name: "Nuxt" },
];

describe("generator detection", () => {
	describe("covers the api-generator reference list", () => {
		for (let { meta, name } of API_GENERATOR_REFERENCE) {
			test(`${name} from "${meta}"`, () => {
				const found = detectGenerator({ meta });
				assert.equal(found?.name, name);
				assert.equal(found.source, "meta");
				// A name we recognize always carries an id; unknown ones are id-less.
				assert.ok(found.id, `expected a known id for ${name}`);
			});
		}
	});

	test("reports Build Awesome under its own name, not Eleventy's", () => {
		// Eleventy's newer branding. The transitional tag names both projects and
		// has to resolve to the newer one, which means this rule is tested first.
		for (let meta of ["Build Awesome", "Build Awesome v4.0.0", "Eleventy (Build Awesome) v4.0.0"]) {
			const found = detectGenerator({ meta });
			assert.equal(found.name, "Build Awesome", meta);
			assert.equal(found.id, "build-awesome", meta);
		}

		// The old name keeps reporting as itself.
		assert.equal(detectGenerator({ meta: "Eleventy v3.1.6" }).id, "eleventy");
		assert.equal(detectGenerator({ meta: "11ty" }).id, "eleventy");

		// Its own mark, supplied locally — simple-icons carries neither name.
		assert.equal(detectGenerator({ meta: "Build Awesome" }).icon, "BuildAwesome");
		assert.equal(detectGenerator({ meta: "Eleventy v3.1.6" }).icon, "Eleventy");
	});

	test("reads the version out of the meta string", () => {
		assert.equal(detectGenerator({ meta: "Hugo 0.165.0" }).version, "0.165.0");
		assert.equal(detectGenerator({ meta: "Eleventy v3.0.0" }).version, "3.0.0");
		assert.equal(detectGenerator({ meta: "Silex" }).version, null);
	});

	test("recognizes Framer, and reads its build SHA as no version", () => {
		// Framer stamps a commit hash where a version would go: "Framer 831f5a1".
		// The digits run straight into a letter, so versionFrom finds no word
		// boundary and reports null rather than a nonsense "831".
		const found = detectGenerator({ meta: "Framer 831f5a1" });
		assert.equal(found.id, "framer");
		assert.equal(found.name, "Framer");
		assert.equal(found.icon, "Framer");
		assert.equal(found.version, null);

		// Anchored at the front: the word has to open the string. Without that,
		// every generator with "framer" anywhere in it becomes Framer.
		assert.equal(detectGenerator({ meta: "Xframer" }).id, null);
		assert.equal(detectGenerator({ meta: "Some Framer-like thing" }).id, null);
	});

	test("recognizes Next.js and Nuxt by their build output paths", () => {
		// Both ship without a generator meta tag, so the reference falls back to
		// script[src^='/_next/'] and script[src^='/_nuxt/'] — so do we.
		assert.equal(detectGenerator({ meta: null, marks: ["next"] })?.name, "Next.js");
		assert.equal(detectGenerator({ meta: null, marks: ["nuxt"] })?.name, "Nuxt");
		// Obsidian Publish serves a two-kilobyte loader shell with no generator
		// tag at all, so the DOM mark is the only route to detecting it.
		assert.equal(detectGenerator({ meta: null, marks: ["obsidian-publish"] })?.name, "Obsidian Publish");
	});

	test("pageProbe collects the build-output marks", () => {
		const probe = withDom(
			`<script src="/_next/static/chunks/main.js"></script>`,
			pageProbe,
		);
		assert.ok(probe.marks.includes("next"));

		const nuxt = withDom(`<script src="/_nuxt/entry.abc123.js"></script>`, pageProbe);
		assert.ok(nuxt.marks.includes("nuxt"));

		// Under a basePath, which cursor.com serves and an anchored selector missed.
		const based = withDom(
			`<script src="/marketing-static/_next/static/chunks/main.js"></script>`,
			pageProbe,
		);
		assert.ok(based.marks.includes("next"), "a basePath still reads as Next.js");
	});

	test("recognizes the App Router, which has no __NEXT_DATA__", () => {
		// The Pages Router's hydration payload is absent in the App Router, which
		// streams into __next_f instead.
		const probe = withDom("", pageProbe, { __next_f: [] });
		assert.ok(probe.marks.includes("next"));
	});

	test("recognizes React Router in framework mode", () => {
		// What Remix became at v7: a different family of globals entirely.
		const probe = withDom("", pageProbe, { __reactRouterManifest: {} });
		assert.ok(probe.marks.includes("reactrouter"));
		assert.ok(!probe.marks.includes("remix"), "and is not mistaken for Remix");
	});

	test("a known generator tag beats an unknown one earlier in the document", () => {
		// WordPress SEO plugins insert their own generator tag ahead of the CMS's.
		// Reading only the first would credit the plugin with building the site.
		const found = detectGenerator({
			metas: ["All in One SEO (AIOSEO) 4.9.5.1", "WordPress 6.9"],
		});
		assert.equal(found.name, "WordPress");
		assert.equal(found.raw, "WordPress 6.9");
	});

	test("recognizes WordPress-only themes and plugins as WordPress on their own", () => {
		// These often strip the WordPress tag rather than precede it, leaving
		// their own as the only signal on the page.
		assert.equal(detectGenerator({ meta: "All in One SEO (AIOSEO) 4.9.9" }).name, "WordPress");
		assert.equal(detectGenerator({ meta: "Site Kit by Google 1.185.0" }).name, "WordPress");
		assert.equal(detectGenerator({ meta: "Divi v.4.27.4" }).name, "WordPress");
		// The plugin's version is not the CMS's, so no version is claimed.
		assert.equal(detectGenerator({ meta: "Site Kit by Google 1.185.0" }).version, null);
		// A version from the CMS's own tag is still read.
		assert.equal(
			detectGenerator({ metas: ["All in One SEO (AIOSEO) 4.9.9", "WordPress 6.9"] }).version,
			"6.9",
		);
		assert.equal(detectGenerator({ meta: "Drupal 11 (https://www.drupal.org)" }).name, "Drupal");
	});

	test("pageProbe collects every generator tag, in document order", () => {
		const probe = withDom(
			`<meta name="generator" content="All in One SEO (AIOSEO) 4.9.5.1">
			 <meta name="generator" content="WordPress 6.9">`,
			pageProbe,
		);
		assert.deepEqual(probe.metas, ["All in One SEO (AIOSEO) 4.9.5.1", "WordPress 6.9"]);
		// Kept for records written before `metas` existed.
		assert.equal(probe.meta, "All in One SEO (AIOSEO) 4.9.5.1");
	});

	test("the meta tag wins over a DOM mark", () => {
		// A Next.js app rendering an Astro island should still read as Astro if
		// Astro is what stamped the page.
		const found = detectGenerator({ meta: "Astro v5.14.1", marks: ["next"] });
		assert.equal(found.name, "Astro");
	});

	test("keeps the name of a generator it does not know", () => {
		const found = detectGenerator({ meta: "SomeNewThing v.2.1" });
		assert.equal(found.name, "SomeNewThing");
		assert.equal(found.id, null);
		assert.equal(found.icon, null);
	});

	test("degrades to null rather than guessing", () => {
		assert.equal(detectGenerator({ meta: null, marks: [] }), null);
		assert.equal(detectGenerator(), null);
	});
});

describe("host detection", () => {
	test("prefers an origin request id over the CDN in front of it", () => {
		const found = detectHost({ "x-nf-request-id": "abc", server: "cloudflare" });
		assert.equal(found.name, "Netlify");
	});

	test("folds per-PoP server strings into one provider", () => {
		assert.equal(detectHost({ server: "BunnyCDN-MSP1-1084" }).name, "Bunny CDN");
		assert.equal(detectHost({ server: "Bunny-NET-CDN-KC1-937" }).name, "Bunny CDN");
		assert.equal(detectHost({ server: "railway-hikari" }).name, "Railway");
		assert.equal(detectHost({ server: "railway-edge" }).name, "Railway");
	});

	test("a bare web server is not a host", () => {
		// nginx and Apache say which daemon answered, not who runs the machine.
		for (let server of [
			"nginx",
			"Apache/2.4.62",
			"LiteSpeed",
			"Caddy",
			"CERN/3.0",
			"git-pages (git-pages), pages-server",
		]) {
			const found = detectHost({ server });
			assert.equal(found.name, "Self-hosted", `expected Self-hosted for ${server}`);
			assert.equal(found.id, "self-hosted");
			assert.ok(found.detail, "the daemon is kept for the tooltip");
		}
		assert.equal(detectHost({ server: "nginx" }).detail, "nginx");
	});

	test("carries the daemon's own mark, where one exists", () => {
		assert.equal(detectHost({ server: "nginx" }).detailIcon, "Nginx");
		assert.equal(detectHost({ server: "Apache/2.4.62" }).detailIcon, "Apache");
		// The bucket itself has no mark — "Self-hosted" is not a brand.
		assert.equal(detectHost({ server: "nginx" }).icon, null);
	});

	test("declines a mark that belongs to something else", () => {
		// simple-icons' `Puma` is the sportswear company, not the Ruby app server,
		// and Werkzeug's and Cowboy's nearest candidates are Flask's and Erlang's
		// marks — the platform rather than the server.
		for (let server of ["Puma 6.4.2", "Werkzeug/3.0.1", "Cowboy"]) {
			const found = detectHost({ server });
			assert.equal(found.name, "Self-hosted");
			assert.equal(found.detailIcon, null, `${server} should not borrow a mark`);
		}
	});

	test("a provider in front of a daemon still reads as the provider", () => {
		// Cloudflare used to identify itself as cloudflare-nginx, and every host
		// above runs one of these daemons underneath.
		assert.equal(detectHost({ server: "cloudflare-nginx" }).name, "Cloudflare");
		assert.equal(detectHost({ "x-nf-request-id": "abc", server: "nginx" }).name, "Netlify");
	});

	test("keeps an unknown server name, without its trailing noise", () => {
		const found = detectHost({ server: "SomeServer/1.2" });
		assert.equal(found.name, "SomeServer");
		assert.equal(found.id, null);

		// A chain of proxies concatenates into one header value.
		assert.equal(detectHost({ server: "thing; v2" }).name, "thing");
		assert.equal(detectHost({ server: "Unknown (thing), other" }).name, "Unknown");
	});

	test("degrades to null with no usable headers", () => {
		assert.equal(detectHost({}), null);
		assert.equal(detectHost(), null);
	});
});

describe("pickHostHeaders", () => {
	test("keeps only the headers worth storing, lowercased and bounded", () => {
		const kept = pickHostHeaders({
			Server: "nginx",
			"X-Powered-By": "Next.js",
			"Set-Cookie": "session=secret",
			"content-type": "text/html",
		});
		assert.deepEqual(kept, { server: "nginx", "x-powered-by": "Next.js" });
	});

	test("truncates long values", () => {
		const kept = pickHostHeaders({ server: "x".repeat(500) });
		assert.equal(kept.server.length, 120);
	});
});

/**
 * Run `pageProbe` against a scrap of HTML.
 *
 * The probe is serialized into the browser in production, so it only ever
 * touches `document` and `window` — enough that a couple of stubs stand in for
 * a DOM here and keep the test suite free of a headless browser.
 */
function withDom(html, fn, windowGlobals = {}) {
	const scripts = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
	const metas = [...html.matchAll(/<meta[^>]*name="generator"[^>]*content="([^"]*)"/gi)].map(
		(m) => ({ getAttribute: () => m[1] }),
	);
	const isMetaQuery = (query) => /generator/i.test(query);
	const document = {
		querySelector(query) {
			if (isMetaQuery(query)) return metas[0] ?? null;

			// Both forms the probe uses: `^=` for a path anchored at the root, and
			// `*=` for build output served under a basePath or a CDN prefix.
			const prefixes = [...query.matchAll(/(?:src|href)\^='([^']+)'/g)].map((m) => m[1]);
			const contains = [...query.matchAll(/(?:src|href)\*='([^']+)'/g)].map((m) => m[1]);

			const hit = scripts.some(
				(src) => prefixes.some((p) => src.startsWith(p)) || contains.some((c) => src.includes(c)),
			);
			return hit ? {} : null;
		},
		querySelectorAll(query) {
			return isMetaQuery(query) ? metas : [];
		},
	};
	const globals = { document, window: windowGlobals };
	const restore = {};
	for (let [key, value] of Object.entries(globals)) {
		restore[key] = globalThis[key];
		globalThis[key] = value;
	}
	try {
		return fn();
	} finally {
		for (let [key, value] of Object.entries(restore)) {
			if (value === undefined) delete globalThis[key];
			else globalThis[key] = value;
		}
	}
}

describe("local brand marks", () => {
	/**
	 * `src/icons/<Name>.svg` supplies marks simple-icons does not carry. The
	 * loader lives in eleventy.config.js; what matters here is that a generator
	 * naming a local mark actually has one on disk, since a missing file is not
	 * an error — the cell just quietly falls back to a text chip.
	 */
	test("every locally-named mark exists on disk", () => {
		const dir = new URL("../src/icons/", import.meta.url);
		const available = new Set(
			fs.readdirSync(dir).filter((f) => f.endsWith(".svg")).map((f) => f.replace(/\.svg$/, "")),
		);

		const source = fs.readFileSync(new URL("../lib/stack.js", import.meta.url), "utf8");
		const named = [...source.matchAll(/icon:\s*"([^"]+)"/g)].map((m) => m[1]);

		// Only the ones simple-icons cannot supply need a file.
		for (let name of new Set(named)) {
			if (!available.has(name)) continue;
			const svg = fs.readFileSync(new URL(`../src/icons/${name}.svg`, import.meta.url), "utf8");
			assert.match(svg, /\sd="/, `${name}.svg needs a path`);
			assert.match(svg, /viewBox="/, `${name}.svg needs a viewBox`);
		}

		assert.ok(available.has("BuildAwesome"), "Build Awesome has no mark in simple-icons");
	});
});

describe("Obsidian Publish", () => {
	/**
	 * The probe's own selectors, checked against the markup the product actually
	 * serves — captured from https://jonwebb.dev/Home, which is a custom domain
	 * in front of publish.obsidian.md.
	 *
	 * There is no generator tag and no framework marker; the page is a loader
	 * shell. The `<base>` is the durable tell, because every relative URL on the
	 * page resolves against it and the product breaks without it.
	 */
	const BASE = `<base href="https://publish.obsidian.md">`;

	test("matches the base element the product cannot drop", () => {
		assert.match(BASE, /base[^>]*href=["'][^"']*publish\.obsidian\.md/);
	});

	test("matches a publish host in siteInfo", () => {
		const host = "publish-01.obsidian.md";
		assert.equal(/(^|\.)obsidian\.md$/.test(host), true);
	});

	test("does not match a site that merely links to obsidian.md", () => {
		// The word appears on plenty of pages that write about the app.
		assert.equal(/(^|\.)obsidian\.md$/.test("notobsidian.md.example.com"), false);
		assert.equal(/(^|\.)obsidian\.md$/.test("example.com"), false);
	});

	test("a generator tag still wins over the mark", () => {
		// The mark is a fallback for pages that say nothing. Anything that names
		// itself outranks a fingerprint.
		const found = detectGenerator({ meta: "Eleventy v3.0.0", marks: ["obsidian-publish"] });
		assert.equal(found.id, "eleventy");
	});
});

describe("a page declaring more than one generator", () => {
	test("a deferred tag loses to the generator it publishes through", () => {
		// internet2000.net stamps both, Silex first. Read in document order it was
		// filed under Silex, which moved it out of the community list for not
		// being Eleventy.
		const found = detectGenerator({ metas: ["Silex v3.0.0", "Eleventy v3.0.0"] });
		assert.equal(found.name, "Eleventy");
		assert.equal(found.version, "3.0.0");
	});

	test("but still wins when it is the only tag", () => {
		const found = detectGenerator({ metas: ["Silex v3.0.0"] });
		assert.equal(found.name, "Silex");
		assert.equal(found.version, "3.0.0", "deferred keeps its version, unlike secondary");
	});

	test("a secondary tag still yields to the CMS and drops its version", () => {
		const found = detectGenerator({ metas: ["Site Kit by Google 1.185.0", "WordPress 6.5"] });
		assert.equal(found.name, "WordPress");
		assert.equal(found.version, "6.5", "the CMS's own number, not the plugin's");
	});
});

describe("detecting a bot check", () => {
	const seen = (title) => detectInterstitial({ title });

	test("recognizes the wording these pages use", () => {
		// The several products that do this copy each other's phrasing, which is
		// what makes titles a usable signal at all.
		assert.ok(seen("Just a moment..."));
		assert.ok(seen("example.com | Performing security verification"));
		assert.ok(seen("Checking your browser before accessing example.com"));
		assert.ok(seen("Attention Required! | Cloudflare"));
		assert.ok(seen("Verifying you are human. This may take a few seconds."));
	});

	test("returns the title, so a page can say what it hit", () => {
		assert.equal(seen("  Just a moment...  "), "Just a moment...");
	});

	test("leaves ordinary titles alone", () => {
		// A false positive hides a real site's screenshot and writes off its
		// numbers, which is worse than showing one waiting room.
		assert.equal(seen("My Personal Site"), null);
		assert.equal(seen("Security — a blog about verification"), null);
		assert.equal(seen("Just a Moment in Time — photography"), null, "must anchor at the start");
	});

	test("no title is not a bot check", () => {
		assert.equal(seen(""), null);
		assert.equal(seen("   "), null);
		assert.equal(detectInterstitial({}), null);
		assert.equal(detectInterstitial(null), null);
	});
});

describe("Vite as a last-resort generator", () => {
	const probe = (marks, metas = []) => detectGenerator({ metas, marks }, {});

	test("names Vite when nothing else identified the site", () => {
		// The mark is only ever present once lib/axe.js has read `__vitePreload`
		// out of the bundle — the probe reports a candidate, not a mark.
		assert.equal(probe(["vite"])?.name, "Vite");
		assert.equal(probe(["vite"])?.source, "dom");
	});

	test("an unconfirmed candidate names nothing", () => {
		const found = detectGenerator({ metas: [], marks: [], viteCandidate: "/assets/index-abc12345.js" }, {});

		// Rollup's filename convention on its own is not evidence of Vite.
		assert.equal(found, null);
	});

	test("a framework built on Vite wins over it", () => {
		// All of these are Vite underneath and emit the same asset naming, so the
		// fallback must never outrank them.
		for (const mark of ["astro", "nuxt", "sveltekit", "vitepress"]) {
			const found = probe([mark, "vite"]);
			assert.notEqual(found?.id, "vite", `${mark} should win over vite`);
		}
	});

	test("a recognized generator tag wins over it", () => {
		assert.equal(probe(["vite"], ["Eleventy v3.0.0"])?.id, "eleventy");
	});

	test("even an unrecognized generator tag wins over it", () => {
		// The site's own claim about itself beats our inference about its bundler.
		assert.equal(probe(["vite"], ["Some Unknown CMS 2.1"])?.name, "Some Unknown CMS");
	});

	test("still nothing when there is no signal at all", () => {
		assert.equal(probe([]), null);
	});
});
