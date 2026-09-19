/**
 * sbx execution backend for pi — "gondolin, but the sandbox is a Docker
 * Sandbox".
 *
 * pi runs on the HOST (its own auth, config, sessions, model keys). Every
 * built-in tool — `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` — is
 * executed **inside an sbx microVM**, together with the user's `!` commands.
 * The workspace is mounted in the sandbox at its host absolute path, so paths
 * are identical on both sides and no rewriting is needed.
 *
 * Why this exists: the alternative way to use sbx is to run pi *inside* the
 * sandbox, which needs a pi-bearing template, a bootstrap that seeds state
 * into the sandbox, per-project writable pi state, and a rebuild to pick up a
 * new pi version. Routing the tools instead needs none of that: the sandbox
 * is just an execution environment, and pi stays on the host.
 *
 * **Prompt cost: zero.** Built-in tools are *overridden* (same names, same
 * schemas — only `execute` is replaced), so no new tool schema is added to
 * the system prompt. Adding an `sbx_exec` tool instead would cost tokens on
 * every single turn, forever.
 *
 * Usage (same shape as the gondolin example):
 *   cd /path/to/project
 *   pi -e /path/to/pi-docker-sandbox/sandbox
 *
 * Env:
 *   SBX_BACKEND=docker + SBX_DOCKER_CONTAINER=<id>   route into a container
 *                                                    instead (test/alternate)
 *   DOCKER_SANDBOX / DOCKER_SANDBOX_*                see the docker_* extension
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type GrepToolInput,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { armSessionLifecycle, debugEnabled, envAllowlist, teardownSandbox } from "../index.ts";
import {
	SandboxFailureEpisode,
	SandboxUnavailableError,
	UNSANDBOXED_OPT_IN_ENV,
	decideLocalFallback,
	unsandboxedAllowed,
} from "./failure.ts";
import {
	createBashOps,
	createEditOps,
	createFindOps,
	createLsOps,
	createReadOps,
	createWriteOps,
	executeSandboxGrep,
} from "./operations.ts";
import { type ExecTransport, defaultProjectSandbox, resolveTransport } from "./transport.ts";
import { claimLifecycleOwnership } from "./session-scope.ts";

export default function (pi: ExtensionAPI) {
	// Subagent sessions (pi-subagents) load this router too, through the
	// auto-discovered `sbx-backend` bridge, so a subagent's built-in tools run in
	// the same sandbox as the main agent's instead of on the host. Only the
	// top-level session may tear the shared (per-process) sandbox down; child
	// sessions share it.
	const ownsLifecycle = claimLifecycleOwnership();
	const localCwd = process.cwd();

	// Settle the sandbox NAME synchronously, before any session event can compute
	// (and memoise) the kernel's per-process fallback name. A stable, per-project
	// name is what lets a later run reuse this project's sandbox instead of
	// creating a new VM each time.
	const projectSandbox = defaultProjectSandbox(localCwd);

	// Built-in tool DEFINITIONS, kept to inherit schema, description, prompt
	// snippet/guidelines and renderer. The *Definition* factories are used
	// deliberately: `createXTool()` wraps and drops `promptSnippet` /
	// `promptGuidelines`, and pi builds the system prompt's tool table from the
	// registered tool objects — so an override built from `createXTool()` would
	// silently delete the built-in guidance for that tool.
	const localRead = createReadToolDefinition(localCwd);
	const localWrite = createWriteToolDefinition(localCwd);
	const localEdit = createEditToolDefinition(localCwd);
	const localBash = createBashToolDefinition(localCwd);
	const localLs = createLsToolDefinition(localCwd);
	const localFind = createFindToolDefinition(localCwd);
	const localGrep = createGrepToolDefinition(localCwd);

	let transport: ExecTransport | undefined;
	let starting: Promise<ExecTransport | undefined> | undefined;
	let lastError: string | undefined;
	/**
	 * Notification state for the CURRENT run of runtime failures. One message per
	 * episode, reset by a successful round-trip — see `SandboxFailureEpisode`.
	 */
	const sandboxEpisode = new SandboxFailureEpisode();

	/**
	 * Forget the memoised transport so the next tool call re-resolves it.
	 *
	 * This is the whole recovery mechanism: `resolveTransport()` re-derives the
	 * sandbox and (re)starts the VM, so a runtime failure is an episode rather
	 * than a permanent bricking of every remaining tool call in the session.
	 *
	 * `starting` is deliberately NOT reset here. It is non-undefined only while a
	 * `resolveTransport()` is genuinely in flight, and that in-flight resolution
	 * will itself publish a fresh transport when it settles — so the next
	 * `ensureTransport()` awaits it, which is exactly the recovery we want.
	 * Clearing it here would instead let a concurrent caller launch a SECOND
	 * resolution, and each resolution can boot/create a VM. The resulting race is
	 * benign today only because every resolution targets the same per-project
	 * sandbox name and therefore reuses one VM; there is no reason to open it up.
	 */
	function invalidateTransport(): void {
		transport = undefined;
	}

	/**
	 * The fail-closed gate for "there is no transport at all".
	 *
	 * Returns normally ONLY when the user has explicitly opted into unsandboxed
	 * operation (`DOCKER_SANDBOX_ALLOW_UNSANDBOXED=1`); otherwise throws the
	 * typed `SandboxRequiredError`, so the tool call is REFUSED instead of being
	 * silently executed on the host. The decision itself lives in `failure.ts`,
	 * which is import-free and unit-tested.
	 */
	function assertLocalFallbackAllowed(): void {
		const decision = decideLocalFallback(process.env, lastError);
		if (decision.allow === false) throw decision.error;
	}

	/**
	 * Run one sandbox round-trip, turning a dead sandbox into: invalidate +
	 * notify (ONCE per episode) + rethrow.
	 *
	 * Deliberately NOT done here: retrying the command, or running it locally.
	 * Re-running arbitrary work is unsafe (side effects), and the host is not the
	 * execution environment — that would be a sandbox escape. The resolution-time
	 * local fallback (see `ensureTransport`) is unchanged and only applies when no
	 * transport can be resolved at all; it never triggers from here.
	 */
	async function withSandboxFailureHandling<T>(
		ctx: ExtensionContext | undefined,
		run: () => Promise<T>,
	): Promise<T> {
		try {
			const result = await run();
			sandboxEpisode.succeeded(); // a success ends the episode
			return result;
		} catch (err) {
			if (!(err instanceof SandboxUnavailableError)) throw err;
			invalidateTransport();
			// Tell the user ONCE per episode. The claim is only taken when a
			// notification is actually deliverable (`ctx` present) — a failure we
			// cannot surface must not swallow the episode's one message.
			if (sandboxEpisode.claimNotification(ctx !== undefined)) {
				ctx?.ui.notify(
					`sbx sandbox "${err.target}" is unavailable — the sandbox runtime failed to start, so this ` +
						`result is not the command's own exit status and the command's effects cannot be assumed ` +
						`to have happened. The command was NOT run on the host and was not retried. The next tool ` +
						`call will try to start the sandbox again; if it keeps failing, the VM may need recreating ` +
						`(\`sbx ls\`, then \`sbx stop ${err.target}\`).`,
					"error",
				);
			}
			throw err;
		}
	}

	/**
	 * Resolve (and memoize) the transport. Never throws: if sbx is missing or the
	 * sandbox cannot be provisioned, `undefined` is returned and the degradation
	 * is reported — both to the user and in the system prompt. The CALLER of a
	 * tool call then decides what to do (see `assertLocalFallbackAllowed`): by
	 * default it REFUSES, so the host is never silently used as the execution
	 * environment; only an explicit `DOCKER_SANDBOX_ALLOW_UNSANDBOXED=1` opt-in
	 * permits the local fallback.
	 */
	async function ensureTransport(ctx?: ExtensionContext): Promise<ExecTransport | undefined> {
		if (transport) return transport;
		if (!starting) {
			starting = (async () => {
				try {
					ctx?.ui.setStatus("sbx", ctx.ui.theme.fg("accent", "sbx: starting"));
					const resolved = await resolveTransport();
					transport = resolved;
					// Advertise the sandbox to sibling extensions (e.g. sbx-webdev
					// running from a host pi), mirroring SANDBOX_ID in-sandbox.
					process.env.PI_SBX_SANDBOX = resolved.target;
					process.env.PI_SBX_BACKEND = resolved.kind;
					ctx?.ui.setStatus(
						"sbx",
						ctx.ui.theme.fg("accent", `sbx: ${resolved.kind} ${resolved.target.slice(0, 24)}`),
					);
					return resolved;
				} catch (err) {
					lastError = err instanceof Error ? err.message : String(err);
					ctx?.ui.setStatus("sbx", ctx.ui.theme.fg("error", "sbx: unavailable"));
					ctx?.ui.notify(
						unsandboxedAllowed(process.env)
							? `sbx backend unavailable — ${UNSANDBOXED_OPT_IN_ENV}=1, so tools run directly on the host.\n${lastError}`
							: `sbx backend unavailable — refusing tool calls; nothing will run on the host.\n` +
									`Set ${UNSANDBOXED_OPT_IN_ENV}=1 to run tools directly on the host instead.\n${lastError}`,
						"warning",
					);
					return undefined;
				} finally {
					starting = undefined;
				}
			})();
		}
		return starting;
	}

	/**
	 * The working directory a session's routed tools must operate in.
	 *
	 * The backend mounts the process working directory (`localCwd`) into the
	 * sandbox, while pi builds a session's tools with that SESSION's cwd. They
	 * coincide for the top-level session, but not necessarily for a subagent — a
	 * pi-subagents git worktree lives under the host tmpdir, outside the mount.
	 * Routing now happens for subagents too, so the cwd is resolved per call: a
	 * directory inside the mount is used as-is, one outside it is refused rather
	 * than silently executed against (or written to) the wrong tree.
	 */
	function sessionCwd(ctx?: ExtensionContext): string {
		const cwd = ctx?.cwd;
		if (!cwd || cwd === localCwd) return localCwd;
		const rel = path.relative(localCwd, cwd);
		if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return cwd;
		throw new Error(
			`sbx sandbox mounts only ${localCwd}, but this session's working directory is ${cwd}. ` +
				`Its tools cannot be routed into the sandbox; nothing was executed. ` +
				`Do not use worktree isolation (\`isolation: "worktree"\`) under the sbx backend, ` +
				`or re-run the session without it.`,
		);
	}

	/**
	 * Route a tool to the sandbox, refusing to run it on the host when no sandbox
	 * can be had (fail closed) unless the user opted in.
	 *
	 * `ctx` is forwarded — the built-ins use it to inject PI_* session metadata
	 * into the bash environment, and dropping it would silently change behaviour.
	 */
	function routed<T extends { execute: (...args: never[]) => unknown }>(
		local: T,
		build: (t: ExecTransport, cwd: string) => T,
	): T {
		return {
			...local,
			async execute(id: unknown, params: unknown, signal: unknown, onUpdate: unknown, ctx?: ExtensionContext) {
				// Resolved before the transport: an unroutable cwd must fail closed
				// whether or not a sandbox happens to be available.
				const cwd = sessionCwd(ctx);
				const t = await ensureTransport(ctx);
				if (!t) {
					assertLocalFallbackAllowed();
					return (local.execute as Function)(id, params, signal, onUpdate, ctx);
				}
				return withSandboxFailureHandling(ctx, () =>
					(build(t, cwd).execute as Function)(id, params, signal, onUpdate, ctx),
				);
			},
		} as T;
	}

	// Only PI_* session metadata reaches the sandbox shell, plus whatever the
	// user opted into with DOCKER_SANDBOX_ENV_ALLOWLIST. pi's bash tool builds
	// the child env from the FULL host environment, so passing it through
	// unfiltered would copy host API keys into the sandbox.
	const bashAllowEnv = (name: string) => name.startsWith("PI_") || envAllowlist().includes(name);

	pi.on("session_start", async (_event, ctx) => {
		// Routing file tools into the sandbox is incompatible with a read-only
		// workspace mount: writes would fail. Say so instead of failing later.
		if (/^(1|true|ro|yes|on)$/i.test((process.env.DOCKER_SANDBOX_WORKSPACE_RO ?? "").trim())) {
			ctx.ui.notify(
				"DOCKER_SANDBOX_WORKSPACE_RO is set: the sandbox mounts the project read-only, so write/edit/mkdir will fail there. Unset it to use the sbx execution backend.",
				"warning",
			);
		}
		// Do NOT await the transport here. Resolving it can mean booting or even
		// CREATING a VM, and blocking pi's startup on that is exactly the
		// multi-second wait this backend is trying to avoid. Tool calls await the
		// same memoised promise, so the work overlaps with the user reading the
		// prompt instead of gating it.
		void ensureTransport(ctx)
			.then((active) => (active?.kind === "sbx" ? armSessionLifecycle() : undefined))
			.catch((err) => {
				// Raw console writes land on the terminal the TUI is drawing, so cap
				// the failure note behind the debug flag — tool calls refuse by default
				// or run on the host only under the explicit opt-in (the `sbx` command
				// reports live status).
				if (debugEnabled()) console.error(`[sbx] session start failed: ${err instanceof Error ? err.message : String(err)}`);
			});
	});

	pi.on("session_shutdown", async () => {
		// Child (subagent) sessions share the parent's per-process sandbox;
		// tearing it down from one would kill the VM out from under the parent.
		if (!ownsLifecycle) return;
		// Only an sbx sandbox is ours to reclaim; a container backend is a
		// caller-supplied environment (docker_* owns its own sandbox lifecycle).
		if (transport?.kind === "sbx") await teardownSandbox("session_shutdown");
	});

	pi.registerCommand("sbx", {
		description: "Show the sbx execution backend status",
		handler: async (_args, ctx) => {
			const t = await ensureTransport(ctx);
			ctx.ui.notify(
				t
					? [
							`sbx backend: ${t.kind}`,
							`Target: ${t.target}`,
							`Workspace: ${localCwd} (mounted at the same path)`,
							projectSandbox ? `Per-project sandbox: ${projectSandbox} (reused across runs)` : "Ephemeral sandbox (SBX_EPHEMERAL=1)",
							"",
							"Tools routed into the sandbox: bash, read, write, edit, grep, find, ls",
						].join("\n")
					: `sbx backend unavailable — ${
							unsandboxedAllowed(process.env)
								? `tools run directly on the host (${UNSANDBOXED_OPT_IN_ENV}=1)`
								: `tool calls are refused; nothing runs on the host (set ${UNSANDBOXED_OPT_IN_ENV}=1 to allow unsandboxed execution)`
						}.\n${lastError ?? ""}`,
				t ? "info" : "warning",
			);
		},
	});

	pi.registerTool(routed(localRead, (t, cwd) => createReadToolDefinition(cwd, { operations: createReadOps(t) })));
	pi.registerTool(routed(localWrite, (t, cwd) => createWriteToolDefinition(cwd, { operations: createWriteOps(t) })));
	pi.registerTool(routed(localEdit, (t, cwd) => createEditToolDefinition(cwd, { operations: createEditOps(t) })));
	pi.registerTool(routed(localBash, (t, cwd) => createBashToolDefinition(cwd, { operations: createBashOps(t, { allowEnv: bashAllowEnv }) })));
	pi.registerTool(routed(localLs, (t, cwd) => createLsToolDefinition(cwd, { operations: createLsOps(t) })));
	pi.registerTool(routed(localFind, (t, cwd) => createFindToolDefinition(cwd, { operations: createFindOps(t) })));
	// grep is replaced wholesale, not merely re-pointed: pi's grep tool spawns
	// host ripgrep for match discovery regardless of custom operations, which
	// would scan the host filesystem and require rg on the host. The sandbox
	// implementation walks and matches over the transport instead.
	pi.registerTool({
		...localGrep,
		async execute(id, params, signal, onUpdate, ctx) {
			const cwd = sessionCwd(ctx);
			const t = await ensureTransport(ctx);
			if (!t) {
				assertLocalFallbackAllowed();
				return localGrep.execute(id, params, signal, onUpdate, ctx);
			}
			return withSandboxFailureHandling(ctx, () => executeSandboxGrep(t, cwd, params as GrepToolInput));
		},
	});

	// The user's own `!` commands belong in the sandbox too, exactly as gondolin
	// routes them — otherwise `!` would silently execute on the host. When no
	// sandbox can be had, the same fail-closed policy applies: refuse (throw)
	// unless the user opted into unsandboxed operation.
	pi.on("user_bash", async (_event, ctx) => {
		const t = await ensureTransport(ctx);
		if (!t) {
			assertLocalFallbackAllowed();
			return undefined; // opt-in set: run on the host, as explicitly requested
		}
		return { operations: createBashOps(t, { allowEnv: bashAllowEnv }) };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const t = await ensureTransport(ctx);
		const localLine = `Current working directory: ${localCwd}`;
		let replacement: string;
		if (t) {
			replacement =
				`Current working directory: ${localCwd} — commands run inside the ${t.kind} sandbox "${t.target}" ` +
				`(the same absolute paths exist there; the host is not the execution environment)`;
		} else if (unsandboxedAllowed(process.env)) {
			replacement =
				`${localLine} (WARNING: the sbx sandbox is unavailable and ${UNSANDBOXED_OPT_IN_ENV} is set, ` +
				`so commands run directly on the host — not in the sandbox)`;
		} else {
			replacement =
				`${localLine} (WARNING: the sbx sandbox is unavailable and ${UNSANDBOXED_OPT_IN_ENV} is not set, ` +
				`so tool calls are REFUSED and will NOT run — neither in the sandbox nor on the host. ` +
				`Set ${UNSANDBOXED_OPT_IN_ENV}=1 to run tools directly on the host instead.)`;
		}
		const systemPrompt = event.systemPrompt.includes(localLine)
			? event.systemPrompt.replace(localLine, replacement)
			: `${event.systemPrompt}\n\n${replacement}`;
		return { systemPrompt };
	});
}
