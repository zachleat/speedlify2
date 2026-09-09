/**
 * Metric display definitions, re-exported for templates.
 *
 * The definitions live in lib/ so the report generator can use them without
 * reaching into the Eleventy source tree.
 */
export {
	SCORES,
	LAB_METRICS,
	FIELD_METRICS,
	COMBINED_METRICS,
	WEIGHT_METRICS,
	HEALTH_METRICS,
	ALL_TRACKED,
	default,
} from "../../lib/report-metrics.js";
