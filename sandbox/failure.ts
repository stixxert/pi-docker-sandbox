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
 * Chosen to be NARROW — specifically, long enough that a *user command's* own
 * stderr cannot plausibly collide with them. That specificity is load-bearing:
 * a false positive REPLACES the command's real exit status with a
 * `SandboxUnavailableError`, and the caller then reports that the command's
 * effects are unknown — which is exactly the ambiguity that tempts an agent to
 * re-run a side-effecting command. So every pattern anchors on the runtime's
 * actual wrapper phrasing, never on a short phrase a project script, CI helper
 * or test wrapper might print about its OWN docker/CI runtime:
 *
 *  1. `failed to start sandbox: start runtime:` — the CLI's own wrapper chained
 *     to the runtime start, e.g. the reproduced
 *     `failed to start sandbox: start runtime: request failed: 500 ...`. BOTH
 *     halves must appear together; the bare `failed to start sandbox` alone is
 *     the kind of line a user's own launcher could emit, so it is not used.
 *  2. `start runtime: request failed: 5xx` — sandboxd's runtime API rejecting
 *     the start with an HTTP 5xx. Anchored on `start runtime: request failed:`
 *     rather than a bare `request failed: 500`, because the bare form could
 *     come from any command's stderr (a curl wrapper, an API client, ...) and
 *     would then misclassify an ordinary failing command.
 *  3. `docker daemon failed to start inside the sandbox` — the in-VM cause, as
 *     the FULL phrase the runtime reports. The short `docker daemon failed to
 *     start` alone is NOT enough: a user command or CI wrapper that manages its
 *     own docker could print exactly that about a local daemon.
 *
 * Matching deliberately requires BOTH a non-zero exit AND a signature on
 * *stderr* (diagnostics live there; stdout is the command's own output, where a
 * phrase like "request failed: 500" is far more likely to be a false match).
 * A signal kill (exitCode null — our own abort/timeout) is never classified.
 */
const RUNTIME_FAILURE_SIGNATURES: readonly RegExp[] = [
	/failed to start sandbox:\s*start runtime:/i,
	/start runtime: request failed:\s*5\d\d\b/i,
	/docker daemon failed to start inside the sandbox\b/i,
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
			`sbx sandbox "${target}" is unavailable: the sandbox runtime failed to start, so this is not the ` +
				`command's own exit status and the command's effects cannot be assumed to have happened.\n` +
				`The command was not run on the host and was not retried. The VM may need recreating (check ` +
				`\`sbx ls\`, \`sbx stop ${target}\`, or recreate it) — the next tool call will try to start the ` +
				`sandbox again.` +
				(detail ? `\n\n${detail}` : ""),
		);
		this.name = "SandboxUnavailableError";
		this.target = target;
		this.stderr = detail;
	}
}

/**
 * Per-episode state for the runtime-failure notification.
 *
 * `withSandboxFailureHandling` (see `sandbox/index.ts`) wraps every routed tool
 * call. A runtime failure should tell the user ONCE — not once per tool call in
 * an otherwise broken session — and then tell them AGAIN if a later call
 * succeeds and a new, distinct outage begins.
 *
 * The subtlety the caller cannot express on its own: a tool call may arrive
 * without a UI context, so a failure cannot always be surfaced. A failure that
 * cannot be surfaced must NOT consume the episode's single notification, or an
 * early headless failure would suppress the one notification the user needs for
 * the whole episode. Hence `claimNotification(canNotify)`: the claim is only
 * used up when the notification is actually deliverable.
 *
 * Pure and dependency-free (like the rest of this module) so the episode's
 * behaviour can be unit-tested without the pi packages.
 */
export class SandboxFailureEpisode {
	/** Has this episode's one notification already been delivered? */
	private notified = false;

	/**
	 * Claim this episode's single notification.
	 *
	 * @param canNotify Whether the caller can actually deliver a notification
	 *   right now (i.e. it has a UI context). When false the claim is left
	 *   untouched, so a later, deliverable failure in the same episode still
	 *   notifies.
	 * @returns true only for the first *deliverable* failure of the episode.
	 */
	claimNotification(canNotify: boolean): boolean {
		if (this.notified || !canNotify) return false;
		this.notified = true;
		return true;
	}

	/** A successful sandbox round-trip ends the episode. */
	succeeded(): void {
		this.notified = false;
	}
}
