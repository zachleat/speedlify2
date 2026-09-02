/**
 * <speedlify2-score> — six rings of scores for one URL, linking to its report.
 *
 *   <script type="module" src="https://your-speedlify/js/speedlify2-score.js"></script>
 *   <speedlify2-score speedlify-url="https://your-speedlify/"></speedlify2-score>
 *
 * No `url` means the current page. No index is downloaded: the data file is
 * found by slugifying the URL. A site published under a hash instead reads as
 * unmeasured rather than as the wrong site.
 */

/** Shared, so ten badges pointing at one URL make one request. */
class SpeedlifyStore {
	constructor() {
		this.fetches = new Map();
	}

	static join(base, path) {
		const root = base.endsWith("/") ? base : `${base}/`;
		return root + (path.startsWith("/") ? path.slice(1) : path);
	}

	/** Matches normalizeUrl in lib/hash.js. */
	static normalizeUrl(url) {
		try {
			const u = new URL(url);
			u.hash = "";
			u.hostname = u.hostname.toLowerCase();
			if (u.pathname === "") u.pathname = "/";
			return u.toString();
		} catch {
			return String(url).trim();
		}
	}

	/** Must match siteSlug() in lib/slug.js; test/slug.test.js pins the two. */
	static slug(url) {
		let source;
		try {
			const u = new URL(SpeedlifyStore.normalizeUrl(url));
			const pathname = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
			source = `${u.hostname}${pathname}${u.search}`;
		} catch {
			source = String(url).trim();
		}

		const slug = source
			.toLowerCase()
			.replace(/-/g, "--")
			.replace(/[^a-z0-9-]/g, "-")
			.slice(0, 180);

		// All separators means it was published under a hash, which cannot be
		// derived here — 404 rather than risk another site's numbers.
		return /[a-z0-9]/.test(slug) ? slug : "";
	}

	async fetch(apiUrl) {
		if (!this.fetches.has(apiUrl)) {
			this.fetches.set(
				apiUrl,
				fetch(apiUrl)
					.then((response) => {
						if (!response.ok) throw new Error(`${response.status} for ${apiUrl}`);
						return response.json();
					})
					// Uncached on failure, so one bad response is not permanent.
					.catch((error) => {
						this.fetches.delete(apiUrl);
						throw error;
					}),
			);
		}
		return this.fetches.get(apiUrl);
	}

	async load(speedlifyUrl, { url }) {
		return this.fetch(SpeedlifyStore.join(speedlifyUrl, `api/site/${SpeedlifyStore.slug(url)}.json`));
	}
}

const store = new SpeedlifyStore();

class SpeedlifyScore extends HTMLElement {
	static tagName = "speedlify2-score";

	/** Guards a missing registry — a worker, a partial DOM. */
	static register(tagName) {
		const registry = globalThis.customElements;
		if (!registry) return;

		const name = tagName || SpeedlifyScore.tagName;
		if (!registry.get(name)) registry.define(name, SpeedlifyScore);
	}

	static attrs = {
		speedlifyUrl: "speedlify-url",
		url: "url",
		// "light" or "dark". Absent follows the host page.
		theme: "theme",
	};

	/*
	 * light-dark() follows the host page's color-scheme, not the reader's OS,
	 * because the numerals sit directly on the host's background — the dark
	 * greens and ambers measure about 2:1 on white.
	 */
	static css = `
:host {
	--spdl-good: light-dark(#0a7c42, #0cce6b);
	--spdl-average: light-dark(#9a6200, #ffa400);
	--spdl-poor: light-dark(#c02026, #ff4e42);
	--spdl-none: light-dark(#6b6b6b, #888);
	--spdl-track: light-dark(rgb(0 0 0 / .18), rgb(136 136 136 / .35));

	display: inline-flex;
	align-items: center;
	gap: .3em;
	font-family: inherit;
	font-size: inherit;
	line-height: 1;
	vertical-align: middle;
}

/* Overriding color-scheme is the whole of forcing a theme. */
:host([theme="light"]) { color-scheme: light; }
:host([theme="dark"]) { color-scheme: dark; }

:host([hidden]) { display: none; }

/* The scoreRing shortcode's box exactly, so a badge and the leaderboard draw
   one picture. Only the outer size is in em, so it scales with its context. */
.ring {
	display: block;
	flex: none;
	overflow: visible;
	width: 2.467em;
	height: 2.467em;
}
.ring-track { stroke: var(--spdl-track); }
.ring-arc { stroke: currentColor; }
.ring-text {
	font-family: inherit;
	font-size: 12px;
	font-weight: 650;
	font-variant-numeric: tabular-nums;
	fill: currentColor;
}
.ring-sublabel {
	font-family: inherit;
	font-size: 6px;
	font-weight: 700;
	letter-spacing: .04em;
	fill: currentColor;
}

/* The track alone at the finished size, so the swap moves nothing. */
.skeleton {
	color: var(--spdl-none);
	opacity: .45;
	animation: speedlify-pulse 1.4s ease-in-out infinite;
}
@keyframes speedlify-pulse {
	0%, 100% { opacity: .25; }
	50%      { opacity: .6; }
}
@media (prefers-reduced-motion: reduce) {
	.skeleton { animation: none; }
}

.good    { color: var(--spdl-good); }
.average { color: var(--spdl-average); }
.poor    { color: var(--spdl-poor); }
.none    { color: var(--spdl-none); }

.rings {
	display: inline-flex;
	align-items: center;
	gap: .3em;
	text-decoration: none;
	color: inherit;
}
.rings:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; border-radius: 4px; }
`;

	static geometry = (() => {
		const size = 37;
		const stroke = 3;
		const r = (size - stroke) / 2;
		return { size, stroke, r, c: size / 2, circumference: 2 * Math.PI * r };
	})();

	/** Labels carry measured values — escape them. */
	static escape(value) {
		return String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	connectedCallback() {
		if (this.shadowRoot) return;

		this.attachShadow({ mode: "open" });
		this.renderSkeleton();

		this.init().catch((error) => {
			// Disappear rather than shout on someone else's page.
			this.dataset.error = error.message;
			this.hidden = true;
		});
	}

	get speedlifyUrl() {
		const value = this.getAttribute(SpeedlifyScore.attrs.speedlifyUrl);
		if (!value) throw new Error(`<${SpeedlifyScore.tagName}> requires a ${SpeedlifyScore.attrs.speedlifyUrl} attribute`);
		return value;
	}

	/** Painted before the fetch, at the size the real rings occupy. */
	renderSkeleton() {
		const style = document.createElement("style");
		style.textContent = SpeedlifyScore.css;

		const wrapper = document.createElement("div");
		wrapper.style.display = "contents";
		const placeholder = this.ring({ band: "skeleton", text: "", label: "", pct: null });
		wrapper.innerHTML = `<span class="rings" aria-hidden="true">${placeholder.repeat(6)}</span>`;

		this.setAttribute("aria-busy", "true");
		this.shadowRoot.replaceChildren(style, wrapper);
	}

	async init() {
		const data = await store.load(this.speedlifyUrl, {
			// Default to the page this is embedded on.
			url: this.getAttribute(SpeedlifyScore.attrs.url) || location.href,
		});

		if (!data.measured) {
			this.hidden = true;
			return;
		}

		const style = document.createElement("style");
		style.textContent = SpeedlifyScore.css;

		const wrapper = document.createElement("div");
		wrapper.style.display = "contents";
		wrapper.innerHTML = this.render(data);

		this.shadowRoot.replaceChildren(style, wrapper);
		this.removeAttribute("aria-busy");
	}

	scoreClass(value) {
		if (typeof value !== "number") return "none";
		if (value >= 90) return "good";
		if (value >= 50) return "average";
		return "poor";
	}

	/**
	 * `pct` fills the arc and is not the value: axe and CWV have no percentage,
	 * so they pass 1 and read as a closed ring colored by the answer. `null`
	 * leaves the track bare.
	 */
	ring({ band, text, label, pct, sublabel = "" }) {
		const { size, stroke, r, c, circumference } = SpeedlifyScore.geometry;
		const arc =
			typeof pct === "number"
				? `<circle class="ring-arc" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${stroke}"` +
					` stroke-dasharray="${(circumference * Math.max(0, Math.min(1, pct))).toFixed(2)} ${circumference.toFixed(2)}"` +
					` stroke-linecap="round" transform="rotate(-90 ${c} ${c})"/>`
				: "";

		return [
			`<svg class="ring ${band}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${SpeedlifyScore.escape(label)}">`,
			`<circle class="ring-track" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${stroke}"/>`,
			arc,
			// A sublabel shifts the value up so the pair centers as a block.
			`<text class="ring-text" x="${c}" y="${sublabel ? c - 3.5 : c}" text-anchor="middle" dominant-baseline="central">${SpeedlifyScore.escape(text)}</text>`,
			sublabel
				? `<text class="ring-sublabel" x="${c}" y="${c + 7}" text-anchor="middle" dominant-baseline="central">${SpeedlifyScore.escape(sublabel)}</text>`
				: "",
			`</svg>`,
		].join("");
	}

	scoreHtml(label, value) {
		return this.ring({
			band: this.scoreClass(value),
			text: value ?? "–",
			label: `${label}: ${value ?? "no data"}`,
			pct: typeof value === "number" ? value / 100 : null,
		});
	}

	/** Zero is the good answer here, so axe gets its own banding and a glyph. */
	axeHtml(value) {
		if (typeof value !== "number") {
			return this.ring({ band: "none", text: "–", sublabel: "AXE", label: "Axe: did not run", pct: null });
		}
		const band = value === 0 ? "good" : value <= 5 ? "average" : "poor";
		return this.ring({
			band,
			text: band === "good" ? "✓" : band === "average" ? "!" : "✗",
			sublabel: "AXE",
			label: `Axe: ${value} violating node${value === 1 ? "" : "s"}`,
			pct: 1,
		});
	}

	/** Three metrics, so a verdict rather than a number. */
	cwvHtml(cwv) {
		if (!cwv || cwv.pass === null || cwv.pass === undefined) {
			return this.ring({ band: "none", text: "–", sublabel: "CWV", label: "Core Web Vitals: no data", pct: null });
		}
		const source = cwv.source === "field" ? "real users" : "lab approximation";
		return this.ring({
			band: cwv.pass ? "good" : "poor",
			text: cwv.pass ? "✓" : "✗",
			sublabel: "CWV",
			label: `Core Web Vitals: ${cwv.pass ? "pass" : "fail"} (${source})`,
			pct: 1,
		});
	}

	/**
	 * The four Lighthouse scores, then axe and CWV — what those four miss.
	 * Unconfigurable, so several badges on a page read as one table.
	 */
	render(data) {
		const rings = [
			this.scoreHtml("Performance", data.lighthouse?.performance),
			this.scoreHtml("Accessibility", data.lighthouse?.accessibility),
			this.scoreHtml("Best Practices", data.lighthouse?.bestPractices),
			this.scoreHtml("SEO", data.lighthouse?.seo),
			this.axeHtml(data.axe),
			this.cwvHtml(data.cwv),
		].join("");

		// A link with nowhere to go is worse than none.
		if (!data.page) return `<span class="rings">${rings}</span>`;

		const href = SpeedlifyScore.escape(SpeedlifyStore.join(this.speedlifyUrl, data.page));
		const title = SpeedlifyScore.escape(`Full report for ${data.name ?? data.url}`);
		return `<a class="rings" href="${href}" title="${title}">${rings}</a>`;
	}
}

/** Registers on import, so `import "speedlify2-score"` is enough. */
SpeedlifyScore.register();

export { SpeedlifyScore, SpeedlifyStore };
