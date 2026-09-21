/**
 * Which perfect site is featured today, and which have already had a turn.
 *
 * Every eligible site is featured once before any is featured twice. Nothing is stored: the rotation is
 * replayed day by day from START, each day against the pool as it stood that day, so past picks stay put
 * as the pool changes.
 */

/** Day one of the rotation; moving it reshuffles every pick after it. */
export const START = "2026-08-25";

const DAY_MS = 24 * 60 * 60 * 1000;

const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** djb2 over `day:url`, so each cycle runs in a different order rather than leaderboard order. */
function highestHash(entries, day) {
	let best = null;
	let bestKey = "";

	for (let entry of entries) {
		let h = 5381;
		const seed = `${day}:${entry.url}`;
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
 * The day's site, plus where it falls in the rotation.
 *
 * `poolFor(day)` returns the sites eligible on that day. Pure: the same pools give the same answer anywhere.
 */
export function selectSiteOfTheDay(poolFor, day, { start = START } = {}) {
	let used = new Set();
	let cycle = 1;

	const pick = (d) => {
		const pool = poolFor(d);
		if (!pool.length) return null;

		let remaining = pool.filter((e) => !used.has(e.url));
		if (!remaining.length) {
			used = new Set();
			cycle++;
			remaining = pool;
		}

		const entry = highestHash(remaining, d);
		used.add(entry.url);
		return { entry, pool: pool.length };
	};

	for (let d = start; d < day; d = nextDay(d)) pick(d);

	const today = pick(day);
	if (!today) return null;

	return {
		entry: today.entry,
		// 1-based, for reading: "the 3rd of 152 in this cycle".
		position: used.size,
		cycle,
		pool: today.pool,
	};
}
