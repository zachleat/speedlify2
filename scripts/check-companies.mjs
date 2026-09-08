/**
 * Cross-checks config/companies.js against Wikidata and the site config.
 *
 * Reports; never writes. Wikidata is too incomplete and too stale to be the
 * source here — it has no headcount for most of the hosts, and what it does
 * have runs years behind — so it is useful as a second opinion and nothing
 * more. See the header of config/companies.js.
 */
import companies from "../config/companies.js";
import config from "../config/sites.js";
import { auditCompanies } from "../lib/companies.js";

const COMPANY_GROUPS = ["big-tech", "hosts", "builders"];
const UA = "speedlify2 (https://github.com/zachleat/speedlify2)";
const DISAGREE = 0.1;

const siteUrls = COMPANY_GROUPS.flatMap((g) => (config.groups[g]?.sites ?? []).map((s) => s.url));
const { unmapped, stale, duplicates, missing } = auditCompanies(companies, siteUrls);

const say = (label, list, format = (x) => x) => {
	if (!list.length) return;
	console.log(`\n${label} (${list.length})`);
	for (const item of list) console.log(`  ${format(item)}`);
};

say("Sites in a company category with no entry in config/companies.js", unmapped);
say("URLs in config/companies.js that no category lists", stale);
say("URLs claimed by two companies", duplicates, (d) => `${d.url} — ${d.held} and ${d.also}`);
say("No published headcount, so absent from the chart", missing);

// Latest P1128 (employees) for every entry carrying a Wikidata id, preferring a
// statement with a point-in-time qualifier over one without.
async function wikidata(id) {
	const res = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`, {
		headers: { "User-Agent": UA },
	});
	if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
	const claims = (await res.json()).entities?.[id]?.claims?.P1128 ?? [];
	const values = claims
		.map((c) => ({
			value: Number(c.mainsnak?.datavalue?.value?.amount),
			asOf: c.qualifiers?.P585?.[0]?.datavalue?.value?.time?.slice(1, 8) ?? null,
		}))
		.filter((v) => Number.isFinite(v.value))
		.sort((a, b) => String(b.asOf).localeCompare(String(a.asOf)));
	return values[0] ?? null;
}

const checkable = companies.filter((c) => c.wikidata && c.employees);
console.log(`\nChecking ${checkable.length} entries against Wikidata…`);

const differs = [];
for (const company of checkable) {
	try {
		const found = await wikidata(company.wikidata);
		if (!found) continue;
		const drift = Math.abs(found.value - company.employees) / company.employees;
		if (drift >= DISAGREE) differs.push({ company, found, drift });
	} catch (err) {
		console.log(`  ${company.name}: ${err.message}`);
	}
}

say(
	`Disagrees with Wikidata by more than ${DISAGREE * 100}%`,
	differs.sort((a, b) => b.drift - a.drift),
	({ company, found, drift }) =>
		`${company.name.padEnd(20)} ours ${company.employees.toLocaleString("en-US").padStart(9)} (${company.asOf})` +
		`  wikidata ${found.value.toLocaleString("en-US").padStart(9)} (${found.asOf ?? "undated"})` +
		`  ${(drift * 100).toFixed(0)}%`,
);

// Wikidata being older is the ordinary case rather than a problem, so this is
// not an exit code.
console.log("\nWikidata is usually the stale one. Check the filing before editing.");
