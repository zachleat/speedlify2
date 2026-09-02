import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { siteSlug, assignSlugs } from "../lib/slug.js";
import { urlHash, normalizeUrl, shortHash } from "../lib/hash.js";

describe("siteSlug", () => {
	test("reads as the URL does", () => {
		assert.equal(siteSlug("https://astro.build/"), "astro-build");
		assert.equal(siteSlug("https://istanbul.js.org/"), "istanbul-js-org");
	});

	test("keeps www, because www.x.com and x.com are different sites", () => {
		assert.equal(siteSlug("https://www.11ty.dev/"), "www-11ty-dev");
		assert.notEqual(siteSlug("https://www.11ty.dev/"), siteSlug("https://11ty.dev/"));
	});

	test("drops the scheme, which is the one collision left open", () => {
		// Deliberate: keeping it would put `https-` in front of every URL. The
		// pair is caught by assignSlugs instead.
		assert.equal(siteSlug("http://example.com/"), siteSlug("https://example.com/"));
	});

	test("distinguishes a dash in a path from a path boundary", () => {
		assert.equal(siteSlug("https://example.com/a-b"), "example-com-a--b");
		assert.equal(siteSlug("https://example.com/a/b"), "example-com-a-b");
	});

	test("keeps the path, since it is part of which page is measured", () => {
		// The dash inside "en-US" is a literal, so it doubles — that is what keeps
		// it distinguishable from the path boundary before it.
		assert.equal(
			siteSlug("https://developer.mozilla.org/en-US/"),
			"developer-mozilla-org-en--us",
		);
	});

	test("is a safe path segment", () => {
		for (let url of [
			"https://example.com/a b/c?d=1&e=2",
			"https://exämple.com/",
			"https://example.com/../%2e%2e/",
			"https://example.com/#/route",
		]) {
			const slug = siteSlug(url);
			assert.match(slug, /^[a-z0-9-]+$/, `${url} produced ${slug}`);
			assert.equal(slug, encodeURIComponent(slug));
		}
	});

	test("is bounded, so one long URL cannot produce an unusable path", () => {
		// Filesystems cap a path segment at 255 bytes.
		const slug = siteSlug(`https://example.com/${"segment/".repeat(80)}`);
		assert.ok(slug.length <= 180, `got ${slug.length}`);
	});

	test("falls back to the hash when nothing survives slugifying", () => {
		// A URL whose friendly form is entirely punctuation.
		assert.equal(siteSlug("...."), urlHash("...."));
	});
});

describe("assignSlugs", () => {
	test("leaves a distinct slug alone", () => {
		const slugs = assignSlugs(["https://www.11ty.dev/", "https://astro.build/"]);
		assert.equal(slugs.get("https://www.11ty.dev/"), "www-11ty-dev");
		assert.equal(slugs.get("https://astro.build/"), "astro-build");
	});

	test("falls back to the hash when two URLs claim one slug", () => {
		// http and https are separate records with one slug. The component cannot
		// know that from the URL alone, so neither site gets the slug — a name it
		// will not ask for beats one that resolves to the wrong site.
		const urls = ["http://example.com/", "https://example.com/"];
		const seen = [];
		const slugs = assignSlugs(urls, { onCollision: (slug, group) => seen.push([slug, group]) });

		assert.equal(seen.length, 1);
		assert.equal(seen[0][0], "example-com");
		for (let url of urls) assert.equal(slugs.get(url), urlHash(url));
		assert.notEqual(slugs.get(urls[0]), slugs.get(urls[1]));
	});

	test("does not depend on the order URLs are listed in", () => {
		const urls = ["http://example.com/", "https://example.com/"];
		const forward = assignSlugs(urls);
		const reversed = assignSlugs([...urls].reverse());
		for (let url of urls) assert.equal(forward.get(url), reversed.get(url));
	});

	test("assigns a distinct slug to every URL in a realistic set", () => {
		const urls = [
			"https://www.11ty.dev/",
			"https://11ty.dev/",
			"https://example.com/",
			"https://example.com/blog/",
			"https://example.com/a-b",
			"https://example.com/a/b",
		];
		const slugs = assignSlugs(urls);
		assert.equal(new Set(slugs.values()).size, new Set(urls).size);
	});
});

describe("browser parity", () => {
	/**
	 * The component ships its own copy of the slug rules, because it runs in a
	 * browser with nothing imported. Two implementations of one algorithm drift,
	 * so this pins them together: extract the component's `slug()` and run it
	 * against `siteSlug()` on the awkward cases.
	 *
	 * A drift produces a 404 rather than the wrong site's numbers, which is the
	 * failure mode we chose — but a silent 404 renders as "not measured", so it
	 * still needs catching here.
	 */
	const source = fs.readFileSync(new URL("../packages/speedlify2-score/speedlify2-score.js", import.meta.url), "utf8");

	// Pull the two static methods the slug depends on out of the module and
	// rebuild them standalone, so this does not need a DOM to import into.
	function browserSlug() {
		const normalize = source.match(/static normalizeUrl\(url\) \{[\s\S]*?\n\t\}/)?.[0];
		const slug = source.match(/static slug\(url\) \{[\s\S]*?\n\t\}/)?.[0];
		assert.ok(normalize, "normalizeUrl not found in the component");
		assert.ok(slug, "slug not found in the component");

		const body = `
			const SpeedlifyStore = { ${normalize.replace(/^\tstatic /, "")}, ${slug.replace(/^\tstatic /, "")} };
			return SpeedlifyStore.slug(url);
		`.replace(/static /g, "");
		return new Function("url", body);
	}

	const cases = [
		"https://www.11ty.dev/",
		"https://11ty.dev/",
		"https://astro.build/",
		"https://developer.mozilla.org/en-US/",
		"https://example.com/a-b",
		"https://example.com/a/b",
		"https://example.com/a//b",
		"https://EXAMPLE.com/PATH/",
		"https://example.com/?q=1",
		"http://example.com/",
		"https://exämple.com/",
		"https://example.com/x#fragment",
		`https://example.com/${"segment/".repeat(80)}`,
	];

	const compute = browserSlug();
	for (let url of cases) {
		test(`matches the generator for ${url.slice(0, 48)}`, () => {
			assert.equal(compute(url), siteSlug(url));
		});
	}

	test("agrees across every URL in the real corpus", () => {
		const file = new URL("../report.json", import.meta.url);
		if (!fs.existsSync(file)) return; // Nothing built yet; the cases above still ran.

		const report = JSON.parse(fs.readFileSync(file, "utf8"));
		const mismatched = report.entries
			.map((e) => e.url)
			.filter((url) => compute(url) !== siteSlug(url));

		assert.deepEqual(mismatched, [], "component and generator disagree on these URLs");
	});
});

describe("trailing slashes", () => {
	/**
	 * `/en` and `/en/` are one site. Servers serve both and redirect one to the
	 * other, so tracking them apart means two histories, two identical-looking
	 * rows, and that person's server measured twice for one page.
	 */
	test("a deep path is the same site with or without one", () => {
		assert.equal(normalizeUrl("https://x.com/en/"), normalizeUrl("https://x.com/en"));
		assert.equal(urlHash("https://x.com/en/"), urlHash("https://x.com/en"));
		assert.equal(siteSlug("https://x.com/en/"), siteSlug("https://x.com/en"));
	});

	test("the root path keeps its slash", () => {
		// Stripping it would re-key every site rather than the few with a deeper
		// path, and `https://x.com/` is the canonical form of an origin anyway.
		assert.equal(normalizeUrl("https://x.com"), "https://x.com/");
		assert.equal(normalizeUrl("https://x.com/"), "https://x.com/");
		assert.equal(urlHash("https://x.com"), urlHash("https://x.com/"));
	});

	test("repeated slashes collapse too", () => {
		assert.equal(normalizeUrl("https://x.com/a/b//"), "https://x.com/a/b");
	});

	test("no longer needs a collision fallback for the pair", () => {
		// The two forms reach assignSlugs already collapsed by loadConfig, so what
		// used to be a collision — both pushed onto hashes — is now one site with
		// a readable URL.
		const urls = ["https://x.com/en/", "https://x.com/en"].map(normalizeUrl);
		const slugs = assignSlugs(urls);
		assert.equal(new Set(slugs.values()).size, 1);
		assert.equal([...slugs.values()][0], "x-com-en");
	});
});

describe("shortHash", () => {
	/**
	 * A contract with pages we do not control: `<speedlify-score>` embeds in the
	 * wild hardcode this value, so the filename it produces cannot drift.
	 */
	test("matches the value published in the component's own README", () => {
		assert.equal(shortHash("https://www.zachleat.com/"), "bbfa43c1");
	});

	test("is stable, lowercase hex, and differs per URL", () => {
		const a = shortHash("https://www.11ty.dev/");
		assert.equal(a, shortHash("https://www.11ty.dev/"), "same input, same output");
		assert.match(a, /^[0-9a-f]+$/);
		assert.notEqual(a, shortHash("https://11ty.dev/"), "www is part of the string");
		assert.notEqual(shortHash("https://x.com/en"), shortHash("https://x.com/en/"));
	});

	test("takes the URL exactly as given, without normalizing", () => {
		// The original hashes the URL as configured. Normalizing here would change
		// the filename and break every embed that hardcoded the old one.
		assert.notEqual(shortHash("https://X.com/"), shortHash("https://x.com/"));
	});

	test("handles an empty string without throwing", () => {
		assert.equal(typeof shortHash(""), "string");
	});
});
