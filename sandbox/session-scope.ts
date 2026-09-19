/**
 * Session-scope guards for the sbx tool router.
 *
 * **Zero imports on purpose** (same discipline as `failure.ts`): the vendored
 * repo's own suite cannot run from the config repo, but this module can be
 * unit-tested by relative path from `agent/extensions/sbx-backend/`.
 *
 * Why these exist: `@tintinweb/pi-subagents` builds every subagent as a FRESH
 * `AgentSession` **in the same process**, seeded from pi's *built-in* tool
 * definitions and a fresh `DefaultResourceLoader`. It never sees the parent's
 * CLI `-e <checkout>/sandbox` extension, so without help a subagent's `bash`
 * runs on the HOST (measured: `uid=502(sas054)` / `Darwin`, CoreSimulator
 * visible) while the main agent's runs in the VM.
 *
 * The bridge that fixes that (`agent/extensions/sbx-backend/`) is loaded into
 * every subagent session, and it is the ONLY loader under `pidock` (the
 * launcher no longer passes `-e`). Two invariants still need enforcing:
 *
 *  1. **Only the top-level session tears the sandbox down.** The sandbox name
 *     is per-process (`pi-sbx-<pid>-<rand>`); every child session shares the
 *     parent's VM. A child's `session_shutdown` would otherwise `sbx rm
 *     --force` the sandbox out from under the running parent.
 *
 *  2. **One loader per session.** Normally this is by construction, but if a
 *     caller ALSO loads the backend explicitly (`pi -e <checkout>/sandbox,
 *     the vendored repo's standalone usage) while the bridge is active, pi
 *     refuses the second registration (`Tool "read" conflicts with …`). There
 *     is no way to dedupe that from here: pi gives each EXTENSION its own
 *     `ExtensionAPI` object (measured — a marker stored on it did not dedupe),
 *     so the two loaders cannot see each other. Documented, not guarded.
 */

/** Process-wide marker: which session owns sandbox teardown. */
const LIFECYCLE_OWNER = Symbol.for("pi-docker-sandbox.lifecycle.owner");

/**
 * Claim process-wide lifecycle ownership.
 *
 * `true` only for the FIRST session to ask — the top-level one, which is
 * necessarily the first to load the router. Child sessions get `false` and
 * must skip teardown. The claim is intentionally never released: pi can create
 * a new top-level session in the same process (`/new`), and that session must
 * not tear down a sandbox other sessions may still be using; leaked sandboxes
 * are reclaimed by the existing `gcSweep` safety net.
 */
export function claimLifecycleOwnership(): boolean {
	const g = globalThis as unknown as Record<symbol, unknown>;
	if (g[LIFECYCLE_OWNER]) return false;
	g[LIFECYCLE_OWNER] = true;
	return true;
}

/**
 * Whether the launcher selected the sbx router for this process.
 *
 * `sbx/pidock` exports `PI_TOOL_ROUTER=sbx` to make the auto-discovered
 * gondolin backend yield; this backend uses the same marker so the bridge is
 * inert under bare `pi`, `pix` and `sbxpi` (none of which route host tools
 * into an sbx sandbox).
 */
export function isSbxRouterSelected(env: Record<string, string | undefined>): boolean {
	return (env.PI_TOOL_ROUTER ?? "").trim().toLowerCase() === "sbx";
}
