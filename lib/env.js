import fs from "node:fs";
import path from "node:path";

/**
 * Load `.env` into the environment, if there is one.
 *
 * Uses Node's built-in `process.loadEnvFile` (Node 20.12+), so this costs no
 * dependency. Two behaviors worth knowing, both of which are what you want:
 *
 *  - **Real environment variables win.** A value already set by the shell or by
 *    CI is not overwritten by the file. That is what keeps a stray local `.env`
 *    from shadowing a `CRUX_API_KEY` secret in GitHub Actions.
 *  - **A missing file is not an error.** `.env` is optional and gitignored;
 *    every variable it can set has a working default.
 *
 * Imported for its side effect by the two entry points — `bin/speedlify.js` and
 * `eleventy.config.js` — and it must be their FIRST import, so the file is
 * loaded before any module reads `process.env` while being evaluated.
 */

let loaded = false;

export function loadEnv(file = process.env.SPEEDLIFY_ENV_FILE || ".env") {
	if (loaded) return { loaded: false, reason: "already-loaded" };
	loaded = true;

	const abs = path.resolve(file);
	if (!fs.existsSync(abs)) return { loaded: false, reason: "not-found", file: abs };

	try {
		process.loadEnvFile(abs);
		return { loaded: true, file: abs };
	} catch (err) {
		// A malformed .env shouldn't take down a measurement run, but silently
		// ignoring it would be worse — the symptom would be a missing API key
		// with no explanation.
		process.stderr.write(`Warning: could not read ${file} — ${err.message}\n`);
		return { loaded: false, reason: "unreadable", file: abs, error: err.message };
	}
}

/** Reset for tests; the real process only ever loads once. */
export function resetForTests() {
	loaded = false;
}

loadEnv();
