/**
 * Load a TypeScript module from a plain Node script.
 *
 * Node >= 23.6 strips types natively and can import `.ts` directly. Older
 * Node (22.x) cannot (`ERR_NO_TYPESCRIPT`) or does not know the extension at
 * all (`ERR_UNKNOWN_FILE_EXTENSION`), so fall back to `jiti` — the same
 * loader pi itself uses for extensions. jiti is resolved from pi's own
 * dependency tree so no extra dependency is needed.
 *
 * Shared by smoke-test.mjs and sandbox/e2e.mjs.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.dirname(fileURLToPath(import.meta.url));

let jiti;

function makeJiti() {
	if (jiti) return jiti;
	for (const candidate of [
		path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules/jiti"),
		"jiti",
	]) {
		try {
			const mod = require(candidate);
			const createJiti = mod.createJiti ?? mod.default?.createJiti;
			if (createJiti) {
				jiti = createJiti(repoRoot + path.sep);
				return jiti;
			}
		} catch {
			/* try the next candidate */
		}
	}
	throw new Error("could not load jiti (needed to import .ts on Node < 23.6)");
}

/** Import a `.ts` (or `.mjs`) module, by repo-relative or absolute path. */
export async function loadTs(relativeOrAbsolute) {
	const absolute = path.isAbsolute(relativeOrAbsolute)
		? relativeOrAbsolute
		: path.join(repoRoot, relativeOrAbsolute);
	try {
		return await import(absolute);
	} catch (err) {
		if (err?.code !== "ERR_UNKNOWN_FILE_EXTENSION" && err?.code !== "ERR_NO_TYPESCRIPT") throw err;
		return makeJiti()(absolute);
	}
}
