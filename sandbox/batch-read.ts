/**
 * Batched file reads over the transport.
 *
 * Every `sbx exec` is a round-trip, and measured tool latency is ≈0.5 s per
 * round-trip. Reading files one exec at a time is therefore the dominant cost
 * of the reimplemented `grep`: it does `exists` + `isDirectory` +
 * `git ls-files` + ONE read per candidate file, so a grep over ~170 files cost
 * ~170 round-trips — the measured p90 of 86.5 s matches that almost exactly.
 *
 * This module collapses those reads into one exec per *chunk* of files, with the
 * chunk bounds chosen so the generated argv stays far below `ARG_MAX`. The
 * matching logic in `operations.ts` is untouched: it runs over the buffered
 * contents, in the original candidate order, exactly as it did per file.
 *
 * ## Framing
 *
 * Per readable file the remote loop emits `<path>\0<base64(body)>\0`. NUL is
 * the delimiter — never a newline — for two reasons:
 *
 *  - paths returned by `git ls-files -z` may legitimately CONTAIN newlines, so a
 *    line-delimited protocol would split one path into two records, and
 *  - base64 never contains NUL, so `<path>\0<b64>\0` records are unambiguous
 *    regardless of what bytes a path holds.
 *
 * A file the remote loop cannot read emits NO record. The caller treats "absent
 * from the map" as "skip", which is exactly the catch-and-continue behaviour the
 * per-file path had — a binary or permission-denied file contributes nothing
 * rather than failing the whole grep.
 *
 * Zero imports (not even node builtins beyond the `Buffer` global): the argv
 * builder, chunker, parser and `readManyBytes` are all unit-testable without the
 * pi packages. `shArgs`'s convention (values passed POSITIONALLY, never spliced
 * into script text) is replicated here rather than imported, because importing
 * `transport.ts` would pull in the pi packages and make this module untestable.
 */

/** The subset of an `ExecOutcome` the batched read needs. */
export interface BatchReadOutcome {
	/** null when the process was killed by a signal (our own abort/timeout). */
	exitCode: number | null;
	stdout?: Uint8Array | string;
	stderr?: Uint8Array | string;
}

/** The subset of `ExecTransport` the batched read needs. */
export interface BatchReadTransport {
	exec(
		argv: string[],
		opts?: { timeout?: number; signal?: AbortSignal; onData?: (chunk: Uint8Array) => void },
	): Promise<BatchReadOutcome>;
}

/** At most this many paths per exec (count bound). */
export const READ_MANY_MAX_FILES = 256;
/** At most this many bytes of path per exec (size bound), keeping argv well under ARG_MAX. */
export const READ_MANY_MAX_PATH_BYTES = 96 * 1024;

/**
 * Emit `<path>\0<base64>\0` for each readable argument, skipping unreadable ones.
 *
 * POSIX sh only, and the file list is passed positionally (`"$@"`) — the same
 * convention as `shArgs`, so a path can never be reinterpreted as shell syntax
 * or as an option. `tr -d "\n"` makes the base64 independent of the line-wrap
 * default (GNU `-w0` is not universal).
 */
const READ_MANY_SCRIPT = [
	'for f in "$@"; do',
	'  [ -r "$f" ] || continue',
	'  printf "%s\\0" "$f"',
	'  base64 < "$f" | tr -d "\\n"',
	'  printf "\\0"',
	"done",
].join("\n");

/** Build `sh -c <script> sbx-ops <files…>` for one chunk of files. */
export function buildReadManyArgv(files: readonly string[]): string[] {
	return ["sh", "-c", READ_MANY_SCRIPT, "sbx-ops", ...files];
}

/**
 * Split `files` into chunks bounded by BOTH count and total path bytes.
 *
 * Two bounds because they fail differently: a few enormous paths could exceed
 * ARG_MAX on their own, and many short paths would exceed it by count. A single
 * path larger than the byte budget still gets its own chunk — an unsplittable
 * value must not be dropped. Pure, so the bounds are unit-tested directly.
 */
export function chunkFiles(
	files: readonly string[],
	maxFiles: number = READ_MANY_MAX_FILES,
	maxPathBytes: number = READ_MANY_MAX_PATH_BYTES,
): string[][] {
	const chunks: string[][] = [];
	let current: string[] = [];
	let bytes = 0;
	for (const file of files) {
		// +1 accounts for the NUL separator each path costs in the framing.
		const size = Buffer.byteLength(file, "utf8") + 1;
		if (current.length > 0 && (current.length >= maxFiles || bytes + size > maxPathBytes)) {
			chunks.push(current);
			current = [];
			bytes = 0;
		}
		current.push(file);
		bytes += size;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/** Split a byte run on NUL, keeping empty fields (an empty file's body is empty). */
function splitNul(data: Uint8Array): Uint8Array[] {
	const fields: Uint8Array[] = [];
	let start = 0;
	for (let i = 0; i < data.length; i++) {
		if (data[i] !== 0) continue;
		fields.push(data.subarray(start, i));
		start = i + 1;
	}
	// A trailing partial record (no closing NUL) is malformed; dropping it is
	// safer than pairing it with the next field and inventing a path.
	return fields;
}

/**
 * Parse one exec's stdout back into `path -> bytes`.
 *
 * Records are `<path>\0<base64>\0` pairs in the order the files were passed.
 * A file with no record (unreadable on the remote side) is simply absent from
 * the map. Unknown/duplicate paths cannot occur — the caller builds the list.
 */
export function parseReadManyOutput(stdout: Uint8Array | string): Map<string, Buffer> {
	const data = typeof stdout === "string" ? Buffer.from(stdout, "utf8") : stdout;
	const fields = splitNul(data);
	const records = new Map<string, Buffer>();
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const name = Buffer.from(fields[i]).toString("utf8");
		if (!name) continue;
		const body = Buffer.from(fields[i + 1]).toString("ascii").replace(/\s+/g, "");
		records.set(name, Buffer.from(body, "base64"));
	}
	return records;
}

export interface ReadManyOptions {
	/** Count/size bounds — see `chunkFiles`. */
	maxFiles?: number;
	maxPathBytes?: number;
	/** Per-exec timeout in SECONDS (matches pi's BashOperations contract). */
	timeout?: number;
	/**
	 * Called with a non-zero chunk outcome. The batch script itself exits 0 even
	 * when individual files are unreadable, so a non-zero exit means a shell or
	 * transport failure. If this callback returns, the chunk is treated as
	 * "nothing readable" and skipped; if it throws — which is how a dead sandbox
	 * must be surfaced — the throw propagates.
	 */
	onChunkFailure?: (outcome: BatchReadOutcome) => void;
}

/**
 * Read `files` in bounded chunks, one exec per chunk, returning `path -> bytes`.
 *
 * Files that could not be read (or whose chunk failed) are absent from the map;
 * callers skip them. The map preserves no ordering — the caller iterates its own
 * candidate list and looks each path up, which also keeps the original order.
 */
export async function readManyBytes(
	t: BatchReadTransport,
	files: readonly string[],
	options: ReadManyOptions = {},
): Promise<Map<string, Buffer>> {
	const out = new Map<string, Buffer>();
	for (const chunk of chunkFiles(files, options.maxFiles, options.maxPathBytes)) {
		const outcome = await t.exec(buildReadManyArgv(chunk), { timeout: options.timeout });
		if (outcome.exitCode !== 0) {
			options.onChunkFailure?.(outcome);
			continue;
		}
		for (const [name, body] of parseReadManyOutput(outcome.stdout ?? new Uint8Array())) out.set(name, body);
	}
	return out;
}
