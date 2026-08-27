export default {
	title: "speedlify2",
	tagline: "Web performance, measured over time",
	description:
		"Lighthouse lab metrics, Axe, and Chrome UX Report field data for a list of sites recorded and compared over time.",
	// Set to your deployed origin for absolute URLs in metadata.
	// Where this instance is published. Used for the copy-paste embed snippets,
	// which land on other people's sites and so need an absolute URL — a path
	// would resolve against their domain. No trailing slash: the templates add
	// one, and two would give //js/speedlify2-score.js.
	url: process.env.SPEEDLIFY_SITE_URL || "https://www.speedlify.dev",
	// Where the source lives, linked from the footer. Defaulted rather than left
	// blank: an empty string silently drops the link, which is how the header one
	// went unnoticed for so long. Override it when running your own instance.
	repo: process.env.SPEEDLIFY_REPO_URL || "https://github.com/zachleat/speedlify2",

	// Favicon service for the site list. `{url}` is replaced with the
	// encoded site URL. Set to "" for a build that makes no external requests
	// at all — which is arguably the right default for a tool that measures
	// third-party weight for a living.
	avatarService: "https://v1.indieweb-avatar.11ty.dev/{url}/",

	// Screenshot service for the individual site pages. Same substitution, same
	// switch: "" turns it off. `medium` is 650px wide at the service's default
	// 1:1 ratio; the sizes it offers are small (375), medium (650), large (1024)
	// and opengraph (1200x630).
	//
	// One request per site page rather than per row, which is why this is on the
	// detail pages and not the leaderboard — a category page carries a thousand
	// rows, and a thousand screenshots is not a page, it is a denial of service
	// aimed at someone else's server.
	screenshotService: "https://v1.screenshot.11ty.dev/{url}/medium/",
};
