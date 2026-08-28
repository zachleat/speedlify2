/**
 * The metrics surfaced in the UI, in display order.
 *
 * `path` is resolved against a stored record. Adding a row here is all it takes
 * to chart a new metric — the history is already being captured.
 */

export const SCORES = [
	{ key: "performance", path: "lab.scores.performance", label: "Performance" },
	{ key: "accessibility", path: "lab.scores.accessibility", label: "Accessibility" },
	{ key: "best-practices", path: "lab.scores.best-practices", label: "Best Practices" },
	{ key: "seo", path: "lab.scores.seo", label: "SEO" },
];

export const LAB_METRICS = [
	{ key: "lcp", path: "lab.timings.lcp", label: "LCP", unit: "ms", note: "Largest Contentful Paint" },
	{ key: "cls", path: "lab.timings.cls", label: "CLS", unit: "", note: "Cumulative Layout Shift" },
	{ key: "tbt", path: "lab.timings.tbt", label: "TBT", unit: "ms", note: "Total Blocking Time" },
	{ key: "fcp", path: "lab.timings.fcp", label: "FCP", unit: "ms", note: "First Contentful Paint" },
	{ key: "si", path: "lab.timings.si", label: "Speed Index", unit: "ms" },
	{ key: "ttfb", path: "lab.timings.ttfb", label: "TTFB", unit: "ms", note: "Time to First Byte" },
];

export const FIELD_METRICS = [
	{ key: "lcp", path: "field.metrics.lcp.p75", label: "LCP", unit: "ms", coreWebVital: true },
	{ key: "inp", path: "field.metrics.inp.p75", label: "INP", unit: "ms", coreWebVital: true,
	  note: "Interaction to Next Paint — field only, Lighthouse cannot measure this in a lab run" },
	{ key: "cls", path: "field.metrics.cls.p75", label: "CLS", unit: "", coreWebVital: true },
	{ key: "fcp", path: "field.metrics.fcp.p75", label: "FCP", unit: "ms" },
	{ key: "ttfb", path: "field.metrics.ttfb.p75", label: "TTFB", unit: "ms" },
];

export const WEIGHT_METRICS = [
	{ key: "total", path: "lab.weight.total", label: "Page Weight", unit: "bytes" },
	{ key: "requests", path: "lab.weight.requests", label: "Requests", unit: "" },
	{ key: "bytes", path: "lab.thirdParty.bytes", label: "Third-party Weight", unit: "bytes" },
	{ key: "mainThreadMs", path: "lab.thirdParty.mainThreadMs", label: "Third-party CPU", unit: "ms" },
	{ key: "unusedJsBytes", path: "lab.waste.unusedJsBytes", label: "Unused JS", unit: "bytes" },
	{ key: "unusedCssBytes", path: "lab.waste.unusedCssBytes", label: "Unused CSS", unit: "bytes" },
];

export const HEALTH_METRICS = [
	{ key: "mainThreadTotal", path: "lab.mainThread.total", label: "Main Thread Work", unit: "ms" },
	{ key: "longTasks", path: "lab.mainThread.longTasks", label: "Long Tasks", unit: "" },
	{ key: "elements", path: "lab.dom.elements", label: "DOM Elements", unit: "" },
	{ key: "axeViolations", path: "axe.violations", label: "Axe Violations", unit: "",
	  note: "Violating nodes from a full Axe CLI run (more than Lighthouse reports)" },
	{ key: "failingCount", path: "lab.accessibility.failingCount", label: "A11y Failures", unit: "" },
	{ key: "failingNodes", path: "lab.accessibility.failingNodes", label: "A11y Failing Nodes", unit: "" },
];

/** Everything we build a time series for. */
export const ALL_TRACKED = [
	...SCORES,
	...LAB_METRICS.map((m) => ({ ...m, group: "lab" })),
	...WEIGHT_METRICS.map((m) => ({ ...m, group: "weight" })),
	...HEALTH_METRICS.map((m) => ({ ...m, group: "health" })),
	...FIELD_METRICS.map((m) => ({ ...m, key: `field-${m.key}`, group: "field" })),
];

export default { SCORES, LAB_METRICS, FIELD_METRICS, WEIGHT_METRICS, HEALTH_METRICS, ALL_TRACKED };
