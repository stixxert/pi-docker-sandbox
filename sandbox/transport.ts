/**
 * Exec transport for the sbx execution backend.
 *
 * A transport is "run a command in an isolated Linux environment and stream
 * its output". Two backends implement it:
 *
 *   - `sbx`    — Docker Sandboxes (`sbx exec <sandbox> -- ...`). The product
 *                path: what makes pi run *against a sandbox* instead of
 *                inside one.
 *   - `docker` — a plain container (`docker exec <container> -- ...`). Useful
 *                on Linux hosts, and it is what lets the ops layer be tested
 *                end-to-end in environments where `sbx` cannot run at all
 *                (sbx needs a host hypervisor; it cannot nest).
 *
 * Both backends have the identical `exec <target> -- argv...` shape, so a
 * single implementation is parameterised by (binary, target).
 *
 * Nothing here ever touches a host docker daemon through a socket: the `sbx`
 * backend shells out to the `sbx` CLI only, and the `docker` backend is
 * opt-in and explicit.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSandbox, findSbxCli, runSbxCli, scrubbedEnv } from "../index.ts";
import { isRuntimeNeverStarted } from "./failure.ts";
import { createRetryingExec } from "./exec-retry.ts";

/* ------------------------------------------------------------------ */
/* project-scoped sandbox naming                                       */
/* ------------------------------------------------------------------ */

/** Same shape the kernel accepts for DOCKER_SANDBOX names. */
function sanitizeName(value: string): string {
	return value
		.replace(/[^A-Za-z0-9._+-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

/** Nearest ancestor containing a VCS root — the same "what is this project?" rule sbxpi uses. */
function findProjectRoot(startDir: string): string {
	let dir = startDir;
	for (;;) {
		for (const marker of [".git", ".hg", ".svn"]) {
			if (fs.existsSync(path.join(dir, marker))) return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return startDir;
		dir = parent;
	}
}

/**
 * Default the sandbox to ONE PER PROJECT rather than one per process.
 *
 * This is the difference between a ~15 s startup and a ~1 s one. The kernel
 * derives `pi-sbx-<pid>-<rand>` and REMOVES it at teardown, so every pi run had
 * to `sbx create` a brand-new VM — including re-preparing its image layers —
 * while a pinned name makes teardown `none`, so the next run reuses the
 * existing sandbox (sandboxd still idle-stops the VM when pi exits, but the VM,
 * its pulled images and anything installed in it survive).
 *
 * It also matches sbxpi, which keeps one sandbox per project, and it makes runs
 * from a subdirectory land in the same sandbox because the name is derived from
 * the project root, not the cwd.
 *
 * An explicit DOCKER_SANDBOX always wins; SBX_EPHEMERAL=1 restores the old
 * per-session behaviour.
 */
export function defaultProjectSandbox(startDir: string): string | undefined {
	const explicit = (process.env.DOCKER_SANDBOX ?? "").trim();
	if (explicit) return sanitizeName(explicit);
	if (/^(1|true|yes|on)$/i.test((process.env.SBX_EPHEMERAL ?? "").trim())) return undefined;

	const root = findProjectRoot(startDir);
	const name = `pi-sbx-${sanitizeName(path.basename(root) || "project")}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
	process.env.DOCKER_SANDBOX = name;
	return name;
}

/* ------------------------------------------------------------------ */
/* optional timing (SBX_PI_DEBUG=1, matching the launcher's convention) */
/* ------------------------------------------------------------------ */

function debugEnabled(): boolean {
	return /^(1|true|yes|on)$/i.test((process.env.SBX_PI_DEBUG ?? process.env.SBX_DEBUG ?? "").trim());
}

function note(message: string): void {
	if (debugEnabled()) console.error(`[sbx] ${message}`);
}

/** Time an async startup phase; a no-op passthrough unless debugging is on. */
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
	if (!debugEnabled()) return fn();
	const started = Date.now();
	try {
		return await fn();
	} finally {
		console.error(`[sbx] ${label}: ${Date.now() - started}ms`);
	}
}

export interface ExecOptions {
	/** Streamed stdout+stderr (interleaved in arrival order, like a terminal). */
	onData?: (chunk: Buffer) => void;
	/** Abort the command (SIGKILL the child). */
	signal?: AbortSignal;
	/** Timeout in SECONDS (matches pi's BashOperations contract). */
	timeout?: number;
}

export interface ExecOutcome {
	/** null when the process was killed by a signal. */
	exitCode: number | null;
	stdout: Buffer;
	stderr: Buffer;
}

export interface ExecTransport {
	readonly kind: "sbx" | "docker";
	readonly target: string;
	/** Run `argv[0] argv[1] ...` inside the sandbox. No shell is implied. */
	exec(argv: string[], opts?: ExecOptions): Promise<ExecOutcome>;
}

/** Run argv inside the sandbox; buffers stdout/stderr, optionally streams them. */
function spawnExec(bin: string, prefix: string[], argv: string[], opts: ExecOptions = {}): Promise<ExecOutcome> {
	return new Promise((resolve, reject) => {
		if (opts.signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}

		const child = spawn(bin, [...prefix, ...argv], {
			// Minimal safe env: HOME/PATH/USER/... minus DOCKER_*/COMPOSE_*.
			env: scrubbedEnv(),
			stdio: ["ignore", "pipe", "pipe"],
			// Own process group, so an abort/timeout can kill the CLI *and* any
			// children it spawned here, instead of orphaning them.
			detached: true,
		});

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		// Stream interleaved, and keep the raw streams for callers that buffer.
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout.push(chunk);
			opts.onData?.(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr.push(chunk);
			opts.onData?.(chunk);
		});

		child.on("error", (err) => {
			cleanup();
			reject(err);
		});

		let timedOut = false;
		// SIGKILL the whole process group: the direct child is the sbx/docker CLI,
		// whose own children would otherwise survive. (A process already running
		// INSIDE the sandbox VM is not reachable this way and may outlive the
		// call - see sandbox/README.md.)
		const killTree = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer =
			opts.timeout && opts.timeout > 0
				? setTimeout(() => {
						timedOut = true;
						killTree();
					}, opts.timeout * 1000)
				: undefined;

		const onAbort = () => killTree();
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		function cleanup() {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		}

		child.on("close", (code, signal) => {
			cleanup();
			if (opts.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			if (timedOut) {
				reject(new Error(`timeout:${opts.timeout}`));
				return;
			}
			resolve({
				exitCode: signal ? null : code,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
			});
		});
	});
}

/**
 * `sbx exec <sandbox> -- ...` — the product path.
 *
 * START-FAILURE RETRY — scope stated precisely, because the word "retry"
 * invites over-claiming. This absorbs a **transient** start failure: the
 * concurrent-start race (two callers racing to bring one per-project VM up, the
 * loser seeing `409 ... port is already allocated`) and a `5xx` from sandboxd's
 * runtime API. It is bounded to 2 retries (250 ms, 1000 ms) and gated on
 * `isRuntimeNeverStarted`, so the command provably did not run and re-running it
 * cannot duplicate a side effect. It runs ONLY while the transport is cold, so a
 * healthy session pays nothing, and a genuinely dead VM still fails in ≈1.25 s.
 *
 * NOT absorbed: the PERSISTENT `409 ... port 127.0.0.1:8081/tcp is already
 * published` conflict. That is a different 409 — a stored port mapping still
 * holds the port and ~100 consecutive attempts were measured to fail with it.
 * A retry cannot clear a stored mapping; the VM must be stopped or the mapping
 * cleared (`sbx stop <name>`) before it can start. The bounded budget is what
 * keeps that case a fast, honest failure instead of a long hang, but it is not
 * a fix for it.
 *
 * Stream note: `spawnExec` forwards `opts.onData` for stdout AND stderr, so a
 * first attempt that is discarded will already have streamed the CLI's own
 * error line to the caller. That is cosmetic and deliberately not hidden —
 * un-streaming is impossible anyway, and suppressing it would mean pretending
 * the failed attempt never happened.
 */
export function createSbxTransport(sandboxName: string): ExecTransport {
	const bin = findSbxCli();
	const spawn = (argv: string[], opts?: ExecOptions) => spawnExec(bin, ["exec", sandboxName, "--"], argv, opts);
	return {
		kind: "sbx",
		target: sandboxName,
		exec: createRetryingExec({ run: spawn, shouldRetry: isRuntimeNeverStarted }),
	};
}

/**
 * `docker exec <container> -- ...` — alternate/test backend.
 *
 * Deliberately NOT the default and never implicit: the default path is sbx,
 * and a container is only used when a container id is supplied explicitly.
 */
export function createDockerTransport(container: string): ExecTransport {
	return {
		kind: "docker",
		target: container,
		// docker takes `exec <container> <cmd...>` — it has no `--` separator
		// (unlike sbx), so the prefix differs from the sbx backend.
		exec: (argv, opts) => spawnExec("docker", ["exec", container], argv, opts),
	};
}

/**
 * Where template/build.sh records the ref of the lightweight template it built.
 * The handshake is a file rather than configuration so that the user never has
 * to set anything: build the template (or let a launcher build it) and the next
 * session picks it up.
 */
function templateRefFile(): string {
	const cache = (process.env.XDG_CACHE_HOME ?? "").trim() || path.join(os.homedir(), ".cache");
	return path.join(cache, "pi-sbx-lite", "template-ref");
}

/**
 * Does `sbx template ls` list `tag`? Handles both known output layouts (a
 * `<repo> <version>` table and a flat `<repo>:<version>` list) by matching on
 * the repository basename and version rather than on column positions.
 */
export function templateListHas(output: string, tag: string): boolean {
	const separator = tag.lastIndexOf(":");
	if (separator < 0) return false;
	const wantedRepo = tag.slice(0, separator).split("/").pop();
	const wantedVersion = tag.slice(separator + 1);
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line || /^REPOSITORY/i.test(line)) continue;
		const parts = line.split(/\s+/);
		const first = parts[0] ?? "";
		const basename = first.split("/").pop();
		// Flat layout: one token, "<repo path>/<name>:<version>" — so the tag is
		// the LAST path segment, not the whole token.
		if (parts.length === 1 && basename === tag) return true;
		// Table layout: "<repo> <version>" in separate columns.
		if (basename === wantedRepo && parts[1] === wantedVersion) return true;
	}
	return false;
}

/**
 * Adopt the lightweight template if one has been recorded AND it still exists.
 *
 * Never fatal and never required: if the file is absent, unreadable, or names a
 * template that has since been removed, we simply leave DOCKER_SANDBOX_TEMPLATE
 * unset and the sandbox is created from the stock base. That is what makes the
 * "the user does nothing" guarantee safe — a missing template degrades speed,
 * it never turns into a failure.
 *
 * An explicit DOCKER_SANDBOX_TEMPLATE always wins.
 */
async function useRecordedTemplate(): Promise<void> {
	if ((process.env.DOCKER_SANDBOX_TEMPLATE ?? "").trim()) return;
	let ref: string;
	try {
		ref = fs.readFileSync(templateRefFile(), "utf8").trim();
	} catch {
		return; // never built — stock base is fine
	}
	if (!ref) return;
	try {
		const tag = ref.split("/").slice(-1)[0]; // docker.io/library/x:y -> x:y
		const listed = await runSbxCli(["template", "ls"], 30_000);
		if (templateListHas(`${listed.stdout}\n${listed.stderr}`, tag)) {
			process.env.DOCKER_SANDBOX_TEMPLATE = ref;
		}
	} catch {
		/* verification failed: fall back to the stock base rather than gamble */
	}
}

/**
 * Resolve the transport for this session.
 *
 * `SBX_BACKEND=docker` + `SBX_DOCKER_CONTAINER=<id>` opts into the container
 * backend (test/alternate); anything else auto-provisions and targets an sbx
 * sandbox via the shared kernel.
 */
export async function resolveTransport(): Promise<ExecTransport> {
	const startedAt = Date.now();
	const backend = (process.env.SBX_BACKEND ?? "sbx").trim().toLowerCase();
	if (backend === "docker") {
		const container = (process.env.SBX_DOCKER_CONTAINER ?? "").trim();
		if (!container) throw new Error("SBX_BACKEND=docker requires SBX_DOCKER_CONTAINER=<container id or name>");
		note(`backend=docker container=${container} (${Date.now() - startedAt}ms)`);
		return createDockerTransport(container);
	}
	// Both must run BEFORE ensureSandbox(): the first chooses the template it
	// creates from, the second arms the watchdog that reads the keepalive flag.
	await timed("template", () => useRecordedTemplate());
	defaultKeepaliveOn();
	const sandbox = await timed("ensure sandbox (create if missing)", () => ensureSandbox());
	note(
		`backend=sbx sandbox=${sandbox} template=${process.env.DOCKER_SANDBOX_TEMPLATE ?? "stock base"} ` +
			`keepalive=${process.env.DOCKER_SANDBOX_KEEPALIVE} total=${Date.now() - startedAt}ms`,
	);
	return createSbxTransport(sandbox);
}

/**
 * Keep the sandbox VM running for as long as the pi process lives.
 *
 * sandboxd stops an idle sandbox ~2-4 min after the last `sbx` call, so
 * without this, the first tool call after any pause pays a multi-second VM
 * boot — the only overhead in this backend that is actually noticeable. The
 * backend therefore defaults keepalive ON, while an explicit
 * `DOCKER_SANDBOX_KEEPALIVE=0` still wins.
 *
 * Note this keeps the VM *running*; it does not keep it *existing*. Teardown is
 * still governed by DOCKER_SANDBOX_TEARDOWN (default `remove` for a
 * session-scoped sandbox), so the sandbox dies with the pi process — pin
 * DOCKER_SANDBOX and use `TEARDOWN=stop` if you want docker images to survive
 * between runs.
 */
function defaultKeepaliveOn(): void {
	if ((process.env.DOCKER_SANDBOX_KEEPALIVE ?? "").trim() === "") {
		process.env.DOCKER_SANDBOX_KEEPALIVE = "1";
	}
}

/* ------------------------------------------------------------------ */
/* argv-safe shell helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * Single-quote a value for /bin/sh. Safe for arbitrary bytes except NUL
 * (which cannot appear in an argv anyway).
 */
export function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build argv for `sh -c <script> <$0> <args...>`.
 *
 * Passing user values as POSITIONAL params ($1, $2, ...) instead of splicing
 * them into the script means paths and content can never be reinterpreted as
 * shell syntax or as options — the same reason the docker_* tools validate
 * their args.
 */
export function shArgs(script: string, ...args: string[]): string[] {
	return ["sh", "-c", script, "sbx-ops", ...args];
}
