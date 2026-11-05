import { readRunHistory } from "../../lib/log.js";

const LOGS_DIR = process.env.SPEEDLIFY_LOGS_DIR || "logs";

/**
 * Recent measurement runs, read from the NDJSON run log.
 *
 * Publishing this alongside the results is the point of keeping logs: when a
 * number looks wrong, the first question is always "did that run actually
 * finish?" and this answers it without shell access to the build machine.
 */
export default function () {
	const history = readRunHistory(LOGS_DIR, 50);
	const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
	// Backfill runs fetch CrUX history rather than measuring, so they are left out.
	const measuredThisWeek = readRunHistory(LOGS_DIR, Infinity)
		.filter((r) => !r.runId?.startsWith("backfill-") && Date.parse(r.startedAt) >= weekAgo)
		.reduce((sum, r) => sum + (r.measured || 0), 0);

	return {
		recent: history,
		latest: history[0] || null,
		total: history.length,
		anyFailures: history.some((r) => (r.failed || 0) > 0),
		measuredThisWeek,
	};
}
