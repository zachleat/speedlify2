import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { documentSample, lighthouseSample, detectRender, normalizeDocument, cacheStatus } from "../lib/render.js";

const page = (body = "", head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const nextData = (data) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
const wordpress = { id: "wordpress", name: "WordPress" };

describe("document samples", () => {
	test("hash ignores Cloudflare's per-request injections", () => {
		const a = page(`<a href="/cdn-cgi/l/email-protection#abc123" data-cfemail="abc123">x</a><script>window.__CF$cv$params={r:'1'};</script>`);
		const b = page(`<a href="/cdn-cgi/l/email-protection#def456" data-cfemail="def456">x</a><script>window.__CF$cv$params={r:'2'};</script>`);
		assert.equal(documentSample(a).hash, documentSample(b).hash);
	});

	test("hash ignores comments and nonce attributes", () => {
		assert.equal(normalizeDocument(`<p>a</p><!-- 12:00:01 --><script nonce="x1">`), normalizeDocument(`<p>a</p><!-- 12:00:02 --><script nonce="x2">`));
	});

	test("nonce comes from the CSP header and attributes", () => {
		const one = documentSample(page(`<script nonce="abc"></script>`));
		const two = documentSample(page(), { "Content-Security-Policy": "script-src 'nonce-abc'" });
		assert.equal(one.nonce, two.nonce);
		assert.equal(documentSample(page()).nonce, null);
		assert.equal(two.headers["content-security-policy"], undefined);
	});

	test("Next.js and Nuxt flags", () => {
		assert.deepEqual(documentSample(page(nextData({ gssp: true }))).marks, ["next-gssp"]);
		assert.deepEqual(documentSample(page(nextData({ nextExport: true, autoExport: true }))).marks, ["next-export", "next-auto-export"]);
		assert.deepEqual(documentSample(page(`<script type="application/json" id="__NUXT_DATA__">[{"prerenderedAt":1}]</script>`)).marks, ["nuxt-prerendered"]);
	});

	test("cache plugin comment and its timestamp", () => {
		const html = page("", "") + "<!-- Page cached by LiteSpeed Cache 6.5 on 2026-10-29 10:00:00 -->";
		assert.deepEqual(documentSample(html).stamp, { plugin: "LiteSpeed Cache", at: "2026-10-29 10:00:00" });
	});

	test("nothing to sample without HTML", () => {
		assert.equal(documentSample(null), null);
		assert.equal(documentSample(""), null);
	});

	test("reads the main document from Lighthouse artifacts", () => {
		const url = "https://example.com/";
		const sample = lighthouseSample({
			MainDocumentContent: page("hi"),
			URL: { mainDocumentUrl: url },
			DevtoolsLog: [
				{ method: "Network.responseReceived", params: { type: "Script", response: { url, headers: { age: "9" } } } },
				{ method: "Network.responseReceived", params: { type: "Document", response: { url, headers: { "X-Vercel-Cache": "HIT" } } } },
			],
		});
		assert.deepEqual(sample.headers, { "x-vercel-cache": "HIT" });
		assert.equal(sample.fromCache, undefined);
	});
});

describe("cache status", () => {
	test("reads hits and misses", () => {
		assert.equal(cacheStatus({ "x-litespeed-cache": "hit" }), "hit");
		assert.equal(cacheStatus({ "cache-status": '"Netlify Edge"; fwd=miss' }), "miss");
		assert.equal(cacheStatus({ "cf-cache-status": "DYNAMIC" }), null);
		assert.equal(cacheStatus({ age: "120" }), "hit");
		assert.equal(cacheStatus({}), null);
	});
});

describe("render detection", () => {
	const same = (n, extra = {}) => Array.from({ length: n }, () => documentSample(page("same"), extra));

	test("unknown without samples", () => {
		assert.equal(detectRender(null), null);
		assert.equal(detectRender([]), null);
		assert.equal(detectRender(same(1)), null);
	});

	test("framework markers", () => {
		assert.equal(detectRender([documentSample(page(nextData({ gssp: true })))]).id, "request");
		assert.equal(detectRender([documentSample(page(nextData({ gsp: true })))]).id, "build");
		assert.equal(detectRender([documentSample(page(), { "x-nextjs-prerender": "1" })]).id, "build");
		assert.equal(detectRender([documentSample(page(), { "x-vercel-cache": "PRERENDER" })]).id, "build");
	});

	test("a nonce that changes between loads is request time", () => {
		const samples = ["a", "b"].map((n) => documentSample(page(`<script nonce="${n}"></script>`)));
		assert.deepEqual(detectRender(samples), { id: "request", name: "On each request", detail: "CSP nonce changed between loads" });
	});

	test("a document that changes between loads is request time", () => {
		const samples = [documentSample(page("csrf 1")), documentSample(page("csrf 2"))];
		assert.equal(detectRender(samples).id, "request");
	});

	test("cached loads are not compared", () => {
		const samples = [documentSample(page("a")), documentSample(page("b"), {}, { fromCache: true })];
		assert.equal(detectRender(samples), null);
	});

	test("WordPress behind a page cache", () => {
		const samples = [documentSample(page(), { "x-litespeed-cache": "miss" }), documentSample(page(), { "x-litespeed-cache": "hit" })];
		assert.deepEqual(detectRender(samples, wordpress), { id: "cached", name: "On request, then cached", detail: "Served by LiteSpeed Cache" });
	});

	test("WordPress cache plugin regenerating on every load", () => {
		const samples = ["10:00:00", "10:00:30"].map((t) => documentSample(page() + `<!-- Performance optimized by W3 Total Cache. Served from: example.com @ 2026-10-29 ${t} by W3 Total Cache -->`));
		assert.equal(detectRender(samples, wordpress).detail, "W3 Total Cache timestamp changed between loads");
	});

	test("WordPress with no page cache", () => {
		assert.deepEqual(detectRender(same(3), wordpress), { id: "request", name: "On each request", detail: "WordPress, no page cache detected" });
	});

	test("a static-only generator", () => {
		assert.equal(detectRender(same(3), { id: "eleventy", name: "Eleventy" }).detail, "Eleventy builds static pages");
	});

	test("identical loads with no other signal are only probably static", () => {
		assert.deepEqual(detectRender(same(4)), { id: "likely", name: "Probably at build time", detail: "Same document on 4 loads" });
	});
});
