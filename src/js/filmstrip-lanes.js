/*
 * Filmstrip lanes: the frames, gaps, flags, playhead and live frame that
 * /compare/ races and each site page replays. Shared so the two cannot drift.
 */
(function () {
	function el(tag, className) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		return node;
	}

	function fmtMs(value) {
		if (typeof value !== "number") return "—";
		if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 1 : 2) + " s";
		return Math.round(value) + " ms";
	}

	/* Seconds to two places — short enough to sit under a frame, precise enough
	   that two frames a sample apart do not read as the same instant. */
	function fmtSeconds(value) {
		if (typeof value !== "number") return "";
		return (value / 1000).toFixed(2) + "s";
	}

	function fmtClock(value) {
		return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " ms";
	}

	function finishIcon() {
		var source = document.querySelector(".race-icon-source-finish");
		return source ? source.innerHTML : "";
	}

	/*
	 * When the page stopped changing, read off the strip itself: the earliest
	 * frame from which every later frame is the same picture.
	 *
	 * This is the only "finished" these lanes can honestly draw. It is observed —
	 * it comes out of the same screenshots the lanes are made of — so it sits on
	 * the same clock they do.
	 */
	function settledAt(site) {
		var frames = (site && site.frames) || [];
		if (!frames.length) return null;

		/* Measured on the pixels at measurement time — see settleTime in
		   lib/metrics.js. Absent for strips captured before that landed, which
		   fall back to comparing filenames below: exact, and so blind to a page
		   that finished with one widget still moving. */
		if (typeof site.settledAt === "number") return site.settledAt;

		var last = frames[frames.length - 1].src;
		var at = frames[frames.length - 1].timing;
		for (var i = frames.length - 1; i >= 0; i--) {
			if (frames[i].src !== last) break;
			at = frames[i].timing;
		}
		return at;
	}

	// A lane ends where its page stopped changing: later frames are neither drawn nor timed.
	function trimToSettle(site) {
		var settled = settledAt(site);
		if (typeof settled === "number") {
			site.frames = site.frames.filter(function (frame) { return frame.timing <= settled; });
		}
		return site;
	}

	/* --------------------------------------------------------------- the axis */

	/*
	 * One grid for every lane.
	 *
	 * Lighthouse samples each run on its own schedule, so two strips laid out
	 * frame by frame are not comparable — the site sampled every 900ms would look
	 * slower than the one sampled every 375ms for no reason but the sampling. The
	 * strips are placed on a single step instead.
	 *
	 * The step is the finest strip's own interval and nothing else. Frames are
	 * laid out in stride units of it, so widening it would pull them toward each
	 * other until they overlapped. The axis is as long as it needs to be instead,
	 * and scrolls.
	 */
	function buildTimeline(sites) {
		var end = 0;
		var step = Infinity;

		sites.forEach(function (s) {
			var frames = s.frames || [];
			if (frames.length) end = Math.max(end, frames[frames.length - 1].timing);
			for (var i = 1; i < frames.length; i++) {
				var gap = frames[i].timing - frames[i - 1].timing;
				if (gap > 0) step = Math.min(step, gap);
			}
		});

		if (!isFinite(step) || step <= 0) step = 250;
		if (!end) end = step * 4;

		var cols = Math.max(1, Math.ceil(end / step));
		return { step: step, cols: cols, end: cols * step };
	}

	/*
	 * The last frame at or before `t`, as stored, or null where this strip has
	 * nothing to say about `t`.
	 *
	 * Lighthouse times its thumbnails from navigation start, so the stored
	 * timings need no correction to sit on this axis. A strip stops where its
	 * capture stops rather than holding its last frame across a longer axis.
	 *
	 * One column past the strip's end, not zero: a strip's last frame almost
	 * never lands on a column boundary, and cutting at `t > last` dropped the
	 * finished page whenever it fell between two columns.
	 */
	function frameAt(site, t, step) {
		var frames = site.frames || [];
		if (!frames.length) return null;

		var last = frames[frames.length - 1].timing;
		if (t - step >= last) return null;

		var hit = null;
		for (var i = 0; i < frames.length; i++) {
			if (frames[i].timing > t) break;
			hit = frames[i];
		}
		return hit;
	}

	/*
	 * Tick intervals worth reading a clock against, coarsest last — the same
	 * numbers a clock has, rather than Lighthouse's own sampling interval.
	 */
	var TICK_STEPS = [100, 250, 500, 1000, 2000, 2500, 5000, 10000, 15000, 30000];
	var MAX_TICKS = 12;

	/* Never finer than the frames it is measuring: the tick is the coarsest of
	   the grid's own cadence and whatever keeps the count readable. */
	function tickStep(end, step) {
		for (var i = 0; i < TICK_STEPS.length; i++) {
			if (TICK_STEPS[i] < step) continue;
			if (end / TICK_STEPS[i] <= MAX_TICKS) return TICK_STEPS[i];
		}
		return TICK_STEPS[TICK_STEPS.length - 1];
	}

	/* Ticks at round times, positioned as a fraction of the column stride. */
	function renderRuler(timeline) {
		var ruler = el("div", "race-ruler");
		var step = tickStep(timeline.end, timeline.step);

		for (var at = step; at <= timeline.end; at += step) {
			var tick = el("span", "race-tick");
			tick.style.setProperty("--at", at / timeline.step);
			tick.textContent = fmtMs(at);
			ruler.appendChild(tick);
		}
		return ruler;
	}

	/*
	 * Pixels per column step, measured rather than recomputed.
	 *
	 * Taken off the ruler, which is exactly `stride × cols` wide: reading the
	 * custom property back gives an unresolved `calc()` in some browsers.
	 */
	function strideWidth(grid, timeline) {
		var ruler = grid.querySelector(".race-ruler");
		if (!ruler || !timeline || !timeline.cols) return 0;
		return ruler.getBoundingClientRect().width / timeline.cols;
	}

	/*
	 * Put each flag on the highest row where its label clears the one before it.
	 *
	 * Measured rather than estimated: a label's width is pixels and the gap
	 * between two flags is time, and the exchange rate between them — the column
	 * stride — changes with the lane count and the viewport.
	 */
	function packRows(built, timeline, stride) {
		stride = stride || 90;
		/* Right edge of the last label on each row. */
		var edges = [];
		var used = 1;

		built.forEach(function (flag) {
			var x = (flag.at / timeline.step) * stride;
			var width = flag.label.offsetWidth || 120;
			var row = 0;

			while (edges[row] !== undefined && x < edges[row]) row += 1;

			/* A few pixels of daylight, so two labels never sit edge to edge. */
			edges[row] = x + width + 6;
			flag.label.style.setProperty("--row", row);
			if (flag.el) flag.el.style.setProperty("--row", row);
			used = Math.max(used, row + 1);
		});

		return used;
	}

	/* ------------------------------------------------------------- the lanes */

	// Observed TTFB, FCP and LCP from the pass that took the frames; metrics that coincide share a flag.
	function renderMarkers(site, cell, timeline) {
		var markers = site.markers || {};
		var byTime = [];
		[["ttfb", "TTFB"], ["fcp", "FCP"], ["lcp", "LCP"]].forEach(function (pair) {
			var at = markers[pair[0]];
			if (typeof at !== "number" || at > timeline.end) return;
			var same = byTime.filter(function (m) { return m.at === at; })[0];
			if (same) same.names.push(pair[1]);
			else byTime.push({ at: at, names: [pair[1]] });
		});
		byTime.sort(function (a, b) { return a.at - b.at; });

		return byTime.map(function (item) {
			var marker = el("div", "race-flagpost is-metric");
			marker.style.setProperty("--at", item.at / timeline.step);
			marker.appendChild(el("i", "race-flagpost-pole"));
			var label = el("span", "race-flagpost-label");
			label.style.setProperty("--row", 0);
			label.textContent = item.names.join(" · ") + " " + fmtSeconds(item.at);
			label.title = "Observed in this throttled capture, not the site's scored runs";
			marker.appendChild(label);
			cell.appendChild(marker);
			return { el: marker, time: item.at, at: item.at, label: label };
		});
	}

	// Stacks a lane's metric flags and leaves room above the frames for them.
	function packMarkers(lane, cell, timeline, stride) {
		if (!lane.markers || !lane.markers.length) return;
		cell.classList.add("has-metrics");
		cell.style.setProperty("--metric-rows", packRows(lane.markers, timeline, stride));
	}

	/*
	 * When the space between two frames is drawn as unphotographed: any time they
	 * are more than one sample apart. The epsilon is for the lane that set the
	 * step, whose ratio is 1 by construction and must not round into a band.
	 */
	var WAITING_GAP = 1 + 1e-9;

	/*
	 * A lane: every frame at the moment it was taken, and one live frame that
	 * rides the clock.
	 *
	 * Frames are placed by their own timing rather than dropped into columns, so
	 * the gaps between them are real: they are the stretches this strip has
	 * nothing to say about. The live frame moves continuously with the clock, and
	 * each time it passes a frame's own moment that frame is left behind at it.
	 */
	function renderLane(lane, timeline) {
		var cell = el("div", "race-lane");
		cell.style.setProperty("--lane", lane.index || 0);

		var frames = lane.site.frames || [];
		var settled = settledAt(lane.site);

		lane.gaps = [];

		/* Before the first sample. One band rather than a row of placeholders: the
		   whole stretch is a single fact — nothing was captured yet. */
		if (frames.length && frames[0].timing > 0) {
			var lead = el("div", "race-waiting is-lead");
			lead.style.setProperty("--from", 0);
			lead.style.setProperty("--to", frames[0].timing / timeline.step);
			lead.style.setProperty("--fill", 0);
			cell.appendChild(lead);
			lane.gaps.push({ el: lead, from: 0, to: frames[0].timing });
		}

		/*
		 * And between samples, wherever the strip skipped enough time to show it,
		 * tiled faintly with the frame that opened the gap: between two samples the
		 * page is not unknown, it is unobserved, and the last thing anyone saw is
		 * still the best account of it.
		 */
		for (var g = 1; g < frames.length; g++) {
			var from = frames[g - 1].timing;
			var to = frames[g].timing;
			if ((to - from) / timeline.step <= WAITING_GAP) continue;
			/* No band into a settled frame. */
			if (typeof settled === "number" && from >= settled) continue;

			var band = el("div", "race-waiting is-held");
			band.style.setProperty("--from", from / timeline.step);
			band.style.setProperty("--to", to / timeline.step);
			band.style.setProperty("--fill", from / timeline.step);
			band.style.setProperty("--held-src", "url(" + frames[g - 1].src + ")");
			band.title = "Not captured — the page as last seen, at " + fmtMs(from);
			cell.appendChild(band);
			lane.gaps.push({ el: band, from: from, to: to });
		}

		lane.cells = [];
		frames.forEach(function (frame) {
			var slot = el("div", "race-frame");
			slot.style.setProperty("--at", frame.timing / timeline.step);

			// The frame the lane finishes on.
			if (typeof settled === "number" && frame.timing === settled) {
				var flag = el("span", "race-frame-finish");
				flag.innerHTML = finishIcon();
				flag.title = "Finished — the page stopped changing here, at " + fmtSeconds(frame.timing);
				slot.appendChild(flag);
			}

			/* Past the settle, on strips that keep those frames: drawn faint, so the
			   eye stays on the part of the lane that was still changing. */
			if (typeof settled === "number" && frame.timing > settled) {
				slot.classList.add("is-settled");
			}

			var img = new Image();
			img.src = frame.src;
			img.alt = "";
			img.decoding = "async";
			slot.appendChild(img);

			/* When this one was taken, under it. */
			var stamp = el("span", "race-frame-time");
			stamp.textContent = fmtSeconds(frame.timing);
			slot.appendChild(stamp);

			cell.appendChild(slot);
			lane.cells.push({ el: slot, time: frame.timing });
		});

		/* The travelling frame, positioned by the clock rather than a timestamp. */
		if (frames.length) {
			lane.live = el("div", "race-frame race-live");
			lane.liveImg = new Image();
			lane.liveImg.alt = "";
			lane.liveImg.decoding = "async";
			lane.live.appendChild(lane.liveImg);
			cell.appendChild(lane.live);
		} else {
			lane.live = null;
			lane.liveImg = null;
		}

		lane.head = el("div", "race-playhead");
		cell.appendChild(lane.head);

		lane.markers = renderMarkers(lane.site, cell, timeline);

		return cell;
	}

	/* When a lane is over: its settle if it has one, otherwise its last sample. */
	function laneFinish(lane) {
		var settled = settledAt(lane.site);
		if (typeof settled === "number") return settled;
		var frames = lane.site.frames || [];
		return frames.length ? frames[frames.length - 1].timing : 0;
	}

	/*
	 * Carry the live frame to wherever the clock is.
	 *
	 * Shown from the moment the clock starts, with or without a picture in it:
	 * an empty outline moving down the track says the load has begun, it just has
	 * not been photographed yet. Past the end of the strip it steps aside.
	 */
	function moveLive(lane, now, timeline) {
		if (!lane.live) return;

		var frame = frameAt(lane.site, now, timeline.step);
		var gone = now > laneFinish(lane);

		lane.live.classList.toggle("is-on", now > 0 && !gone);
		if (gone || now <= 0) return;

		lane.live.classList.toggle("is-empty", !frame);
		if (frame && lane.liveImg.getAttribute("src") !== frame.src) lane.liveImg.src = frame.src;
		lane.live.style.setProperty("--at", now / timeline.step);
	}

	// Brings one lane's frames, gaps, flags, playhead and live frame to `now`.
	function updateLane(lane, now, timeline) {
		(lane.markers || []).forEach(function (marker) {
			marker.el.classList.toggle("is-on", now > 0 && marker.time <= now);
		});
		lane.cells.forEach(function (cell) {
			cell.el.classList.toggle("is-on", cell.time <= now);
		});
		/* A gap grows with the clock rather than appearing whole, which would
		   show the length of a wait before the wait had happened. */
		lane.gaps.forEach(function (gap) {
			var reached = Math.max(gap.from, Math.min(now, gap.to));
			gap.el.style.setProperty("--fill", reached / timeline.step);
			gap.el.classList.toggle("is-on", now > gap.from);
		});
		/* The line keeps the clock's position past the lane's finish, faded back:
		   still the time, no longer anything happening here. */
		lane.head.classList.toggle("is-on", now > 0);
		lane.head.classList.toggle("is-done", now > laneFinish(lane));
		lane.head.style.setProperty("--now", now / timeline.step);
		moveLive(lane, now, timeline);
	}

	function followPlayhead(scroll, grid, timeline, now) {
		var stride = strideWidth(grid, timeline);
		if (!stride) return;
		var x = (now / timeline.step) * stride;
		var target = x - scroll.clientWidth * 0.6;
		if (target > scroll.scrollLeft) scroll.scrollLeft = target;
	}

	window.FilmstripLanes = {
		el: el,
		fmtMs: fmtMs,
		fmtSeconds: fmtSeconds,
		fmtClock: fmtClock,
		settledAt: settledAt,
		trimToSettle: trimToSettle,
		buildTimeline: buildTimeline,
		renderRuler: renderRuler,
		strideWidth: strideWidth,
		packRows: packRows,
		packMarkers: packMarkers,
		renderLane: renderLane,
		laneFinish: laneFinish,
		updateLane: updateLane,
		followPlayhead: followPlayhead
	};
})();
