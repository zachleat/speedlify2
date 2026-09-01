import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { urlHash, stamp } from "./hash.js";
import {
	SERIES_VERSION,
	buildSeries,
	hydratePoint,
	projectPoint,
	serializeSeries,
	upsertPoint,
} from "./series.js";

/**
 * Recover the measurement time from a filename written by `stamp()`, which
 * replaces every `:` and `.` in an ISO string with `-`:
 *   2026-08-16T15-27-12-185Z  ->  2026-08-16T15:27:12.185Z
 */
export function timestampFromFilename(filename) {
	const base = filename.replace(/\.json$/, "");
	const [datePart, timePart] = base.split("T");
	if (!timePart) return null;

	const iso = `${datePart}T${timePart.replace(/-/g, ":").replace(/:(\d{3}Z)$/, ".$1")}`;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : ms;
}

/**
 * Is this a measurement file, as opposed to one of the sidecars that live in
 * the same directory (meta.json, series.json, field-history.json)?
 *
 * Matching the timestamp shape rather than excluding known names means a new
 * sidecar can be added later without silently being counted as a data point.
 */
export function isMeasurementFile(filename) {
	return /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(filename);
}

/**
 * Result storage.
 *
 * Layout:
 *   results/<url-hash>/<timestamp>.json    one measurement (the archive)
 *   results/<url-hash>/series.json         compact projection for charting
 *   results/<url-hash>/meta.json           last-known name/group for the URL
 *   results/<url-hash>/field-history.json  CrUX weekly history, if backfilled
 *
 * One small file per measurement, append-only. This is deliberately dumb: it
 * diffs cleanly in git, it never needs a migration, and a corrupt file costs
 * you one data point instead of the series.
 *
 * `series.json` is derived from those records and can always be rebuilt, so it
 * is safe to delete, and safe to change the shape of.
 */
/**
 * Pixel dimensions of a JPEG, read from its own header.
 *
 * Recorded so the pages can size the `<img>` and reserve the space before the
 * image arrives. Lighthouse does not report the thumbnail size, and it is not a
 * constant — it follows the emulated viewport, so a desktop run differs from a
 * mobile one.
 *
 * Walks the marker segments looking for a start-of-frame, which is the only
 * one that carries the size. Returns nothing it is not sure of: a missing
 * width is a missing attribute, not a wrong one.
 */
function jpegSize(buffer) {
	// Skip the two-byte SOI. Every following segment is FF, marker, length.
	let offset = 2;
	while (offset + 9 < buffer.length) {
		if (buffer[offset] !== 0xff) break;

		const marker = buffer[offset + 1];
		const length = buffer.readUInt16BE(offset + 2);

		// SOF0 through SOF15, less the three in that range that are not frame
		// headers: DHT (C4), JPG (C8) and DAC (CC).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
		}

		offset += 2 + length;
	}

	return {};
}

export class ResultStore {
	constructor(dir = "results") {
		this.dir = dir;
		fs.mkdirSync(dir, { recursive: true });
	}

	dirFor(url) {
		return path.join(this.dir, urlHash(url));
	}

	/** Persist one measurement and update the site's series. Returns the path. */
	write(record) {
		const dir = this.dirFor(record.url);
		fs.mkdirSync(dir, { recursive: true });

		// Off the record before it is serialized: these are JPEG buffers, and the
		// measurement files are JSON that accumulates forever.
		const { screenshots, pageShots, ...stored } = record;
		this.writeFilmstrip(dir, screenshots, stored.timestamp);
		this.writeScreenshots(dir, {
			// Both slots are the axe pass's viewport captures, and nothing else.
			// A full-page image here would be a different shape from the no-JS
			// one beside it, and the pair only means anything framed alike.
			primary: pageShots?.js ?? null,
			noJs: pageShots?.noJs ?? null,
			difference: pageShots?.difference ?? null,
			noJsText: pageShots?.noJsText ?? null,
		});

		const file = path.join(dir, `${stamp(new Date(record.timestamp))}.json`);
		fs.writeFileSync(file, JSON.stringify(stored, null, 2) + "\n");

		this.appendSeries(stored);

		// Keep a pointer to the current display name so orphaned histories (URLs
		// removed from config) can still be rendered or reported on.
		fs.writeFileSync(
			path.join(dir, "meta.json"),
			JSON.stringify({ url: record.url, name: record.name, group: record.group }, null, 2) + "\n"
		);

		return file;
	}

	/**
	 * The site's screenshots: the page as rendered, and with scripts disabled.
	 *
	 * One file per slot per site, replaced each measurement — a history of
	 * screenshots is a much larger product than a history of numbers, and these
	 * are already the biggest things a measurement produces.
	 *
	 * A null slot leaves whatever is there alone, and the manifest it wrote is
	 * merged forward rather than dropped. A run that failed before rendering has
	 * no opinion about what the site looks like, and the last good picture beats
	 * none — that applies to each slot independently, because the no-JS load can
	 * time out on its own while the ordinary one succeeded.
	 */
	writeScreenshots(dir, { primary = null, noJs = null, difference = null, noJsText = null } = {}) {
		if (!primary?.buffer?.length && !noJs?.buffer?.length) return null;

		fs.mkdirSync(dir, { recursive: true });

		// What the last run wrote. Read before anything is replaced, so a slot
		// this run has nothing for keeps pointing at the file still on disk.
		let manifest = {};
		try {
			manifest = JSON.parse(fs.readFileSync(path.join(dir, "screenshot.json"), "utf8"));
		} catch {
			manifest = {};
		}

		const keep = new Set();

		const put = (shot, stem) => {
			if (!shot?.buffer?.length) return null;

			// Named for what it is, and the manifest carries the filename, because
			// the format is the capture's choice rather than ours: a change of
			// format upstream must not leave a stale file of the old type behind.
			const file = `${stem}.${shot.type === "jpeg" ? "jpg" : shot.type}`;
			fs.writeFileSync(path.join(dir, file), shot.buffer);
			keep.add(file);

			return { file, width: shot.width ?? null, height: shot.height ?? null };
		};

		const wroteNoJs = put(noJs, "screenshot-nojs");

		manifest = {
			...manifest,
			...(put(primary, "screenshot") ?? {}),
			noJs: wroteNoJs ?? manifest.noJs ?? null,
			// Only meaningful for the pair it was computed from. Carried forward
			// with a kept no-JS image, dropped when a fresh one arrives without a
			// score, so the number can never describe two images it did not see.
			difference: wroteNoJs ? difference : (difference ?? manifest.difference ?? null),
			// Same rule as `difference`, and for the same reason: it describes one
			// particular image, so it may not outlive the image it was counted from.
			noJsText: wroteNoJs ? noJsText : (noJsText ?? manifest.noJsText ?? null),
		};

		if (manifest.file) keep.add(manifest.file);
		if (manifest.noJs?.file) keep.add(manifest.noJs.file);

		// Anything matching the naming scheme that no longer belongs to a slot is
		// from a previous run in a format we no longer write.
		for (let stale of fs.readdirSync(dir)) {
			if (/^screenshot(-nojs)?\.(jpg|jpeg|png|webp|avif)$/.test(stale) && !keep.has(stale)) {
				fs.rmSync(path.join(dir, stale), { force: true });
			}
		}

		fs.writeFileSync(path.join(dir, "screenshot.json"), JSON.stringify(manifest, null, 2) + "\n");
		return manifest;
	}

	/**
	 * Store one measurement's filmstrip as files, replacing the previous one.
	 *
	 * Only the latest set is kept. A history of screenshots is a different and
	 * much larger product than a history of numbers — one JSON record is a few
	 * kilobytes and one filmstrip is tens, so keeping every set would make the
	 * pictures the bulk of the repository within a month.
	 *
	 * Frames are named by a hash of their own bytes, which does the deduplicating
	 * for free: a page that finishes early repeats its last frame to the end of
	 * the strip, and those repeats collapse to one file — measured at 8 frames
	 * down to 4 on a fast site. The manifest still lists all eight timings, so
	 * the strip renders at full length from a fraction of the bytes.
	 *
	 * A null strip leaves whatever is on disk alone rather than clearing it. A
	 * run that failed before rendering has no opinion about what the site looks
	 * like, and the last good screenshot is better than none.
	 */
	writeFilmstrip(dir, frames, timestamp) {
		if (!frames?.length) return null;

		const framesDir = path.join(dir, "frames");
		fs.mkdirSync(framesDir, { recursive: true });

		const manifest = { timestamp, ...jpegSize(frames[0].buffer), frames: [] };
		const keep = new Set();

		for (let frame of frames) {
			const name = `${crypto.createHash("sha256").update(frame.buffer).digest("hex").slice(0, 12)}.jpg`;
			keep.add(name);
			// Content-addressed, so a frame already on disk is the same frame.
			// Skipping the write keeps git from seeing a change that isn't one.
			const file = path.join(framesDir, name);
			if (!fs.existsSync(file)) fs.writeFileSync(file, frame.buffer);
			manifest.frames.push({ timing: frame.timing, file: name });
		}

		// The finished page, which is the last frame — same bytes Lighthouse
		// would have handed back as `final-screenshot`.
		manifest.final = manifest.frames[manifest.frames.length - 1].file;

		// Frames the new strip does not use are from the previous measurement.
		// Left in place they would accumulate one dead set per run.
		for (let existing of fs.readdirSync(framesDir)) {
			if (existing.endsWith(".jpg") && !keep.has(existing)) {
				fs.rmSync(path.join(framesDir, existing), { force: true });
			}
		}

		fs.writeFileSync(path.join(dir, "filmstrip.json"), JSON.stringify(manifest, null, 2) + "\n");
		return manifest;
	}

	/** Every measurement for a URL, oldest first. */
	history(url) {
		const dir = this.dirFor(url);
		if (!fs.existsSync(dir)) return [];

		return fs
			.readdirSync(dir)
			.filter(isMeasurementFile)
			.sort()
			.map((f) => {
				try {
					return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
				} catch {
					return null; // one bad file shouldn't take out the series
				}
			})
			.filter(Boolean);
	}

	/** Measurement filenames for a URL, oldest first. Cheap: no file reads. */
	filenames(url) {
		const dir = this.dirFor(url);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter(isMeasurementFile)
			.sort();
	}

	/**
	 * When a URL was last measured — derived from the filename alone.
	 *
	 * Scheduling needs this for every site on every invocation. Reading it from
	 * file contents would mean parsing the entire archive just to decide what to
	 * measure next, which is the difference between a scheduler that costs
	 * milliseconds and one that costs a minute.
	 */
	lastMeasuredAt(url) {
		const files = this.filenames(url);
		if (!files.length) return null;
		return timestampFromFilename(files[files.length - 1]);
	}

	/** Newest measurement, reading exactly one file. */
	latest(url) {
		const files = this.filenames(url);
		return files.length ? this.#read(url, files[files.length - 1]) : null;
	}

	/**
	 * Most recent successful measurement, walking backwards from the newest and
	 * stopping at the first success. Normally one read; only a site that is
	 * currently broken costs more.
	 */
	latestSuccess(url) {
		const files = this.filenames(url);
		for (let i = files.length - 1; i >= 0; i--) {
			const record = this.#read(url, files[i]);
			if (record && !record.error) return record;
		}
		return null;
	}

	/**
	 * The successful record *before* the newest one.
	 *
	 * Used to reconstruct where a site stood on the previous board, so the rank
	 * column can show movement. Walks back from the end like `latestSuccess`
	 * and skips failures, so a site whose last run errored compares its two most
	 * recent good measurements rather than treating the failure as a data point.
	 *
	 * Null when a site has only ever been measured once — it cannot have moved.
	 */
	previousSuccess(url) {
		const files = this.filenames(url);
		let seen = 0;
		for (let i = files.length - 1; i >= 0; i--) {
			const record = this.#read(url, files[i]);
			if (record && !record.error && ++seen === 2) return record;
		}
		return null;
	}

	#read(url, filename) {
		try {
			return JSON.parse(fs.readFileSync(path.join(this.dirFor(url), filename), "utf8"));
		} catch {
			return null;
		}
	}

	/**
	 * The newest N measurements, oldest first (same order as `history()`).
	 *
	 * This is what the report actually needs. Parsing ten years of history to
	 * render thirty rows and a sparkline is the difference between a build that
	 * stays constant-time and one that eventually exhausts the heap.
	 */
	recent(url, limit = 120) {
		return this.filenames(url)
			.slice(-limit)
			.map((f) => this.#read(url, f))
			.filter(Boolean);
	}

	/** Total measurements on disk, without reading any of them. */
	count(url) {
		return this.filenames(url).length;
	}

	/* ------------------------------------------------------------- series */

	seriesFile(url) {
		return path.join(this.dirFor(url), "series.json");
	}

	/** Read the raw series file, or null if absent or unreadable. */
	readSeries(url) {
		const file = this.seriesFile(url);
		if (!fs.existsSync(file)) return null;
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			return Array.isArray(parsed?.points) ? parsed : null;
		} catch {
			return null; // treat a corrupt cache as missing; it rebuilds
		}
	}

	/**
	 * Charting points for a site, newest last.
	 *
	 * This is the read the whole report is built on: one small file per site,
	 * regardless of how many years of measurements sit beside it.
	 *
	 * The series is a derived cache, so a missing or stale one is rebuilt from
	 * the raw records rather than reported as an error. That keeps an existing
	 * results/ directory working with no migration step.
	 */
	series(url, { rebuild = true } = {}) {
		let series = this.readSeries(url);

		if ((!series || this.#needsRebuild(url, series)) && rebuild) {
			series = this.rebuildSeries(url);
		}

		return series ? series.points.map(hydratePoint) : [];
	}

	/**
	 * Rebuild when the projection changed, or when raw records exist that the
	 * series hasn't seen yet.
	 *
	 * Deliberately NOT "point count differs from file count": pruning deletes old
	 * raw records on purpose, and the series is what survives them. Treating a
	 * pruned archive as a stale cache would rebuild the series from the leftovers
	 * and silently erase the history pruning was meant to preserve.
	 */
	#needsRebuild(url, series) {
		if (series.version !== SERIES_VERSION) return true;

		const newestRaw = this.lastMeasuredAt(url);
		if (newestRaw === null) return false;

		const newestPoint = series.points.length ? series.points[series.points.length - 1].t : -Infinity;
		return newestRaw > newestPoint;
	}

	/**
	 * Regenerate a site's series from its raw records.
	 *
	 * Merges by default so points whose raw records have been pruned are kept.
	 * Pass `{ replace: true }` for a hard rebuild from the archive alone.
	 */
	rebuildSeries(url, { replace = false } = {}) {
		const records = this.history(url);
		const existing = replace ? null : this.readSeries(url);

		if (!records.length && !existing?.points?.length) return null;

		const byTimestamp = new Map();
		// Existing points first, so a freshly projected record wins on conflict.
		for (let point of existing?.points || []) byTimestamp.set(point.t, point);
		for (let record of records) byTimestamp.set(record.timestamp, projectPoint(record));

		const series = {
			version: SERIES_VERSION,
			url,
			updated: new Date().toISOString(),
			points: [...byTimestamp.values()].sort((a, b) => a.t - b.t),
		};

		this.#writeSeries(url, series);
		return series;
	}

	/** Add or replace one point without re-reading the archive. */
	appendSeries(record) {
		const url = record.url;
		const existing = this.readSeries(url) || { version: SERIES_VERSION, url, points: [] };
		this.#writeSeries(url, upsertPoint(existing, projectPoint(record)));
	}

	#writeSeries(url, series) {
		const dir = this.dirFor(url);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(this.seriesFile(url), serializeSeries(series));
	}

	/**
	 * All URL hashes that have stored history.
	 *
	 * Matches the hash shape rather than accepting any directory, so a stray
	 * folder inside results/ isn't reported as a mystery site with no URL.
	 */
	hashes() {
		if (!fs.existsSync(this.dir)) return [];
		return fs
			.readdirSync(this.dir, { withFileTypes: true })
			.filter((d) => d.isDirectory() && /^[0-9a-f]{12}$/.test(d.name))
			.map((d) => d.name);
	}

	/**
	 * Drop measurements older than `days`, always keeping `keepMin` most recent
	 * per URL so a long-dormant site never loses its whole history.
	 */
	prune({ days = 365, keepMin = 30, dryRun = false } = {}) {
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		const removed = [];

		for (let hash of this.hashes()) {
			const dir = path.join(this.dir, hash);
			const files = fs
				.readdirSync(dir)
				.filter(isMeasurementFile)
				.sort();

			const candidates = files.slice(0, Math.max(0, files.length - keepMin));
			for (let f of candidates) {
				const full = path.join(dir, f);
				if (fs.statSync(full).mtimeMs >= cutoff) continue;
				removed.push(full);
				if (!dryRun) fs.unlinkSync(full);
			}
		}

		return removed;
	}
}
