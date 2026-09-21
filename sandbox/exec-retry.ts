/**
 * Bounded retry of a *sandbox start* failure, gated on a safety proof.
 *
 * Why retry at all: `sbx exec` can fail because the VM has not started yet, not
 * because the command failed. Two measured causes are transient — the
 * concurrent-start race (two callers racing to bring one project sandbox up;
 * the loser sees `409 ... port is already allocated`) and a `5xx` from
 * sandboxd's runtime API — and both are exactly the case where the command
 * provably did not run. In 317 stored sessions the signature appeared 41 times,
 * and 68 of the observed failure runs were isolated — the very next call
 * succeeded — with only a short tail of 2–7. A bounded retry turns that into
 * one successful tool call instead of an error the agent has to reason about.
 *
 * Why the gate matters: `sbx exec` reports "the VM did not start" and "the
 * command exited non-zero" through the same channel, so retrying on *any*
 * failure could silently re-run a side-effecting command that already ran. The
 * caller therefore injects `shouldRetry` — in the transport that is
 * `isRuntimeNeverStarted` (see `failure.ts`), which matches only sandboxd's own
 * runtime-start rejection. This module stays ignorant of that policy so it can
 * be unit-tested without the pi packages, and so the safety argument lives in
 * exactly one place.
 *
 * Zero imports (not even node builtins): `run`, `shouldRetry` and `sleep` are
 * all injected, so the whole policy is testable from a plain script.
 */

/**
 * Bounded by design: with the default budget a dead sandbox costs one failed
 * attempt plus 250 ms + 1000 ms. Anything larger would trade a subtle speedup
 * in a rare race for a much slower, less honest failure.
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

/** The subset of an `ExecOutcome` the retry policy needs to see. */
export interface RetryOutcome {
	/** null when the process was killed by a signal (our own abort/timeout). */
	exitCode: number | null;
	stdout?: Uint8Array | string;
	stderr?: Uint8Array | string;
}

/** The subset of `ExecOptions` the retry policy needs to see. */
export interface RetryCallOptions {
	/** Abort the command; an aborted call is never retried. */
	signal?: AbortSignal;
}

export interface RetryingExecConfig<O extends RetryOutcome, Opts extends RetryCallOptions> {
	/** Run the command once. Rejections propagate untouched (no retry on those). */
	run: (argv: string[], opts?: Opts) => Promise<O>;
	/** The safety proof: does this outcome mean the command provably did not run? */
	shouldRetry: (outcome: O) => boolean;
	/** Delay between attempts, injectable so tests need no real time. */
	sleep?: (ms: number) => Promise<void>;
	/** Pause before retry N, in ms. Default [250, 1000] — 1.25 s of total wait. */
	delaysMs?: readonly number[];
}

/**
 * Wrap `run` with the bounded start-failure retry.
 *
 * Policy, in order:
 *
 *  1. **Run once, always.** A call that fails with a non-retryable outcome sets
 *     the transport `warm` and is returned as-is.
 *  2. **Only retry while cold.** The transient causes are a *warm-up* race, so
 *     once any call has proven the VM reachable (`warm = true`) every later
 *     call is single-shot. The state is shared across calls on the returned
 *     exec, which is what makes "the second caller in a race is the one that
 *     absorbs it" work.
 *  3. **At most two retries**, after 250 ms and 1000 ms. A genuinely dead
 *     sandbox still fails in ≈1.25 s, so the failure stays prompt and honest
 *     rather than a hang with a misleadingly successful look.
 *  4. **Never on an abort or timeout.** `exitCode null` means our own
 *     abort/timeout: the command may have run, or may still be running, so
 *     re-running it would duplicate side effects. A caller-aborted signal is
 *     the same — stop immediately, retry nothing.
 */
export function createRetryingExec<O extends RetryOutcome, Opts extends RetryCallOptions = RetryCallOptions>(
	config: RetryingExecConfig<O, Opts>,
): (argv: string[], opts?: Opts) => Promise<O> {
	const delays = config.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
	const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	/** The warm-up window is over once ANY call has proven the runtime reachable. */
	let warm = false;

	return async (argv, opts) => {
		for (let attempt = 0; ; attempt++) {
			const outcome = await config.run(argv, opts);
			// Our own abort/timeout: never a start failure, never retried. The
			// command may have run (or be running), so a retry could duplicate it.
			if (outcome.exitCode === null) return outcome;
			// Not a start failure: the runtime is up (or the command ran and exited
			// non-zero), which is the fact that ends the warm-up window.
			if (!config.shouldRetry(outcome)) {
				warm = true;
				return outcome;
			}
			// Once warm, never retry — the race this exists for is over.
			if (warm) return outcome;
			// A command aborted between attempts stays aborted.
			if (opts?.signal?.aborted) return outcome;
			// Retries exhausted: return the last outcome untouched.
			if (attempt >= delays.length) return outcome;
			await sleep(delays[attempt] ?? 0);
			if (opts?.signal?.aborted) return outcome;
		}
	};
}
