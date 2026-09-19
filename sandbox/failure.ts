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

/* ------------------------------------------------------------------ */
/* fail-closed policy when NO sandbox can be resolved at all           */
/* ------------------------------------------------------------------ */

/**
 * The opt-in that permits running tools directly on the HOST when no sandbox
 * can be resolved.
 *
 * The default is to REFUSE (fail closed): an unresolvable sandbox must never
 * mean "silently run on the host" — that is a sandbox escape, and the host is
 * not the execution environment. Named with the repo's own `DOCKER_SANDBOX_*`
 * prefix and deliberately NOT tied to any launcher (e.g. pidock's separate
 * `PIDOCK_ALLOW_UNSANDBOXED`), so the backend stays usable standalone.
 */
export const UNSANDBOXED_OPT_IN_ENV = "DOCKER_SANDBOX_ALLOW_UNSANDBOXED";

/**
 * True when the user has explicitly opted into unsandboxed operation via
 * `UNSANDBOXED_OPT_IN_ENV`.
 *
 * Accepts `1`, `true`, `yes`, `on` (case-insensitive, surrounding whitespace
 * ignored) — the same boolean vocabulary as the repo's other knobs
 * (`DOCKER_SANDBOX_DEBUG`, `DOCKER_SANDBOX_ENV_PASSTHROUGH`, ...). Anything
 * else, including unset and `0`/`false`/`no`/`off`, leaves the secure default:
 * refuse.
 */
export function unsandboxedAllowed(env: Readonly<Record<string, string | undefined>>): boolean {
	return /^(1|true|yes|on)$/i.test((env[UNSANDBOXED_OPT_IN_ENV] ?? "").trim());
}

/**
 * The typed error for a tool call REFUSED because no sandbox could be resolved
 * and the host fallback is disabled.
 *
 * Distinct from `SandboxUnavailableError`: that one is a sandbox that existed
 * and failed mid-round-trip (transient — the next call re-resolves and may
 * recover). This one means there was never a sandbox to fail in, and the
 * fail-closed policy has refused to run the tool anywhere. It is actionable,
 * not a stack trace: it names the cause, states in as many words that the
 * command was NOT run on the host, and names the exact variable that would opt
 * into unsandboxed operation.
 */
export class SandboxRequiredError extends Error {
	/** The resolution failure that led here (may be empty). */
	readonly failure: string;

	constructor(failure?: string) {
		const detail = (failure ?? "").trim();
		super(
			`sbx sandbox unavailable: ${
				detail ||
				"no sandbox transport could be resolved (is the `sbx` CLI installed and the VM runnable?)"
			}.\n` +
				`This tool was NOT run: it did not execute in the sandbox, and it was NOT run on the host either.\n` +
				`Refusing to run unsandboxed by default. To allow tools to run directly on the host instead, set ` +
				`${UNSANDBOXED_OPT_IN_ENV}=1 and retry.`,
		);
		this.name = "SandboxRequiredError";
		this.failure = detail;
	}
}

/**
 * The fail-closed policy for a resolution failure: from an environment snapshot
 * plus the resolution failure, decide whether the caller may fall back to the
 * LOCAL (host) tool or must refuse.
 *
 * `{ allow: true }` only when the user has explicitly opted in with
 * `DOCKER_SANDBOX_ALLOW_UNSANDBOXED=1` (see `unsandboxedAllowed`). Otherwise the
 * decision carries a `SandboxRequiredError` whose message names the cause, says
 * the command was not run on the host, and names the opt-in variable.
 *
 * Pure and dependency-free (like the rest of this module) so the policy can be
 * unit-tested without the pi packages.
 */
export type LocalFallbackDecision = { allow: true } | { allow: false; error: SandboxRequiredError };

export function decideLocalFallback(
	env: Readonly<Record<string, string | undefined>>,
	failure?: string,
): LocalFallbackDecision {
	if (unsandboxedAllowed(env)) return { allow: true };
	return { allow: false, error: new SandboxRequiredError(failure) };
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
