/**
 * Company headcount, for the "Employees vs LCP" chart on /charts/.
 *
 * Hand-maintained on purpose. Wikidata was the obvious automated source and it
 * does not hold up: it covers 22 of the 26 Big Tech sites but only 2 of the 20
 * hosts and 2 of the 9 builders, and what it does hold is old — Uber at 12,000
 * from 2017, IBM at 352,600 from 2019. `npm run check:companies` re-queries it
 * and prints the disagreements rather than overwriting anything here.
 *
 * Crunchbase and OpenCorporates were the other candidates. OpenCorporates is
 * registry data and carries no headcount at all; Crunchbase has it but its
 * terms do not allow republishing it on a public site.
 *
 * `employees: null` means no credible public figure was found. Those sites are
 * still measured and still ranked everywhere else on this site; they are only
 * absent from this one chart, which is the honest outcome rather than a guess
 * dressed up as a data point.
 *
 * Subsidiary sites are filed under the parent that owns them, so Azure Static
 * Web Apps carries Microsoft's headcount. The chart is about the resources
 * behind a page, and those are the parent's.
 *
 * `urls[0]` is the canonical site — the company's flagship rather than a product
 * subdomain — and it is the one the chart plots. The rest are listed so that a
 * subsidiary property still resolves to the right headcount everywhere else, and
 * so the chart can fall back to one if the flagship has no measurement. Order
 * matters here; a test asserts it.
 */

/** @typedef {{ name: string, employees: number|null, asOf: string|null, source: string, wikidata?: string, urls: string[] }} Company */

/** @type {Company[]} */
export default [
	// ---- Big Tech -----------------------------------------------------------
	{
		name: "Nvidia",
		employees: 42000,
		asOf: "2026-01",
		source: "FY2026 Form 10-K",
		wikidata: "Q182477",
		urls: ["https://www.nvidia.com/"],
	},
	{
		name: "Apple",
		employees: 164000,
		asOf: "2024-09",
		source: "FY2024 Form 10-K",
		wikidata: "Q312",
		urls: ["https://www.apple.com/"],
	},
	{
		name: "Microsoft",
		employees: 228000,
		asOf: "2025-06",
		source: "FY2025 Form 10-K",
		wikidata: "Q2283",
		urls: [
			"https://www.microsoft.com/",
			"https://pages.github.com/",
			"https://azure.microsoft.com/en-us/products/app-service/static",
		],
	},
	{
		// about.google and google.com are the same filer, so they share a row.
		// google.com leads because it is the address anyone would name for this
		// company; about.google is a corporate microsite by comparison.
		name: "Alphabet",
		employees: 183323,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q20800404",
		urls: [
			"https://www.google.com/",
			"https://about.google/",
			"https://firebase.google.com/products/hosting",
		],
	},
	{
		name: "Amazon",
		employees: 1556000,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q3884",
		urls: ["https://www.amazon.com/", "https://aws.amazon.com/amplify/"],
	},
	{
		name: "Meta",
		employees: 74067,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q380",
		urls: ["https://www.meta.com/"],
	},
	{
		name: "Broadcom",
		employees: 37000,
		asOf: "2024-11",
		source: "FY2024 Form 10-K",
		wikidata: "Q555925",
		urls: ["https://www.broadcom.com/"],
	},
	{
		name: "TSMC",
		employees: 83000,
		asOf: "2024-12",
		source: "2024 annual report",
		wikidata: "Q713418",
		urls: ["https://www.tsmc.com/"],
	},
	{
		name: "Tesla",
		employees: 125665,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q478214",
		urls: ["https://www.tesla.com/"],
	},
	{
		name: "Oracle",
		employees: 162000,
		asOf: "2025-05",
		source: "FY2025 Form 10-K",
		wikidata: "Q19900",
		urls: ["https://www.oracle.com/"],
	},
	{
		name: "Netflix",
		employees: 14000,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q907311",
		urls: ["https://www.netflix.com/"],
	},
	{
		name: "SAP",
		employees: 108187,
		asOf: "2024-12",
		source: "2024 integrated report",
		wikidata: "Q552581",
		urls: ["https://www.sap.com/"],
	},
	{
		name: "Salesforce",
		employees: 76453,
		asOf: "2025-01",
		source: "FY2025 Form 10-K",
		wikidata: "Q941127",
		urls: ["https://www.salesforce.com/", "https://www.heroku.com/"],
	},
	{
		name: "AMD",
		employees: 28000,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q128896",
		urls: ["https://www.amd.com/"],
	},
	{
		name: "Adobe",
		employees: 30709,
		asOf: "2024-11",
		source: "FY2024 Form 10-K",
		wikidata: "Q11463",
		urls: ["https://www.adobe.com/"],
	},
	{
		name: "Cisco",
		employees: 86200,
		asOf: "2025-07",
		source: "FY2025 Form 10-K",
		wikidata: "Q173395",
		urls: ["https://www.cisco.com/"],
	},
	{
		name: "IBM",
		employees: 270300,
		asOf: "2024-12",
		source: "2024 annual report",
		wikidata: "Q37156",
		urls: ["https://www.ibm.com/"],
	},
	{
		name: "Qualcomm",
		employees: 49000,
		asOf: "2024-09",
		source: "FY2024 Form 10-K",
		wikidata: "Q294958",
		urls: ["https://www.qualcomm.com/"],
	},
	{
		name: "Intel",
		employees: 108900,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q248",
		urls: ["https://www.intel.com/"],
	},
	{
		name: "Texas Instruments",
		employees: 34000,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q193412",
		urls: ["https://www.ti.com/"],
	},
	{
		name: "Samsung",
		employees: 267860,
		asOf: "2024-12",
		source: "Samsung Electronics 2024 sustainability report",
		wikidata: "Q20718",
		urls: ["https://www.samsung.com/"],
	},
	{
		name: "Sony",
		employees: 112300,
		asOf: "2025-03",
		source: "FY2024 annual report",
		wikidata: "Q41187",
		urls: ["https://www.sony.com/"],
	},
	{
		name: "ServiceNow",
		employees: 26293,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q7455653",
		urls: ["https://www.servicenow.com/"],
	},
	{
		name: "Uber",
		employees: 31100,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q780442",
		urls: ["https://www.uber.com/"],
	},
	{
		name: "Palantir",
		employees: 3936,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q2047336",
		urls: ["https://www.palantir.com/"],
	},

	// ---- Web Hosts ----------------------------------------------------------
	{
		name: "Cloudflare",
		employees: 4431,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q4778915",
		urls: ["https://www.cloudflare.com/", "https://pages.cloudflare.com/"],
	},
	{
		name: "Fastly",
		employees: 1100,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q34045622",
		urls: ["https://www.fastly.com/"],
	},
	{
		name: "DigitalOcean",
		employees: 1150,
		asOf: "2024-12",
		source: "2024 Form 10-K",
		wikidata: "Q17052116",
		urls: ["https://www.digitalocean.com/"],
	},
	{
		name: "GitLab",
		employees: 2300,
		asOf: "2025-01",
		source: "FY2025 Form 10-K",
		wikidata: "Q16639197",
		urls: ["https://docs.gitlab.com/user/project/pages/"],
	},
	{
		name: "Netlify",
		employees: 200,
		asOf: "2021-12",
		source: "last figure the company disclosed publicly",
		wikidata: "Q56102498",
		urls: ["https://www.netlify.com/"],
	},
	{
		name: "Neocities",
		employees: 1,
		asOf: "2024-01",
		source: "run as a one-person nonprofit, as the site states",
		wikidata: "Q17071099",
		urls: ["https://neocities.org/"],
	},
	// Private and undisclosed. Listed rather than deleted so the gap is visible
	// and so a figure only has to be dropped in when one is published.
	{ name: "Vercel", employees: null, asOf: null, source: "private, undisclosed", wikidata: "Q56069184", urls: ["https://vercel.com/"] },
	{ name: "Fly.io", employees: null, asOf: null, source: "private, undisclosed", wikidata: "Q133943318", urls: ["https://fly.io/"] },
	{ name: "Render", employees: null, asOf: null, source: "private, undisclosed", urls: ["https://render.com/"] },
	{ name: "Railway", employees: null, asOf: null, source: "private, undisclosed", urls: ["https://railway.com/"] },
	{ name: "Deno", employees: null, asOf: null, source: "private, undisclosed", wikidata: "Q131417385", urls: ["https://deno.com/deploy"] },
	{ name: "Bunny", employees: null, asOf: null, source: "private, undisclosed", urls: ["https://bunny.net/"] },
	{ name: "Surge", employees: null, asOf: null, source: "private, undisclosed", urls: ["https://surge.sh/"] },
	{ name: "Codeberg", employees: null, asOf: null, source: "volunteer nonprofit, no published headcount", urls: ["https://codeberg.page/"] },

	// ---- Website Builders ---------------------------------------------------
	{
		name: "Shopify",
		employees: 8100,
		asOf: "2024-12",
		source: "2024 Form 40-F",
		wikidata: "Q7501150",
		urls: ["https://www.shopify.com/"],
	},
	{
		name: "Wix",
		employees: 5600,
		asOf: "2024-12",
		source: "2024 Form 20-F",
		wikidata: "Q420506",
		urls: ["https://www.wix.com/"],
	},
	{
		name: "Squarespace",
		employees: 1900,
		asOf: "2023-12",
		source: "2023 Form 10-K, its last before going private",
		wikidata: "Q7582097",
		urls: ["https://www.squarespace.com/"],
	},
	{
		name: "Automattic",
		employees: 1700,
		asOf: "2024-10",
		source: "company-published headcount",
		wikidata: "Q2001888",
		urls: ["https://wordpress.com/"],
	},
	{ name: "Webflow", employees: null, asOf: null, source: "private, undisclosed", wikidata: "Q20160951", urls: ["https://webflow.com/"] },
	{ name: "Tilda", employees: null, asOf: null, source: "private, undisclosed", wikidata: "Q55656996", urls: ["https://tilda.cc/"] },
	{ name: "Duda", employees: null, asOf: null, source: "private, undisclosed", urls: ["https://www.duda.co/"] },
	{ name: "Framer", employees: null, asOf: null, source: "private, undisclosed", urls: ["https://www.framer.com/"] },
	{ name: "Nordcraft", employees: null, asOf: null, source: "private, undisclosed", urls: ["https://nordcraft.com/"] },
];
