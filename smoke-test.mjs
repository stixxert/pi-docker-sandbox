/**
 * Smoke test: load the extension module, drive its factory with a mock pi API,
 * and verify every registerTool/registerCommand/on registration succeeds and
 * that a couple of tool executes work end-to-end (schema validation included).
 * Run: node smoke-test.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Node 24 strips types; import the .ts source directly.
const mod = await import("./index.ts");
if (typeof mod.default !== "function") throw new Error("extension must export a default factory");

const tools = [];
const commands = [];
const events = new Map();
const pi = {
	registerTool(def) {
		tools.push(def);
	},
	registerCommand(name, def) {
		commands.push([name, def]);
	},
	on(event, handler) {
		events.set(event, handler);
	},
};

mod.default(pi);

console.log(`registered tools: ${tools.length}`);
console.log(`registered commands: ${commands.map(([n]) => n).join(", ")}`);
console.log(`events subscribed: ${[...events.keys()].join(", ")}`);

if (tools.length < 19) throw new Error(`expected >= 19 tools, got ${tools.length}`);

// Every tool must have a TypeBox-compatible parameters object (plain JSON schema).
for (const t of tools) {
	if (!t.parameters || typeof t.parameters !== "object") throw new Error(`tool ${t.name}: missing parameters`);
	const p = t.parameters;
	if (p.type !== "object") throw new Error(`tool ${t.name}: parameters.type should be "object" (TypeBox), got ${p.type}`);
	const required = p.required ?? [];
	if (!Array.isArray(required)) throw new Error(`tool ${t.name}: required must be array`);
	console.log(`  ${t.name}: props=[${Object.keys(p.properties ?? {}).join(",")}] required=[${required.join(",")}]`);
}

// Names must match the documented toolset.
const expect = [
	"docker_status", "docker_verify", "docker_images", "docker_ps", "docker_pull", "docker_run", "docker_logs",
	"docker_exec", "docker_build", "docker_init", "docker_compose", "docker_stop", "docker_start", "docker_rm",
	"docker_sandbox_rm", "docker_curl", "docker_resources", "docker_prune", "docker_gc",
];
const names = tools.map((t) => t.name).sort();
const missing = expect.filter((n) => !names.includes(n));
const extra = names.filter((n) => !expect.includes(n));
if (missing.length || extra.length) throw new Error(`toolset mismatch missing=[${missing}] extra=[${extra}]`);

// docker_curl must accept method/body now (schema/execute consistency).
const curl = tools.find((t) => t.name === "docker_curl");
const curlProps = Object.keys(curl.parameters.properties);
for (const k of ["url", "timeoutSec", "method", "body"]) {
	if (!curlProps.includes(k)) throw new Error(`docker_curl schema missing ${k}`);
}

// Execute docker_status against a missing-sbx environment: must fail gracefully
// (error, not crash) — sandbox CLI is absent in this VM.
const statusTool = tools.find((t) => t.name === "docker_status");
const result = await statusTool.execute("id", {}, undefined, undefined, {});
console.log("\ndocker_status execute returned:", JSON.stringify(result).slice(0, 200));

/* ------------------------------------------------------------------ */
/* Env confinement (secure-by-default)                                 */
/* ------------------------------------------------------------------ */

// scrubbedEnv() reads process.env at CALL time (live reference), so we can
// test the exported functions directly by patching env around the call.
function withEnv(patch, fn) {
	const saved = {};
	for (const [k, v] of Object.entries(patch)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const BASE = {
	HOME: "/home/u", PATH: "/usr/bin", USER: "u", LOGNAME: "u", TMPDIR: "/tmp", SHELL: "/bin/sh", LANG: "C", TERM: "xterm",
	API_KEY: "secret-1", DB_URL: "postgres://x", WEIRD: "w",
	DOCKER_HOST: "tcp://evil:2375", DOCKER_CONTEXT: "host", COMPOSE_PROJECT_NAME: "p",
};
const MINIMAL = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG", "TERM"];
const SECRETS = ["API_KEY", "DB_URL", "WEIRD", "DOCKER_HOST", "DOCKER_CONTEXT", "COMPOSE_PROJECT_NAME"];

// default = strict: only the minimal safe set reaches the sandbox
{
	const { mode, out } = withEnv({ ...BASE }, () => ({ mode: mod.envForwardMode(), out: mod.scrubbedEnv() }));
	if (!mode.startsWith("strict")) throw new Error(`default mode should be strict, got: ${mode}`);
	for (const k of SECRETS) {
		if (out[k] !== undefined) throw new Error(`default mode leaked ${k}=${out[k]}`);
	}
	for (const k of MINIMAL) {
		if (out[k] !== BASE[k]) throw new Error(`default mode dropped minimal var ${k}`);
	}
	console.log("  env default: strict (minimal set only) - no secrets, no docker vars");
}

// allowlist: minimal + exactly the listed vars; docker vars stay impossible
{
	const { mode, out } = withEnv({ ...BASE, DOCKER_SANDBOX_ENV_ALLOWLIST: "DB_URL, API_KEY , 1BAD" }, () => ({
		mode: mod.envForwardMode(),
		out: mod.scrubbedEnv(),
	}));
	if (!mode.startsWith("allowlist")) throw new Error(`expected allowlist mode, got: ${mode}`);
	if (out.DB_URL !== "postgres://x" || out.API_KEY !== "secret-1") throw new Error("allowlist did not forward listed vars");
	if (out.WEIRD !== undefined) throw new Error("allowlist leaked non-listed var");
	if (out.HOME !== "/home/u") throw new Error("allowlist dropped minimal set");
	if (out.DOCKER_HOST !== undefined || out.DOCKER_CONTEXT !== undefined) throw new Error("allowlist resurrected docker vars");
	console.log("  env allowlist: minimal + listed only (invalid entries ignored); docker vars still impossible");
}

// passthrough: explicit opt-out, docker vars still scrubbed
{
	const { mode, out } = withEnv({ ...BASE, DOCKER_SANDBOX_ENV_PASSTHROUGH: "1" }, () => ({
		mode: mod.envForwardMode(),
		out: mod.scrubbedEnv(),
	}));
	if (!mode.startsWith("passthrough")) throw new Error(`expected passthrough mode, got: ${mode}`);
	if (out.API_KEY !== "secret-1" || out.WEIRD !== "w") throw new Error("passthrough did not forward host vars");
	for (const k of ["DOCKER_HOST", "DOCKER_CONTEXT", "COMPOSE_PROJECT_NAME"]) {
		if (out[k] !== undefined) throw new Error(`passthrough failed to strip ${k}`);
	}
	console.log("  env passthrough: host env minus DOCKER_*/COMPOSE_* (explicit opt-out)");
}

/* ------------------------------------------------------------------ */
/* Sandbox-name stability (per-process memoization)                    */
/* ------------------------------------------------------------------ */

// The derived name must be computed ONCE per process: every tool call has to
// target the same sandbox, or each call would auto-provision a fresh VM and
// all state (containers, images, published ports) would scatter.
{
	const { a, b, c } = withEnv({}, () => ({
		a: mod.sessionSandboxName(),
		b: mod.sessionSandboxName(),
		c: mod.sessionSandboxName(),
	}));
	if (!/^pi-sbx-\d+-[a-z0-9]{4}$/.test(a)) throw new Error(`derived sandbox name malformed: ${a}`);
	if (a !== b || b !== c) throw new Error(`derived sandbox name changed across calls (memoization broken): ${a} -> ${b}`);
	console.log(`  name derived once: ${a} (stable across calls)`);
}

// DOCKER_SANDBOX override is read live and must still win over the memoized name.
{
	const pinned = withEnv({ DOCKER_SANDBOX: "shared-sandbox" }, () => mod.sessionSandboxName());
	if (pinned !== "shared-sandbox") throw new Error(`DOCKER_SANDBOX override ignored: ${pinned}`);
	console.log(`  DOCKER_SANDBOX override honored: ${pinned}`);
}

// Dropping the override falls back to the SAME memoized derived name (not a new one).
{
	const again = withEnv({}, () => mod.sessionSandboxName());
	const first = withEnv({}, () => mod.sessionSandboxName());
	if (again !== first) throw new Error(`derived name regenerated after override was removed: ${first} -> ${again}`);
	console.log(`  derived name stable across override toggles`);
}

console.log("\nSMOKE TEST OK");
