/**
 * pi's built-in tool operations, executed inside the sandbox.
 *
 * Each factory returns an implementation of pi's pluggable `*Operations`
 * interface (see pi's docs/extensions.md -> "Remote Execution"). Passing one
 * to `createXToolDefinition(cwd, { operations })` replaces the *execution* of
 * that tool while keeping its schema, description, prompt snippet/guidelines
 * and renderer inherited from the built-in — which is what keeps this
 * extension free of prompt cost.
 *
 * Two properties of the sbx backend shape everything here:
 *
 * 1. **Paths are identical inside and outside.** The workspace is mounted in
 *    the sandbox at its host absolute path, so there is no /workspace
 *    translation: an absolute host path is a valid sandbox path. Ops just
 *    pass paths through.
 *
 * 2. **argv is the only reliable channel.** stdin forwarding through
 *    `sbx exec` is not guaranteed, and stdout is captured as text, so binary
 *    file contents move as base64 in argv (chunked) rather than raw bytes.
 *
 * Paths and content are always passed as POSITIONAL arguments to `sh -c`
 * (never spliced into the script text), so a path or file body can never be
 * reinterpreted as shell syntax or as an option.
 */

import path from "node:path";
import {
	DEFAULT_MAX_BYTES,
	type GrepToolDetails,
	type GrepToolInput,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import type {
	BashOperations,
	EditOperations,
	FindOperations,
	LsOperations,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { chunkFiles, readManyBytes } from "./batch-read.ts";
import { SandboxUnavailableError, isSandboxUnavailableFailure } from "./failure.ts";
import { type ExecOptions, type ExecOutcome, type ExecTransport, shArgs, shQuote } from "./transport.ts";

/** Files larger than this would exceed a comfortable argv budget when base64'd. */
const MAX_WRITE_BYTES = 64 * 1024 * 1024;
/** base64 characters per argv chunk (~288KB of file per call). */
const WRITE_CHUNK = 384 * 1024;
/** Default cap for a single sandbox round-trip, so a wedged CLI cannot hang a turn. */
const DEFAULT_OP_TIMEOUT = 120;
const DEFAULT_GREP_LIMIT = 100;

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
};

function errText(r: ExecOutcome, fallback: string): string {
	const text = `${r.stdout.toString("utf8")}\n${r.stderr.toString("utf8")}`.trim();
	return text || fallback;
}

/**
 * Run a sandbox command with a bounded timeout.
 *
 * NOTE: the `*Operations` interfaces other than BashOperations do not receive
 * a caller `AbortSignal` (see pi's tool.d.ts), so the best available
 * protection against a wedged `sbx exec` is a timeout rather than true
 * cancellation. Bash — which *does* get a signal — is wired for real aborts.
 */
function opOpts(extra?: ExecOptions): ExecOptions {
	return { timeout: DEFAULT_OP_TIMEOUT, ...extra };
}

/**
 * Throw if this outcome means the sandbox runtime itself failed to start.
 *
 * A non-zero exit from `sbx exec` is ambiguous: it is the inner command's
 * status when the VM was reachable, and the CLI's own failure when it was not.
 * This is the one place that ambiguity is resolved, so no call site below can
 * mistake "the whole sandbox is down" for "this file does not exist".
 *
 * The parameter is structural rather than the full `ExecOutcome` so a batched
 * read's outcome (see `batch-read.ts`) can be checked by the same rule.
 */
function throwIfSandboxUnavailable(t: ExecTransport, r: { exitCode: number | null; stderr?: Uint8Array | string }): void {
	if (!isSandboxUnavailableFailure(r)) return;
	const stderr =
		r.stderr === undefined || typeof r.stderr === "string" ? (r.stderr ?? "") : Buffer.from(r.stderr).toString("utf8");
	throw new SandboxUnavailableError(t.target, stderr);
}

async function must(t: ExecTransport, argv: string[], fallback: string, opts?: ExecOptions): Promise<ExecOutcome> {
	const r = await t.exec(argv, opOpts(opts));
	throwIfSandboxUnavailable(t, r);
	if (r.exitCode !== 0) throw new Error(errText(r, fallback));
	return r;
}

/**
 * "Did this probe exit 0?" for the `test -e` / `test -r` style primitives.
 *
 * A transport-level rejection (spawn failure, abort, timeout) is still reported
 * as `false` — that is what this helper is for. A sandbox-runtime failure is
 * NOT: it propagates, so callers cannot silently turn a dead VM into "this path
 * does not exist".
 */
async function ok(t: ExecTransport, argv: string[]): Promise<boolean> {
	let r: ExecOutcome;
	try {
		r = await t.exec(argv, opOpts());
	} catch {
		return false;
	}
	throwIfSandboxUnavailable(t, r);
	return r.exitCode === 0;
}

/* ------------------------------------------------------------------ */
/* file primitives (shared by the read/write/edit/ls/grep ops)         */
/* ------------------------------------------------------------------ */

async function readBytes(t: ExecTransport, filePath: string): Promise<Buffer> {
	// `< file` avoids option parsing of the path entirely; `tr -d '\n'` makes the
	// decode independent of the base64 line-wrapping default (GNU -w0 is not
	// universal).
	const r = await must(t, shArgs("base64 < \"$1\" | tr -d '\\n'", filePath), `read failed: ${filePath}`);
	return Buffer.from(r.stdout.toString("utf8").replace(/\s+/g, ""), "base64");
}

async function writeBytes(t: ExecTransport, filePath: string, data: Buffer): Promise<void> {
	if (data.byteLength > MAX_WRITE_BYTES) {
		throw new Error(`write: ${filePath} is ${data.byteLength} bytes (max ${MAX_WRITE_BYTES})`);
	}
	const b64 = data.toString("base64");
	const parts: string[] = [];
	for (let i = 0; i < b64.length; i += WRITE_CHUNK) parts.push(b64.slice(i, i + WRITE_CHUNK));
	if (parts.length === 0) parts.push("");

	for (let index = 0; index < parts.length; index++) {
		// First chunk truncates, the rest append — one file, many argv-sized calls.
		const script = index === 0 ? 'printf %s "$1" | base64 -d > "$2"' : 'printf %s "$1" | base64 -d >> "$2"';
		await must(t, shArgs(script, parts[index], filePath), `write failed: ${filePath}`);
	}
}

const exists = (t: ExecTransport, p: string) => ok(t, shArgs('test -e "$1"', p));
const isDirectory = (t: ExecTransport, p: string) => ok(t, shArgs('test -d "$1"', p));
const isReadable = (t: ExecTransport, p: string) => ok(t, shArgs('test -r "$1"', p));
const isWritable = (t: ExecTransport, p: string) => ok(t, shArgs('test -w "$1"', p));

async function listDirEntries(t: ExecTransport, dir: string): Promise<Map<string, boolean>> {
	// One POSIX-sh pass returns name + isDirectory for every entry, so a full
	// listing costs a single round-trip instead of one per entry. (POSIX sh
	// rather than `find -printf`, which busybox lacks.) The `-d` guard makes a
	// non-directory an error rather than an empty listing, so callers can trust
	// a successful result to mean "this really is a directory".
	const script = [
		'[ -d "$1" ] || exit 3',
		'for f in "$1"/* "$1"/.[!.]* "$1"/..?*; do',
		'  [ -e "$f" ] || [ -L "$f" ] || continue',
		"  if [ -d \"$f\" ]; then printf 'd %s\\n' \"${f##*/}\"; else printf 'f %s\\n' \"${f##*/}\"; fi",
		"done",
	].join("\n");
	const r = await must(t, shArgs(script, dir), `readdir failed: ${dir}`);
	const entries = new Map<string, boolean>();
	for (const line of r.stdout.toString("utf8").split("\n")) {
		if (line.length < 3 || line[1] !== " ") continue;
		entries.set(line.slice(2), line[0] === "d");
	}
	return entries;
}

/* ------------------------------------------------------------------ */
/* operations factories                                                */
/* ------------------------------------------------------------------ */

export function createReadOps(t: ExecTransport): ReadOperations {
	return {
		readFile: (filePath) => readBytes(t, filePath),
		access: async (filePath) => {
			if (!(await isReadable(t, filePath))) throw new Error(`not readable: ${filePath}`);
		},
		detectImageMimeType: async (filePath) => IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? null,
	};
}

export function createWriteOps(t: ExecTransport): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			await writeBytes(t, filePath, Buffer.from(content, "utf8"));
		},
		mkdir: async (dirPath) => {
			await must(t, shArgs('mkdir -p -- "$1"', dirPath), `mkdir failed: ${dirPath}`);
		},
	};
}

export function createEditOps(t: ExecTransport): EditOperations {
	const read = createReadOps(t);
	const write = createWriteOps(t);
	return {
		readFile: read.readFile,
		writeFile: write.writeFile,
		access: async (filePath) => {
			if (!(await isReadable(t, filePath)) || !(await isWritable(t, filePath))) {
				throw new Error(`not readable/writable: ${filePath}`);
			}
		},
	};
}

export function createLsOps(t: ExecTransport): LsOperations {
	// The ls tool asks for exists(), stat(dir), readdir(dir) and then stat() for
	// EVERY entry. Served naively over `sbx exec` that is N+3 sandbox
	// round-trips per listing; one directory listing + memoisation collapses it
	// to ~3. The cache lives on this ops object, which the extension builds per
	// tool execution, so it can never serve a stale listing across calls.
	const listings = new Map<string, Promise<Map<string, boolean>>>();
	const known = new Map<string, boolean>();

	function listing(dir: string): Promise<Map<string, boolean>> {
		let hit = listings.get(dir);
		if (!hit) {
			hit = listDirEntries(t, dir);
			listings.set(dir, hit);
		}
		return hit;
	}

	return {
		exists: (p) => exists(t, p),
		stat: async (p) => {
			// 1) already resolved, 2) a cached listing of the parent, 3) one probe.
			// The parent listing is only consulted if it is already in hand —
			// enumerating the parent just to answer a stat() can be far more
			// expensive than a single `test -d`.
			const knownHit = known.get(p);
			if (knownHit !== undefined) return { isDirectory: () => knownHit };
			const cached = listings.get(path.dirname(p));
			if (cached) {
				// A failed parent listing is normally "not there / unreadable", which
				// just means "fall through to a direct probe". A sandbox-runtime
				// failure is not that, and must not be swallowed.
				const entries = await cached.catch((err) => {
					if (err instanceof SandboxUnavailableError) throw err;
					return undefined;
				});
				const hit = entries?.get(path.basename(p));
				if (hit !== undefined) {
					known.set(p, hit);
					return { isDirectory: () => hit };
				}
			}
			const dir = await isDirectory(t, p);
			known.set(p, dir);
			return { isDirectory: () => dir };
		},
		readdir: async (p) => {
			const entries = await listing(p);
			known.set(p, true);
			return [...entries.keys()];
		},
	};
}

/**
 * Files under `root` that a search should consider, using git's own index when
 * it is available: `--cached --others --exclude-standard` is exactly "tracked
 * plus untracked-but-not-ignored", so `.gitignore` is honoured precisely (as
 * the built-in grep/find descriptions promise) instead of by a hand-rolled
 * approximation. Returns null when git is missing or the path is not a repo,
 * so the caller can fall back to a pruned walk.
 *
 * `safe.directory=*` is required in practice: the workspace is a mount whose
 * owner need not match the sandbox user, and git otherwise refuses with
 * "detected dubious ownership". Only a read-only index query runs here - no
 * hook, filter or any other repo-provided code is executed.
 */
async function gitSearchableFiles(t: ExecTransport, root: string): Promise<string[] | null> {
	try {
		const r = await t.exec(
			shArgs('git -c safe.directory=\'*\' -C "$1" ls-files -z --cached --others --exclude-standard', root),
			opOpts(),
		);
		// Not a repo / git missing: fall back to the walk. A dead sandbox: throw.
		throwIfSandboxUnavailable(t, r);
		if (r.exitCode !== 0) return null;
		const files: string[] = [];
		for (const relative of r.stdout.toString("utf8").split("\0")) {
			if (relative) files.push(path.join(root, relative));
		}
		return files;
	} catch (err) {
		if (err instanceof SandboxUnavailableError) throw err;
		return null;
	}
}

/** Pruned-walk fallback for search enumeration when git is unavailable. */
async function walkSearchableFiles(t: ExecTransport, root: string): Promise<string[]> {
	const files: string[] = [];
	await walkFiles(t, root, "", async (absolute) => {
		files.push(absolute);
		return true;
	});
	return files;
}

/** Glob matching identical in spirit to the tool's: basename unless the pattern has a slash. */
function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const posix = relativePath.split(path.sep).join("/");
	const norm = pattern.split(path.sep).join("/");
	if (norm.includes("/")) {
		return path.posix.matchesGlob(posix, norm) || path.posix.matchesGlob(posix, `**/${norm}`);
	}
	return path.posix.matchesGlob(path.posix.basename(posix), norm);
}

export function createFindOps(t: ExecTransport): FindOperations {
	return {
		exists: (p) => exists(t, p),
		glob: async (pattern, cwd, options) => {
			// Enumerate in the sandbox, match host-side: pattern semantics (basename
			// vs full path, ignore list, limit) stay under our control instead of
			// depending on the sandbox's fd/glob dialect. Enumeration via git means
			// `.gitignore` is honoured exactly and build output (`dist/`, `.next/`,
			// coverage) correctly stays out of results.
			const candidates = (await gitSearchableFiles(t, cwd)) ?? (await walkSearchableFiles(t, cwd));
			const results: string[] = [];
			for (const absolute of candidates) {
				if (results.length >= options.limit) break;
				const relative = path.relative(cwd, absolute);
				if (!relative || relative.startsWith("..")) continue;
				if (options.ignore.some((ignored) => matchesToolGlob(relative, ignored))) continue;
				if (matchesToolGlob(relative, pattern)) results.push(absolute);
			}
			return results;
		},
	};
}

function makeMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
	return (line: string) => regex.test(line);
}

/** Recursively visit files under `dir`, skipping VCS/build directories. */
async function walkFiles(
	t: ExecTransport,
	dir: string,
	relDir: string,
	visit: (absolute: string, relative: string) => Promise<boolean>,
): Promise<boolean> {
	let entries: Map<string, boolean>;
	try {
		entries = await listDirEntries(t, dir);
	} catch (err) {
		if (err instanceof SandboxUnavailableError) throw err;
		return true; // unreadable subtree: skip, like the built-in does
	}
	for (const [name, isDir] of entries) {
		if (name === ".git" || name === "node_modules") continue;
		const absolute = path.join(dir, name);
		const relative = relDir ? `${relDir}/${name}` : name;
		if (isDir) {
			if (!(await walkFiles(t, absolute, relative, visit))) return false;
		} else if (!(await visit(absolute, relative))) {
			return false;
		}
	}
	return true;
}

/**
 * grep implemented entirely over the transport, so matching happens against
 * sandbox content (pi's own grep tool would run host ripgrep).
 */
export async function executeSandboxGrep(
	t: ExecTransport,
	cwd: string,
	params: GrepToolInput,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: GrepToolDetails | undefined }> {
	const root = params.path ? path.resolve(cwd, params.path) : cwd;
	if (!(await exists(t, root))) throw new Error(`Path not found: ${params.path ?? root}`);
	const rootIsDir = await isDirectory(t, root);
	const matcher = makeMatcher(params.pattern, params.literal, params.ignoreCase);
	const contextLines = params.context && params.context > 0 ? params.context : 0;
	const limit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const output: string[] = [];
	let matchCount = 0;
	let limitReached = false;
	let linesTruncated = false;

	// Match one file's already-buffered content and emit its lines. Split out from
	// the enumeration so the SAME logic runs whether a file arrived via a batched
	// read or a single one — the batching must not change a single output byte.
	const matchContent = (display: string, content: string): boolean => {
		const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

		// Collect this file's matches first, so a line that is itself a match is
		// always rendered as a match even when it also falls inside a
		// neighbouring match's context window.
		const budget = Math.max(1, limit - matchCount);
		const matches: number[] = [];
		for (let index = 0; index < lines.length; index++) {
			if (!matcher(lines[index] ?? "")) continue;
			matches.push(index);
			if (matches.length >= budget) {
				limitReached = true;
				break;
			}
		}
		if (matches.length === 0) return true;
		matchCount += matches.length;

		// Coalesce overlapping context windows (like ripgrep): every line is
		// emitted exactly once, as a match line or as a context line.
		const matchSet = new Set(matches);
		let cursor = 0;
		for (const index of matches) {
			const start = contextLines > 0 ? Math.max(0, index - contextLines) : index;
			const end = contextLines > 0 ? Math.min(lines.length - 1, index + contextLines) : index;
			for (let line = Math.max(start, cursor); line <= end; line++) {
				const trimmed = truncateLine((lines[line] ?? "").replace(/\r/g, ""));
				if (trimmed.wasTruncated) linesTruncated = true;
				const separator = matchSet.has(line) ? ":" : "-";
				output.push(`${display}${separator}${line + 1}${separator} ${trimmed.text}`);
			}
			cursor = end + 1;
		}
		return !limitReached;
	};

	// Enumerate candidates first, applying the glob BEFORE any read (so a
	// non-matching file is never fetched), then read them in bounded chunks:
	// one `sbx exec` per chunk instead of one per file. Order is the enumeration
	// order, so the emitted lines are byte-identical to the per-file path.
	const candidates: Array<{ absolute: string; display: string }> = [];
	if (!rootIsDir) {
		const display = path.basename(root);
		if (!params.glob || matchesToolGlob(display, params.glob)) candidates.push({ absolute: root, display });
	} else {
		// git enumeration honours .gitignore exactly (as this tool's description
		// promises); a pruned walk is the fallback when git is unavailable.
		const files = (await gitSearchableFiles(t, root)) ?? (await walkSearchableFiles(t, root));
		for (const absolute of files) {
			const display = path.relative(root, absolute).split(path.sep).join("/");
			if (params.glob && !matchesToolGlob(display, params.glob)) continue;
			candidates.push({ absolute, display });
		}
	}

	const displayByPath = new Map(candidates.map(({ absolute, display }) => [absolute, display]));
	for (const chunk of chunkFiles(candidates.map(({ absolute }) => absolute))) {
		if (limitReached) break; // later chunks cannot contribute
		let contents: Map<string, Buffer>;
		try {
			contents = await readManyBytes(t, chunk, {
				timeout: DEFAULT_OP_TIMEOUT,
				// A dead sandbox must not be mistaken for "these files are unreadable":
				// surface it. Only ordinary read failures are skipped (absent from the
				// map), exactly like the per-file catch-and-continue this replaced.
				onChunkFailure: (outcome) => throwIfSandboxUnavailable(t, outcome),
			});
		} catch (err) {
			if (err instanceof SandboxUnavailableError) throw err;
			continue; // transport hiccup: the whole chunk is unreadable, as one file was before
		}
		for (const absolute of chunk) {
			const content = contents.get(absolute);
			if (content === undefined) continue; // binary/unreadable file
			if (!matchContent(displayByPath.get(absolute) ?? absolute, content.toString("utf8"))) break;
		}
	}

	if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	let text = truncation.content;

	if (limitReached) {
		details.matchLimitReached = limit;
		notices.push(`${limit} matches limit reached`);
	}
	if (linesTruncated) {
		details.linesTruncated = true;
		notices.push("long lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${DEFAULT_MAX_BYTES} limit reached`);
	}
	if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;

	return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
}

/* ------------------------------------------------------------------ */
/* bash                                                                */
/* ------------------------------------------------------------------ */

export interface BashOpsOptions {
	/**
	 * Which environment variable names may be exported into the sandbox shell.
	 *
	 * SECURITY: pi's built-in `bash` tool builds the child env from the FULL
	 * host environment (`getShellEnv()`), so exporting `env` verbatim would
	 * push host API keys and tokens into the sandbox — readable by anything
	 * running there. Default is therefore "session metadata only" (`PI_*`),
	 * matching the extension's secure-by-default env policy.
	 */
	allowEnv?: (name: string) => boolean;
}

const PI_SESSION_ENV = (name: string) => name.startsWith("PI_");

/** Export lines for the (filtered) session env pi injects. */
function exportLines(env: NodeJS.ProcessEnv | undefined, allow: (name: string) => boolean): string {
	if (!env) return "";
	const lines: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (typeof value !== "string") continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		// Docker-affecting vars are never exported, in any mode.
		if (key === "DOCKER_HOST" || key === "DOCKER_CONTEXT" || key.startsWith("DOCKER_") || key.startsWith("COMPOSE_")) continue;
		if (!allow(key)) continue;
		lines.push(`export ${key}=${shQuote(value)}`);
	}
	return lines.join("\n");
}

export function createBashOps(t: ExecTransport, options: BashOpsOptions = {}): BashOperations {
	const allow = options.allowEnv ?? PI_SESSION_ENV;
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			// cd + env + command are joined into ONE script string; the whole
			// string is a single argv entry, so nothing here is re-split.
			const script = [`cd ${shQuote(cwd)} || exit 1`, exportLines(env, allow), command]
				.filter(Boolean)
				.join("\n");
			const r = await t.exec(["sh", "-lc", script], { onData, signal, timeout });
			// A non-zero exit here is usually the command's OWN status (grep found
			// nothing, a test failed, `false`) and must stay an exit code. But when
			// the signature says the VM never started, the command did not run at
			// all — surface that instead of a bogus status, so the caller can
			// invalidate the transport. bash is the most common way to hit a dead
			// sandbox, so it must not be the one path that never recovers.
			throwIfSandboxUnavailable(t, r);
			return { exitCode: r.exitCode };
		},
	};
}
