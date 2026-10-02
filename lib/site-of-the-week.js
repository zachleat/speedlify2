/**
 * Which perfect site is featured this week, and which have already had a turn.
 *
 * Every eligible site is featured once before any is featured twice. Nothing is stored: the rotation is
 * replayed week by week from START, each week against the pool as it stood that week, so past picks stay put
 * as the pool changes.
 */

/** Week one of the rotation, a Monday; moving it reshuffles every pick after it. */
export const START = "2026-08-24";

const DAY_MS = 24 * 60 * 60 * 1000;

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The Monday (UTC) starting the week that contains `day`. */
export function weekOf(day) {
	const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
	return addDays(day, -weekday);
}

/** djb2 over `week:url`, so each cycle runs in a different order rather than leaderboard order. */
function highestHash(entries, week) {
	let best = null;
	let bestKey = "";

	for (let entry of entries) {
		let h = 5381;
		const seed = `${week}:${entry.url}`;
		for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
		const key = h.toString(16).padStart(8, "0");

		if (key > bestKey) {
			bestKey = key;
			best = entry;
		}
	}

	return best;
}

/**
 * The week's site, plus where it falls in the rotation.
 *
 * `poolFor(week)` returns the sites eligible in the week starting on that Monday. Pure: the same pools give
 * the same answer anywhere.
 */
export function selectSiteOfTheWeek(poolFor, day, { start = START } = {}) {
	let used = new Set();
	let cycle = 1;

	const pick = (w) => {
		const pool = poolFor(w);
		if (!pool.length) return null;

		let remaining = pool.filter((e) => !used.has(e.url));
		if (!remaining.length) {
			used = new Set();
			cycle++;
			remaining = pool;
		}

		const entry = highestHash(remaining, w);
		used.add(entry.url);
		return { entry, pool: pool.length };
	};

	const week = weekOf(day);
	for (let w = weekOf(start); w < week; w = addDays(w, 7)) pick(w);

	const current = pick(week);
	if (!current) return null;

	return {
		entry: current.entry,
		week,
		// 1-based, for reading: "the 3rd of 152 in this cycle".
		position: used.size,
		cycle,
		pool: current.pool,
	};
}
