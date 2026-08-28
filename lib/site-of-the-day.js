/**
 * Which perfect site is featured today, and which have already had a turn.
 *
 * The card used to hash the date against each candidate, which is stable within
 * a day and otherwise memoryless: out of 150 sites, one would come up twice in
 * a fortnight about as often as not, while another waited a year. The rule now
 * is that every eligible site is featured once before any is featured twice.
 *
 * That rule needs to know what has already been shown — but deliberately not by
 * storing it. A log would have to be committed to survive the runner, which
 * means giving the publish workflow write access to the repository for one
 * file, and a daily commit that races the measurement shards.
 *
 * Instead the history is *recomputed*. Selection is a pure function of the day
 * and the pool, so replaying the days since the cycle began reproduces exactly
 * which sites are spent, with no state anywhere. The replay is bounded by the
 * pool size rather than by how long the instance has been running, because
 * cycle boundaries fall on fixed multiples of the pool size from EPOCH.
 *
 * The cost of statelessness: the pool changes as sites gain and lose their
 * perfect scores, and the replay always uses today's pool. A site that drops
 * out is treated as never having been featured, so a neighbor can occasionally
 * repeat sooner than a stored log would have allowed. In exchange there is
 * nothing to get out of sync, nothing to commit, and any checkout of any age
 * computes the same answer for the same day.
 */

/** Day zero for the rotation. Arbitrary, fixed, and never to be changed: moving
 *  it reshuffles every future cycle boundary. */
const EPOCH = Date.UTC(2026, 0, 1);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole UTC days from EPOCH to a `YYYY-MM-DD` string. Negative before it. */
function daysSinceEpoch(day) {
	return Math.floor((Date.parse(`${day}T00:00:00Z`) - EPOCH) / DAY_MS);
}

function dayFromIndex(index) {
	return new Date(EPOCH + index * DAY_MS).toISOString().slice(0, 10);
}

/**
 * djb2 over `day:url`, hex-padded so the comparison is lexicographic on a fixed
 * width rather than numeric on a float.
 *
 * A hash rather than list order because the pool arrives in leaderboard order:
 * taking the front of it would feature the fastest sites first and work down,
 * and every cycle would run in the same sequence.
 */
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
 * Pure: same pool and same day, same answer, on any machine at any time. That
 * is what lets the hourly publish rebuild without a decision to remember.
 */
export function selectSiteOfTheDay(pool, day) {
	if (!pool.length) return null;

	const size = pool.length;
	const index = daysSinceEpoch(day);

	// Cycles are `size` days long and start at fixed multiples of it, so the
	// replay below never runs longer than one cycle however old the instance is.
	// floorDiv, not trunc: a date before EPOCH must round down too, or the
	// position within the cycle comes out negative.
	const cycle = Math.floor(index / size);
	const position = index - cycle * size;

	// Replay the cycle so far. Each past day takes the best of what was left,
	// which is the same choice this function made on that day.
	const used = new Set();
	for (let i = 0; i < position; i++) {
		const past = highestHash(
			pool.filter((e) => !used.has(e.url)),
			dayFromIndex(cycle * size + i),
		);
		if (past) used.add(past.url);
	}

	const remaining = pool.filter((e) => !used.has(e.url));
	const entry = highestHash(remaining.length ? remaining : pool, day);
	if (!entry) return null;

	return {
		entry,
		// 1-based, for reading: "the 3rd of 152 in this cycle".
		position: position + 1,
		cycle: cycle + 1,
		pool: size,
	};
}
