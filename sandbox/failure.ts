/**
 * Classification of a *sandbox-runtime* failure.
 *
 * `sbx exec` normally exits non-zero when the command inside the sandbox exits
 * non-zero — but it ALSO exits non-zero when it never managed to reach the
 * command at all, because the sandbox VM's runtime failed to come up. Those two
 * cases look identical from the transport's point of view (a non-zero exit and
 * some text on stderr), and confusing them is actively harmful:
 *
 *   - reporting "not readable: <path>" / "Path not found" for a dead VM sends
 *     the agent chasing a file that is perfectly fine, and
 *   - treating it as a normal command result means nothing ever invalidates the
 *     memoised transport, so the backend never recovers.
 *
 * This module is deliberately tiny and has ZERO imports (not even node
 * builtins) so the classifier can be unit-tested without the pi packages —
 * see the consumer in `operations.ts`.
 */

/** The `ExecOutcome` shape, structurally: an exit code plus its output. */
export interface ExecLike {
	/** null when the process was killed by a signal. */
	exitCode: number | null;
	stdout?: Uint8Array | string;
	stderr?: Uint8Array | string;
}

function asText(value: Uint8Array | string | undefined): string {
	if (value === undefined) return "";
	return typeof value === "string" ? value : new TextDecoder().decode(value);
}

/**
 * The characteristic signatures of "the sandbox runtime could not start".
 *
 * Chosen to be NARROW. Each one is a phrase the `sbx` CLI or its in-VM runtime
 * emits about the sandbox itself, not something a user command would plausibly
 * print as its own output:
 *
 *  1. `failed to start sandbox` — the CLI's own wrapper line for "I could not
 *     bring this sandbox up", e.g. the reproduced
 *     `failed to start sandbox: start runtime: request failed: 500 ...`.
 *  2. `start runtime: request failed: 5xx` — sandboxd's runtime API rejecting
 *     the start with an HTTP 5xx. Anchored on `start runtime: request failed:`
 *     rather than a bare `request failed: 500`, because the bare form could
 *     come from any command's stderr (a curl wrapper, an API client, ...) and
 *     would then misclassify an ordinary failing command.
 *  3. `docker daemon failed to start` — the in-VM cause the runtime reports
 *     (`docker daemon failed to start inside the sandbox`).
 *
 * Matching deliberately requires BOTH a non-zero exit AND a signature on
 * *stderr* (diagnostics live there; stdout is the command's own output, where a
 * phrase like "request failed: 500" is far more likely to be a false match).
 * A signal kill (exitCode null — our own abort/timeout) is never classified.
 */
const RUNTIME_FAILURE_SIGNATURES: readonly RegExp[] = [
	/failed to start sandbox\b/i,
	/start runtime: request failed:\s*5\d\d\b/i,
	/docker daemon failed to start\b/i,
];

/**
 * Is this outcome "the sandbox runtime failed", rather than "the command
 * exited non-zero"? Conservative on purpose: a plain `exitCode 1` with ordinary
 * stderr (e.g. `grep: no match`) must NOT match.
 */
export function isSandboxUnavailableFailure(outcome: ExecLike): boolean {
	if (outcome.exitCode === 0 || outcome.exitCode === null) return false;
	const stderr = asText(outcome.stderr);
	if (!stderr) return false;
	return RUNTIME_FAILURE_SIGNATURES.some((signature) => signature.test(stderr));
}

/**
 * The typed error for a dead sandbox runtime.
 *
 * Carries the sandbox target and the raw stderr, and its message names the
 * sandbox explicitly so it is actionable wherever it surfaces — the caller
 * (see `sandbox/index.ts`) turns it into a one-per-episode user notification
 * and invalidates the memoised transport, so the NEXT tool call can start the
 * VM again. It is never a licence to retry the command or to fall back to the
 * host: re-running arbitrary work is unsafe, and the host is not the execution
 * environment.
 */
export class SandboxUnavailableError extends Error {
	readonly target: string;
	readonly stderr: string;

	constructor(target: string, stderr: string) {
		const detail = stderr.trim();
		super(
			`sbx sandbox "${target}" is unavailable: the sandbox runtime failed to start, so the command ` +
				`never ran inside it (this is not the command's own exit status).\n` +
				`The VM may need recreating (check \`sbx ls\`, \`sbx stop ${target}\`, or recreate it) — ` +
				`the next tool call will try to start the sandbox again.` +
				(detail ? `\n\n${detail}` : ""),
		);
		this.name = "SandboxUnavailableError";
		this.target = target;
		this.stderr = detail;
	}
}
