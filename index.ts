/**
 * Docker sandbox extension for pi.
 *
 * Gives a pi agent a private deploy target: a Docker Sandbox ("sbx") microVM
 * on the host, with its OWN docker daemon inside it. The sandbox runs in
 * parallel to the agent's own sandbox (e.g. the gondolin micro-VM); the agent
 * deploys into the sbx sandbox, and the host's docker (Docker Desktop /
 * colima / plain dockerd) is NEVER touched.
 *
 * How it works:
 * - The extension runs in the HOST pi process.
 * - Every docker_* tool wraps:  sbx exec <sandbox> -- docker -H unix:///var/run/docker.sock <args>
 * - The sandbox's workspace (the host dir mounted at /workspace in the
 *   agent's VM) is direct-mounted into the sbx microVM, so /workspace/<rel>
 *   -> <host cwd>/<rel> is valid on the host and inside the sandbox.
 *
 * Isolation guarantees (see security.md):
 * - No host docker socket is ever opened; the host `docker` CLI is never
 *   invoked. Only the `sbx` CLI is used.
 * - Docker-related env vars (DOCKER_*, COMPOSE_*) are scrubbed before any
 *   `sbx exec`, and the inner docker CLI is pinned to the sandbox daemon
 *   with -H unix:///var/run/docker.sock — a leaked DOCKER_HOST on the host
 *   cannot redirect the inner CLI.
 * - The sandbox has its own images/containers/volumes and its own kernel.
 * - `docker_verify` runs a live audit of these properties.
 *
 * Multi-session naming:
 * - Each pi session gets its own sandbox: pi-sbx-<pid>-<random> by default
 *   (always unique, never repeats, no environment dependencies) — or a stable
 *   name pinned via env DOCKER_SANDBOX for shared/persistent sandboxes.
 * - The sandbox is auto-provisioned on first use with the session's
 *   workspace mounted (disable with DOCKER_SANDBOX_AUTOCREATE=0).
 *
 * Config env vars:
 *   DOCKER_SANDBOX           explicit sandbox name (default: derived)
 *   DOCKER_SANDBOX_AUTOCREATE  0 disables auto-provisioning (default: on)
 *   DOCKER_SANDBOX_CPUS      CPUs for auto-created sandboxes (default 2)
 *   DOCKER_SANDBOX_MEMORY    memory, binary units (default 2g)
 */

import { execFile, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@earendil-works/pi-ai";

// Host pi cwd is the root that the agent's VM mounts at /workspace.
const hostRoot = process.cwd();
const env = process.env;

const ALLOWED_NAME = /[^A-Za-z0-9._+\-]/g;

function sanitizeName(s: string): string {
	return s
		.replace(ALLOWED_NAME, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

/**
 * Per-session sandbox name: explicit DOCKER_SANDBOX override, else
 * pi-sbx-<pid>-<rand>, which is unique per process and never repeats (no
 * stale-sandbox adoption across restarts). Env/session ids are deliberately
 * NOT used: uniqueness is already guaranteed by pid+random, and stable names
 * are the job of the explicit DOCKER_SANDBOX override for persistent sandboxes.
 *
 * The derived name is computed ONCE and memoized: every tool call in this
 * process must target the SAME sandbox, or each call would auto-provision a
 * fresh VM and all state (containers, images, published ports) would scatter.
 * The explicit DOCKER_SANDBOX override is still read live at every call.
 */
let derivedSandboxName: string | undefined;
function sessionSandboxName(): string {
	const explicit = (env.DOCKER_SANDBOX ?? "").trim();
	if (explicit) return sanitizeName(explicit);
	derivedSandboxName ??= `pi-sbx-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
	return derivedSandboxName;
}

function isExplicitSandbox(): boolean {
	return Boolean((env.DOCKER_SANDBOX ?? "").trim());
}

/** Whether the project workspace should be mounted READ-ONLY into the sandbox. */
function workspaceRo(): boolean {
	const v = (env.DOCKER_SANDBOX_WORKSPACE_RO ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "ro" || v === "yes";
}

/** Scratch rw primary workspace used when the project is mounted read-only. */
function primaryWorkspace(name: string): string {
	return path.join(env.HOME ?? "/tmp", `.sbx-prime-${name}`);
}

/** Teardown policy at session end: remove (default for session sandboxes), stop, or none. */
function teardownMode(): "remove" | "stop" | "none" {
	const v = (env.DOCKER_SANDBOX_TEARDOWN ?? "").trim().toLowerCase();
	if (v === "remove" || v === "stop" || v === "none") return v;
	// Explicit/shared sandbox names default to no auto-teardown; session-scoped ones are removed.
	return isExplicitSandbox() ? "none" : "remove";
}

/** Best-effort teardown of this session's sandbox (used by session_shutdown). Never throws. */
async function teardownSandbox(reason: string): Promise<void> {
	const mode = teardownMode();
	if (mode === "none") return;
	const name = sessionSandboxName();
	try {
		const exists = await sandboxExists(name);
		if (!exists) return;
		// Spawn DETACHED so the removal survives pi's own exit (shutdown handlers
		// may be cut off by a fast SIGTERM/SIGKILL). Retry a few times because
		// sandboxd may be mid-stop on the VM when we fire.
		const action = mode === "stop" ? "stop" : "rm";
		const op = action === "rm" ? `rm --force ${name}` : `stop ${name}`;
		const script = [
			`for i in 1 2 3 4 5; do`,
			`  ${findSbxCli()} ${op} 2>/dev/null && exit 0`,
			`  sleep 2`,
			`done`,
			`exit 1`,
		].join("\n");
		const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore", env: scrubbedEnv() });
		child.unref();
		console.error(`[docker-sandbox] session ${reason}: ${action} sandbox "${name}" (detached, retrying)`);
	} catch (e) {
		console.error(`[docker-sandbox] session ${reason}: teardown of "${name}" failed: ${(e as Error).message}`);
	}
}

function findSbxCli(): string {
	for (const c of ["/opt/homebrew/bin/sbx", "/usr/local/bin/sbx", "sbx"]) {
		try {
			if (c.includes("/") ? fs.existsSync(c) : true) return c;
		} catch {
			/* ignore */
		}
	}
	return "sbx";
}

/**
 * Non-secret vars always forwarded to children (the sbx CLI and shells need
 * them to function; they are not credentials).
 */
const MINIMAL_ENV_VARS = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG", "TERM"];

/** DOCKER_SANDBOX_ENV_PASSTHROUGH=1 → forward host env minus the DOCKER/COMPOSE vars (explicit opt-out). */
function envPassthrough(): boolean {
	const v = (env.DOCKER_SANDBOX_ENV_PASSTHROUGH ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** DOCKER_SANDBOX_ENV_ALLOWLIST="A,B,C" → forward MINIMAL_ENV_VARS + exactly those. */
function envAllowlist(): string[] {
	const raw = (env.DOCKER_SANDBOX_ENV_ALLOWLIST ?? "").split(",");
	const out: string[] = [];
	for (const s of raw) {
		const name = s.trim();
		if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !out.includes(name)) out.push(name);
	}
	return out;
}

/** Human-readable forwarding mode, for status/verify output. */
function envForwardMode(): string {
	if (envPassthrough()) return "passthrough (host env minus DOCKER_*/COMPOSE_*; explicit opt-out)";
	const allow = envAllowlist();
	if (allow.length) return `allowlist (minimal + ${allow.join(", ")})`;
	return "strict (minimal safe set only) — default";
}

/**
 * Environment passed to every child process (sbx CLI, watchdog, teardown).
 *
 * Isolation (ALWAYS, any mode): DOCKER_HOST / DOCKER_CONTEXT / DOCKER_* /
 * COMPOSE_* are stripped — a leaked docker-affecting var could redirect the
 * inner docker client to a host daemon.
 *
 * Confidentiality (secure by default): only MINIMAL_ENV_VARS (non-secret,
 * needed by the sbx CLI/shells) are forwarded. Opt in precisely with
 * DOCKER_SANDBOX_ENV_ALLOWLIST="A,B" (adds exactly A and B), or opt out
 * entirely with DOCKER_SANDBOX_ENV_PASSTHROUGH=1 (host env minus the docker
 * vars — matches raw `sbx exec` semantics for legacy compose interpolation).
 */
function scrubbedEnv(): NodeJS.ProcessEnv {
	const e: NodeJS.ProcessEnv = {};
	const add = (name: string, value: string | undefined) => {
		if (value === undefined) return;
		if (name === "DOCKER_HOST" || name === "DOCKER_CONTEXT" || name.startsWith("DOCKER_") || name.startsWith("COMPOSE_")) return;
		e[name] = value;
	};
	if (envPassthrough()) {
		for (const [k, v] of Object.entries(env)) add(k, v);
		return e;
	}
	for (const name of MINIMAL_ENV_VARS) add(name, env[name]);
	for (const name of envAllowlist()) add(name, env[name]);
	return e;
}

/**
 * Split a command string into args, honoring single/double quotes (no escape
 * handling — for anything more complex pass the array form instead).
 */
function splitCommand(cmd: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	for (const ch of cmd) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (cur) {
				out.push(cur);
				cur = "";
			}
		} else {
			cur += ch;
		}
	}
	if (cur) out.push(cur);
	return out;
}

function mapHostPath(input: string): string {
	const trimmed = (input ?? "").trim();
	if (!trimmed) throw new Error("docker: empty path");
	if (trimmed.startsWith("/workspace")) {
		const rel = trimmed.slice("/workspace".length).replace(/^\/+/, "");
		return rel ? path.join(hostRoot, rel) : hostRoot;
	}
	if (path.isAbsolute(trimmed)) return trimmed;
	return path.resolve(hostRoot, trimmed);
}

/* ------------------------------------------------------------------ */
/* sbx exec transport                                                  */
/* ------------------------------------------------------------------ */

type ExecResult = { code: number; stdout: string; stderr: string };

function runSbxCli(args: string[], timeoutMs?: number): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(
			findSbxCli(),
			args,
			{ env: scrubbedEnv(), timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, windowsHide: true },
			(err, stdout, stderr) => {
				const code = err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0;
				resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
			},
		);
	});
}

async function sandboxExists(name: string): Promise<boolean> {
	const ls = await runSbxCli(["ls"]);
	const hay = `${ls.stdout}\n${ls.stderr}`;
	return new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(hay);
}

async function ensureSandbox(): Promise<string> {
	const name = sessionSandboxName();
	if (await sandboxExists(name)) return name;
	if ((env.DOCKER_SANDBOX_AUTOCREATE ?? "1") === "0") {
		throw new Error(
			`sandbox "${name}" does not exist and auto-provisioning is disabled (DOCKER_SANDBOX_AUTOCREATE=0).\n` +
				`Create it from a host pane: sbx create --name ${name} --cpus ${env.DOCKER_SANDBOX_CPUS ?? "2"} --memory ${env.DOCKER_SANDBOX_MEMORY ?? "2g"} shell ${hostRoot}`,
		);
	}
	const cpus = env.DOCKER_SANDBOX_CPUS ?? "2";
	let mem = env.DOCKER_SANDBOX_MEMORY ?? "2g";
	// sbx requires >= 1 GiB of memory
	const m = /^(\d+)\s*([gGmM])?$/.exec(mem.trim());
	if (m) {
		const v = Number(m[1]);
		const unit = (m[2] ?? "g").toLowerCase();
		if (unit === "g" && v < 1) mem = "1g";
		if (unit === "m" && v < 1024) mem = "1g";
	} else {
		mem = "2g";
	}
	const createArgs = ["create", "--quiet", "--name", name, "--cpus", cpus, "--memory", mem];
	const template = (env.DOCKER_SANDBOX_TEMPLATE ?? "").trim();
	if (template) createArgs.push("--template", template);
	createArgs.push("shell");
	if (workspaceRo()) {
		// sbx requires the PRIMARY workspace to be rw; mount the project as an
		// additional READ-ONLY workspace. The agent writes via /workspace (its own VM),
		// the sandbox only reads it.
		const prime = primaryWorkspace(name);
		try {
			fs.mkdirSync(prime, { recursive: true });
		} catch {
			/* if we cannot create the prime dir, fall through to plain rw below */
		}
		createArgs.push(prime, `${hostRoot}:ro`);
	} else {
		createArgs.push(hostRoot);
	}
	const r = await runSbxCli(createArgs, 600_000);
	if (r.code !== 0) {
		throw new Error(
			`auto-provisioning sandbox "${name}" failed: ${`${r.stdout}\n${r.stderr}`.trim().slice(0, 1200)}\n` +
				`Try creating it from a host pane: sbx create --name ${name} --cpus ${cpus} --memory ${mem} shell ${hostRoot}`,
		);
	}
	spawnWatchdog();
	writeOwnerMarker(name);
	return name;
}

const SANDBOX_HINT = (name: string) =>
	`HINT: sandbox "${name}" missing or unreachable. It is auto-provisioned on first use; ` +
	`check \`sbx ls\` from a host pane, or set DOCKER_SANDBOX_AUTOCREATE=0 and create it manually:\n` +
	`  sbx create --name ${name} shell <workspace-dir>`;

/** Run a docker command inside the sandbox; throw on failure with a helpful hint. */
async function docker(cmdArgs: string[], timeoutMs?: number): Promise<string> {
	const name = await ensureSandbox();
	// Default timeout so an OOM-hung sandbox VM fails the tool call instead of
	// hanging the agent's turn. Long operations (pull/build) pass a larger one.
	const r = await runSbxCli(["exec", name, "--", "docker", "-H", "unix:///var/run/docker.sock", ...cmdArgs], timeoutMs ?? 120_000);
	const out = `${r.stdout}\n${r.stderr}`.trim();
	if (r.code !== 0) {
		// Only offer the sandbox-missing hint when the error actually names this
		// sandbox — docker's own "Unable to find image" / "No such container"
		// errors must NOT trigger it (they'd be misleading).
		const missing = out.includes(name) && /no sandbox|not found|unknown sandbox|does not exist|missing|unreachable/i.test(out);
		throw new Error(
			`docker (in sandbox "${name}") failed (exit ${r.code}): ${out.slice(0, 1500)}${missing ? `\n${SANDBOX_HINT(name)}` : ""}`,
		);
	}
	return out;
}

/** Run a docker command that prints JSON lines and return the parsed array. */
async function dockerJson(cmdArgs: string[]): Promise<Record<string, unknown>[]> {
	const out = await docker(cmdArgs);
	const rows: Record<string, unknown>[] = [];
	for (const line of out.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			rows.push(JSON.parse(t));
		} catch {
			/* ignore non-JSON */
		}
	}
	return rows;
}

/* ------------------------------------------------------------------ */
/* formatting helpers                                                  */
/* ------------------------------------------------------------------ */

function humanBytes(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "-";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)}${units[i]}`;
}

function formatPorts(ports: unknown[]): string {
	if (!Array.isArray(ports) || ports.length === 0) return "-";
	return ports
		.map((p) => {
			const o = p as Record<string, unknown>;
			const host = o.HostIp && o.HostIp !== "0.0.0.0" && o.HostIp !== "::"
				? `${o.HostIp}:${o.HostPort ?? ""}`
				: o.HostPort
					? `0.0.0.0:${o.HostPort}`
					: "";
			return `${o.PrivatePort ?? "?"}/${String(o.Type ?? "tcp")}${host ? ` -> ${host}` : ""}`;
		})
		.join(", ");
}

function formatImageTable(images: Record<string, unknown>[]): string {
	const rows: string[] = [];
	for (const img of images) {
		const tags = Array.isArray(img.RepoTags) ? (img.RepoTags as string[]) : [];
		const tag = tags.find((t) => !t.endsWith(":<none>")) ?? (tags[0] ?? "<none>");
		rows.push(
			`${tag.padEnd(48)} ${(String(img.Id ?? "")).slice(7, 19).padEnd(12)} ${humanBytes(Number(img.Size ?? 0)).padStart(9)} ${new Date(Number(img.Created ?? 0) * 1000).toISOString().slice(0, 10)}`,
		);
	}
	return rows.length ? `IMAGE (name:tag, id, size, created)\n${rows.join("\n")}` : "(no images)";
}

function formatContainerTable(containers: Record<string, unknown>[]): string {
	const rows: string[] = [];
	for (const c of containers) {
		const names = Array.isArray(c.Names) ? (c.Names as string[]).map((n) => n.replace(/^\//, "")).join(",") : "?";
		rows.push(
			`${String(c.Id ?? "").slice(0, 12).padEnd(12)} ${String(c.Image ?? "").slice(0, 30).padEnd(30)} ${String(c.Status ?? "").padEnd(28)} ${formatPorts(c.Ports as unknown[])}  ${names}`,
		);
	}
	return rows.length ? `CONTAINER (id, image, status, ports, names)\n${rows.join("\n")}` : "(no containers)";
}

/* ------------------------------------------------------------------ */
/* dockerfile scaffolding (docker_init)                                */
/* ------------------------------------------------------------------ */

type Lang = "node" | "pnpm" | "go" | "python" | "rust" | "generic";

function detectLang(dir: string): Lang {
	if (fs.existsSync(path.join(dir, "pnpm-lock.yaml")) && fs.existsSync(path.join(dir, "package.json"))) return "pnpm";
	if (fs.existsSync(path.join(dir, "package.json"))) return "node";
	if (fs.existsSync(path.join(dir, "go.mod"))) return "go";
	if (fs.existsSync(path.join(dir, "pyproject.toml")) || fs.existsSync(path.join(dir, "requirements.txt"))) return "python";
	if (fs.existsSync(path.join(dir, "Cargo.toml"))) return "rust";
	return "generic";
}

function dockerfileFor(lang: Lang, port: number): string {
	switch (lang) {
		case "node":
			return [
				"FROM node:22-alpine",
				"WORKDIR /app",
				"COPY package*.json ./",
				"RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi",
				"COPY . .",
				`EXPOSE ${port}`,
				'CMD ["npm", "start"]',
				"",
			].join("\n");
		case "pnpm":
			return [
				"FROM node:22-alpine",
				"RUN corepack enable",
				"WORKDIR /app",
				"COPY package.json pnpm-lock.yaml* ./",
				"RUN pnpm install --frozen-lockfile || pnpm install",
				"COPY . .",
				`EXPOSE ${port}`,
				'CMD ["pnpm", "start"]',
				"",
			].join("\n");
		case "go":
			return [
				"FROM golang:1.24-alpine AS build",
				"WORKDIR /src",
				"COPY go.mod go.sum* ./",
				"RUN go mod download",
				"COPY . .",
				"RUN CGO_ENABLED=0 go build -o /app .",
				"FROM alpine:3.20",
				"COPY --from=build /app /app",
				`EXPOSE ${port}`,
				'CMD ["/app"]',
				"",
			].join("\n");
		case "python":
			return [
				"FROM python:3.12-slim",
				"WORKDIR /app",
				"COPY requirements.txt* ./",
				"RUN pip install --no-cache-dir -r requirements.txt || true",
				"COPY . .",
				`EXPOSE ${port}`,
				'CMD ["python", "-m", "http.server", "8000"]',
				"",
			].join("\n");
		case "rust":
			return [
				"FROM rust:1.80-alpine AS build",
				"WORKDIR /src",
				"COPY . .",
				"RUN cargo build --release && cp target/release/$(awk -F'\"' '/^name *=/ {print $2; exit}' Cargo.toml) /out-app",
				"FROM alpine:3.20",
				"COPY --from=build /out-app /app/app",
				`EXPOSE ${port}`,
				'CMD ["/app/app"]',
				"",
			].join("\n");
		default:
			return [
				"FROM alpine:3.20",
				"WORKDIR /app",
				"COPY . .",
				`EXPOSE ${port}`,
				"CMD [\"sh\"]",
				"",
			].join("\n");
	}
}

const DOCKERIGNORE = [
	".git",
	".gitignore",
	".pi",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".env",
	".env.*",
	"*.log",
	".DS_Store",
	"",
].join("\n");

function composeFor(port: number): string {
	return [
		"services:",
		"  app:",
		"    build: .",
		`    ports:`,
		`      - "${port}:${port}"`,
		"    restart: unless-stopped",
		"",
	].join("\n");
}

/* ------------------------------------------------------------------ */
/* tool implementations                                                */
/* ------------------------------------------------------------------ */

async function toolStatus(): Promise<string> {
	const name = sessionSandboxName();
	let exists = false;
	try {
		exists = await sandboxExists(name);
	} catch {
		/* sbx CLI unavailable — report below */
	}
	const ls = await runSbxCli(["ls"]);
	const lsOut = `${ls.stdout}\n${ls.stderr}`.trim();
	if (ls.code !== 0) {
		return `docker sandbox: "sbx ls" failed (${lsOut.slice(0, 400)}). Is the sbx CLI installed and sandboxd running? (brew install docker/tap/sbx)`;
	}
	if (!exists) {
		return (
			`docker sandbox "${name}": not provisioned yet.` +
			`\nteardown on session end: ${teardownMode()}${isExplicitSandbox() ? " (DOCKER_SANDBOX pinned)" : ""}` +
			`\nAutomatic provisioning is ${(env.DOCKER_SANDBOX_AUTOCREATE ?? "1") === "0" ? "DISABLED" : "enabled"} — it will be created on the first docker_* call with the session workspace (${hostRoot}) mounted.` +
			`\nCurrent sandboxes:\n${lsOut || "(none)"}`
		);
	}
	const line = lsOut.split("\n").find((l) => l.includes(name))?.trim() ?? name;
	try {
		const ver = await docker(["version", "--format", "server {{.Server.Version}} ({{.Server.Os}}-{{.Server.Arch}})"]);
		const info = await dockerJson(["info", "--format", "{{json .}}"]);
		const first = info[0] ?? {};
		return [
			`docker sandbox "${name}" — private docker daemon in an sbx microVM (host docker untouched)`,
			`sbx ls: ${line}`,
			`daemon: ${ver}`,
			`resources: ${first.NCPU ?? "?"} CPUs, ${humanBytes(Number(first.MemTotal ?? 0))} RAM`,
			`state: ${first.Containers ?? 0} containers (${first.ContainersRunning ?? 0} running), ${first.Images ?? 0} images`,
			`workspace mounted: ${hostRoot}${workspaceRo() ? " (READ-ONLY; agent writes via /workspace in its own VM)" : " (read-write)"}`,
			`env forwarding: ${envForwardMode()} (default strict; DOCKER_SANDBOX_ENV_ALLOWLIST opts in, _PASSTHROUGH opts out)`,
			`teardown on session end: ${teardownMode()}${isExplicitSandbox() ? " (DOCKER_SANDBOX pinned)" : ""}`,
			`containers are labeled com.pi.sandbox=true. Run docker_verify for the isolation audit.`,
		].join("\n");
	} catch (e) {
		return `docker sandbox "${name}": ${(e as Error).message}`;
	}
}

async function toolImages(): Promise<string> {
	const images = await dockerJson(["images", "--format", "{{json .}}"]);
	return formatImageTable(images);
}

async function toolPs(all: boolean): Promise<string> {
	const args = ["ps"];
	if (all) args.push("-a");
	args.push("--format", "{{json .}}");
	const containers = await dockerJson(args);
	return formatContainerTable(containers);
}

async function toolPull(image: string): Promise<string> {
	const out = await docker(["pull", image], 600_000);
	const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
	const interesting = lines.filter((l) => /Status:|Digest:|Downloaded newer|up to date/i.test(l));
	return [`pull ${image}`, ...(interesting.length ? interesting : lines.slice(-3))].join("\n");
}

const runParamsSchema = Type.Object(
	{
		image: Type.String({ description: "Image to run, e.g. nginx:1.27" }),
		name: Type.Optional(Type.String({ description: "Optional container name" })),
		command: Type.Optional(
			Type.Union([Type.String(), Type.Array(Type.String())], { description: "Command to run, string or array" }),
		),
		detach: Type.Optional(
			Type.Boolean({ description: "Detach and return immediately (default true). false = wait for exit and return output" }),
		),
		rm: Type.Optional(Type.Boolean({ description: "Remove container after foreground run (default false)" })),
		ports: Type.Optional(Type.Array(Type.String(), { description: "Port mappings, e.g. [\"8080:80\"]" })),
		env: Type.Optional(Type.Union([Type.Array(Type.String()), Type.String()], { description: "Environment variables, K=V" })),
		memory: Type.Optional(
			Type.String({ description: "Memory limit for the container, e.g. 512m, 1g (docker -m); protects the sandbox VM from OOM" }),
		),
		volumes: Type.Optional(Type.Array(Type.String(), { description: "Volume binds, host:container[:ro]" })),
		network: Type.Optional(
			Type.Union([Type.Literal("bridge"), Type.Literal("host"), Type.Literal("none")], { description: "Network mode (default bridge)" }),
		),
		restart: Type.Optional(
			Type.Union(
				[Type.Literal("no"), Type.Literal("always"), Type.Literal("unless-stopped"), Type.Literal("on-failure")],
				{ description: "Restart policy (default: unless-stopped for detached runs, no for foreground)" },
			),
		),
		workdir: Type.Optional(Type.String({ description: "Working directory inside the container" })),
	},
	{ additionalProperties: false },
);
type RunParams = Static<typeof runParamsSchema>;

async function toolRun(params: RunParams): Promise<string> {
	const args = ["run"];
	args.push("--label", "com.pi.sandbox=true");
	const foreground = params.detach === false;
	if (!foreground) args.push("-d");
	if (params.rm) args.push("--rm");
	if (params.name) args.push("--name", params.name);
	for (const p of params.ports ?? []) args.push("-p", p);
	for (const e of Array.isArray(params.env) ? params.env : (params.env ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
		if (e) args.push("-e", e);
	}
	for (const v of params.volumes ?? []) {
		const parts = v.split(":");
		if (parts.length < 2) throw new Error(`docker run: bad volume spec "${v}" (use host:container[:ro])`);
		const hostPart = mapHostPath(parts[0]);
		const rest = parts.slice(1).join(":");
		// In RO-workspace mode, binds sourced from the project are read-only by
		// construction; make it explicit so the container's expectations match.
		if (workspaceRo() && !/:(ro|rw)$/.test(rest)) args.push("-v", `${hostPart}:${rest}:ro`);
		else args.push("-v", `${hostPart}:${rest}`);
	}
	if (params.network && params.network !== "bridge") args.push("--network", params.network);
	// Services (detached runs) default to unless-stopped so they survive the
	// sandbox VM being idle-stopped by sandboxd; foreground runs stay ephemeral.
	const restart = params.restart ?? (foreground ? "no" : "unless-stopped");
	if (restart && restart !== "no") args.push("--restart", restart);
	if (params.memory) args.push("-m", params.memory);
	if (params.workdir) args.push("-w", params.workdir);
	args.push(params.image);
	if (params.command) {
		const cmd = Array.isArray(params.command) ? params.command : splitCommand(params.command);
		args.push(...cmd);
	}

	if (foreground) {
		const out = await docker(args, 600_000);
		return `container exited (${params.image})${params.rm ? ", removed" : ""}:\n${out || "(no output)"}`;
	}

	const name = sessionSandboxName();
	const out = await docker(args);
	const id = out.trim().split("\n").pop() ?? "?";
	let portsLine = "";
	try {
		const portsOut = (await docker(["port", id])).trim();
		if (portsOut) portsLine = `\nports (sandbox-internal):\n${portsOut}`;
	} catch {
		/* no published ports */
	}
	// sbx does NOT auto-forward docker -p mappings — publish explicitly and report the host URL.
	const hostUrls: string[] = [];
	if (params.ports?.length) {
		// Correlate reported host URLs to THIS run: only show mappings whose
		// sandbox-side port matches a port this run requested (don't attribute
		// other containers' mappings to this one).
		const containerPorts = new Set<string>();
		for (const spec of params.ports) {
			const m = /^(\d+)(?::(\d+))?(\/udp|\/tcp)?$/.exec(spec.trim());
			if (m) containerPorts.add(`${m[2] ?? m[1]}/${(m[3] ?? "tcp").replace(/^\//, "")}`);
		}
		for (const spec of params.ports) {
			const m = /^(\d+)(?::(\d+))?(\/udp|\/tcp)?$/.exec(spec.trim());
			if (!m) continue;
			// Keep the protocol suffix: sbx ports accepts H:C/udp (a /udp publish
			// silently falling back to tcp would answer with connection resets).
			const pubArg = (m[2] ? `${m[1]}:${m[2]}` : m[1]) + (m[3] ?? "");
			let r = await runSbxCli(["ports", name, "--publish", pubArg]);
			if (r.code !== 0 && m[2]) {
				// host port likely taken — fall back to an ephemeral host port
				r = await runSbxCli(["ports", name, "--publish", `${m[2]}${m[3] ?? ""}`]);
			}
			if (r.code !== 0) {
				hostUrls.push(`${pubArg} (publish failed: ${`${r.stdout}\n${r.stderr}`.trim().slice(0, 120)})`);
			}
		}
		try {
			const portsList = await runSbxCli(["ports", name]);
			for (const line of portsList.stdout.split("\n")) {
				const pm = /127\.0\.0\.1\s+(\d+)\s+(\d+)\s+(tcp|udp)/.exec(line);
				if (pm && containerPorts.has(`${pm[2]}/${pm[3]}`)) hostUrls.push(`http://127.0.0.1:${pm[1]}/ (host ${pm[3]}, sandbox :${pm[2]})`);
			}
		} catch {
			/* ignore */
		}
	}
	const hostLine = hostUrls.length ? `\nhost reachable at:\n${hostUrls.join("\n")}` : "";
	return `started ${params.image} as ${id.slice(0, 12)}${params.name ? ` (${params.name})` : ""} in sandbox "${name}"` +
		` (restart=${restart})${portsLine}${hostLine}\nuse docker_logs / docker_exec to interact, docker_stop / docker_rm to tear down.`;
}

async function toolLogs(id: string, tail: number, timestamps: boolean): Promise<string> {
	const args = ["logs"];
	if (tail > 0) args.push("--tail", String(tail));
	if (timestamps) args.push("--timestamps");
	args.push(id);
	const out = await docker(args);
	return out.trimEnd() || "(no logs)";
}

async function toolExec(id: string, command: string | string[]): Promise<string> {
	const cmd = Array.isArray(command) ? command : splitCommand(command);
	if (!cmd.length) throw new Error("docker exec: empty command");
	const out = await docker(["exec", id, ...cmd]);
	return out.trimEnd() || "(no output)";
}

async function toolBuild(
	context: string,
	tag: string,
	dockerfile: string | undefined,
	buildArgs: string | undefined,
): Promise<string> {
	const hostContext = mapHostPath(context);
	if (!fs.existsSync(hostContext)) throw new Error(`docker build: context not found: ${context}`);
	const stat = fs.statSync(hostContext);
	if (!stat.isDirectory()) throw new Error(`docker build: context must be a directory: ${context}`);

	const args = ["build", "-t", tag];
	if (dockerfile) args.push("-f", path.join(hostContext, dockerfile));
	if (buildArgs) {
		try {
			const parsed = JSON.parse(buildArgs) as Record<string, unknown>;
			for (const [k, v] of Object.entries(parsed)) args.push("--build-arg", `${k}=${String(v)}`);
		} catch {
			throw new Error("docker build: buildargs must be a JSON object string, e.g. {\"VERSION\":\"1.0\"}");
		}
	}
	args.push(hostContext);
	const name = sessionSandboxName();
	const out = await docker(args, 600_000);
	const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
	const useful = lines.filter((l) => /(^#|naming to|writing image|exporting|built |digest|sha256)/i.test(l));
	return [`build ${hostContext} -> ${tag} (inside sandbox "${name}")`, ...(useful.length ? useful.slice(-10) : lines.slice(-3))].join("\n");
}

/** VM + docker resource usage inside the sandbox, with warnings. */
async function toolResources(): Promise<string> {
	const name = sessionSandboxName();
	const lines: string[] = [];
	const warnings: string[] = [];

	// VM-level memory
	try {
		const mem = (await runSbxCli(["exec", name, "--", "free", "-m"])).stdout;
		const row = mem.split("\n").find((l) => /^Mem:/.test(l));
		if (row) {
			const c = row.split(/\s+/).filter(Boolean);
			const total = Number(c[1]);
			const used = Number(c[2]);
			const avail = Number(c[6] ?? c[3]);
			const pct = total > 0 ? Math.round(((total - avail) / total) * 100) : 0;
			lines.push(`VM memory: ${used}MiB used / ${total}MiB (${pct}% — ${avail}MiB available)`);
			if (pct > 85) warnings.push(`VM memory at ${pct}% — containers are at risk of OOM-kill.`);
		}
	} catch {
		/* skip */
	}
	// VM CPUs
	try {
		const cpu = (await runSbxCli(["exec", name, "--", "nproc"])).stdout.trim();
		if (cpu) lines.push(`VM CPUs: ${cpu}`);
	} catch {
		/* skip */
	}
	// VM disk
	try {
		const df = (await runSbxCli(["exec", name, "--", "df", "-h", "/"])).stdout;
		const row = df.split("\n").slice(1).find((l) => l.trim());
		if (row) {
			const c = row.split(/\s+/).filter(Boolean);
			const pct = Number((c[4] ?? "0%").replace("%", ""));
			lines.push(`VM disk: ${c[2]} used / ${c[1]} (${c[4]})`);
			if (pct > 85) warnings.push(`VM disk at ${pct}% — docker builds/pulls may fail with no-space errors.`);
		}
	} catch {
		/* skip */
	}
	// docker disk usage
	try {
		const df = (await docker(["system", "df"])).trim();
		if (df) lines.push(`\ndocker disk:\n${df}`);
	} catch {
		/* skip */
	}
	// per-container usage
	try {
		const stats = (await docker(["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"])).trim();
		if (stats) {
			const rows = stats.split("\n").map((l) => `  ${l.replace(/^\//, "")}`);
			lines.push(`\nrunning containers (name, cpu, mem):\n${rows.join("\n")}`);
		}
	} catch {
		/* skip */
	}

	if (warnings.length) {
		lines.push(
			"\n⚠ WARNINGS:\n" +
				warnings.map((w) => `  - ${w}`).join("\n") +
				"\nRemediation: docker_rm/docker_stop containers; docker_prune for space; " +
				`cap containers with docker_run(memory=...); or raise the sandbox limits (DOCKER_SANDBOX_MEMORY/CPUS) and ` +
				"recreate via docker_sandbox_rm (the sandbox is re-provisioned on the next docker_* call).",
		);
	} else {
		lines.push("\nNo resource warnings. See docker_prune to reclaim space.");
	}
	return lines.join("\n");
}

async function toolPrune(volumes: boolean): Promise<string> {
	const args = ["system", "prune", "-af"];
	if (volumes) args.push("--volumes");
	const out = await docker(args, 600_000);
	return out.trim() || "nothing to prune";
}

async function toolCompose(
	file: string | undefined,
	action: string,
	service: string | undefined,
	extraArgs: string[],
): Promise<string> {
	let hostFile: string | null = null;
	if (file) {
		hostFile = mapHostPath(file);
		if (!fs.existsSync(hostFile)) throw new Error(`docker compose: file not found: ${file}`);
	} else {
		for (const n of ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]) {
			const p = path.join(hostRoot, n);
			if (fs.existsSync(p)) {
				hostFile = p;
				break;
			}
		}
		if (!hostFile) throw new Error("docker compose: no compose file found in workspace (pass file=...)");
	}

	const args = ["compose", "-f", hostFile];
	switch (action) {
		case "up":
			args.push("up", "-d", "--build");
			break;
		case "down":
			args.push("down");
			break;
		case "ps":
			args.push("ps");
			break;
		case "logs":
			args.push("logs", "--tail", "200");
			break;
		case "restart":
			args.push("restart");
			break;
		case "stop":
			args.push("stop");
			break;
		case "config":
			args.push("config");
			break;
		default:
			args.push(action);
	}
	if (service) args.push(service);
	args.push(...extraArgs);

	// For `down`, capture the project's ports first so we can unpublish the
	// corresponding sbx host mappings afterwards (they would otherwise linger).
	let preDownPorts: Set<string> | null = null;
	if (action === "down") {
		try {
			const ps = await dockerJson(["compose", "-f", hostFile, "ps", "--format", "{{json .}}"]);
			const ports = new Set<string>();
			for (const c of ps) {
				for (const pm of composePortMappings(c)) ports.add(`${pm.container}/${pm.proto}`);
			}
			if (ports.size) preDownPorts = ports;
		} catch {
			/* best-effort */
		}
	}

	const out = await docker(args, 600_000);

	if (preDownPorts) {
		try {
			const done = await unpublishMappingsFor(preDownPorts);
			if (done.length) return `${out}\nunpublished host ports: ${done.join(", ")}`;
		} catch {
			/* best-effort */
		}
	}

	// After a successful `up`, publish compose-declared ports on the host
	// (sbx does not auto-forward docker -p mappings).
	let hostSummary = "";
	if (action === "up") {
		try {
			const name = sessionSandboxName();
			const ps = await dockerJson(["compose", "-f", hostFile, "ps", "--format", "{{json .}}"]);
			const toPublish = new Set<string>();
			for (const c of ps) {
				for (const pm of composePortMappings(c)) toPublish.add(`${pm.host}:${pm.container}/${pm.proto}`);
			}
			for (const p of toPublish) {
				const r = await runSbxCli(["ports", name, "--publish", p]);
				if (r.code !== 0) hostSummary += `\nport publish ${p} failed (host port may be taken)`;
			}
			if (toPublish.size) {
				const portsList = await runSbxCli(["ports", name]);
				const urls: string[] = [];
				for (const line of portsList.stdout.split("\n")) {
					const pm = /127\.0\.0\.1\s+(\d+)\s+(\d+)\s+(tcp|udp)/.exec(line);
					if (pm) urls.push(`http://127.0.0.1:${pm[1]}/ (host ${pm[3]}, sandbox :${pm[2]})`);
				}
				if (urls.length) hostSummary = `\nhost reachable at:\n${urls.join("\n")}`;
			}
		} catch {
			/* port publishing is best-effort */
		}
	}
	return `${out}${hostSummary}`;
}

/**
 * Extract host-published port mappings from a `docker compose ps --format
 * "{{json .}}"` row. compose v2 can emit the legacy `Ports` string
 * ("0.0.0.0:8080->80/tcp") and/or the structured `Publishers` array
 * ({PublishedPort, TargetPort, Protocol}); accept both.
 */
function composePortMappings(c: Record<string, unknown>): { host: string; container: string; proto: string }[] {
	const out: { host: string; container: string; proto: string }[] = [];
	const ports = typeof c.Ports === "string" ? (c.Ports as string) : "";
	for (const part of ports.split(",")) {
		const m = /(?:0\.0\.0\.0|\[::\]):(\d+)->(\d+)\/(tcp|udp)/.exec(part.trim());
		if (m) out.push({ host: m[1], container: m[2], proto: m[3] });
	}
	if (Array.isArray(c.Publishers)) {
		for (const p of c.Publishers as Record<string, unknown>[]) {
			const host = String(p.PublishedPort ?? "");
			const container = String(p.TargetPort ?? "");
			const proto = String(p.Protocol ?? "tcp");
			if (host && container) out.push({ host, container, proto });
		}
	}
	return out;
}

/** Unpublish sbx host mappings whose sandbox port is in `sandboxPorts` ("port/proto"). */
async function unpublishMappingsFor(sandboxPorts: Set<string>): Promise<string[]> {
	if (!sandboxPorts.size) return [];
	const name = sessionSandboxName();
	const list = await runSbxCli(["ports", name]);
	const toUnpublish: string[] = [];
	for (const line of list.stdout.split("\n")) {
		const pm = /127\.0\.0\.1\s+(\d+)\s+(\d+)\s+(tcp|udp)/.exec(line);
		if (pm && sandboxPorts.has(`${pm[2]}/${pm[3]}`)) toUnpublish.push(`${pm[1]}:${pm[2]}/${pm[3]}`);
	}
	for (const p of toUnpublish) {
		await runSbxCli(["ports", name, "--unpublish", p]);
	}
	return toUnpublish;
}

async function toolLifecycle(id: string, op: "stop" | "start" | "rm"): Promise<string> {
	switch (op) {
		case "stop":
			await docker(["stop", "--time", "10", id]);
			return `stopped ${id}`;
		case "start":
			await docker(["start", id]);
			return `started ${id}`;
		case "rm": {
			// Unpublish the container's host mappings (sbx does NOT unpublish on
			// container removal; stale mappings would answer with resets).
			const sandboxPorts = new Set<string>();
			try {
				// `docker port` prints CONTAINER_PORT/PROTO -> HOST_IP:HOST_PORT
				// (e.g. "80/tcp -> 0.0.0.0:8080") — note the reversed order vs docker ps.
				const portOut = (await docker(["port", id])).trim();
				for (const line of portOut.split("\n")) {
					const m = /(\d+)\/(tcp|udp)\s*->\s*0\.0\.0\.0:(\d+)/.exec(line.trim());
					if (m) sandboxPorts.add(`${m[1]}/${m[2]}`);
				}
			} catch {
				/* container already gone */
			}
			await docker(["rm", "-f", "-v", id]);
			let un = "";
			try {
				const done = await unpublishMappingsFor(sandboxPorts);
				if (done.length) un = `, unpublished host ports ${done.join(", ")}`;
			} catch {
				/* best-effort */
			}
			return `removed ${id}${un}`;
		}
	}
}

/** Host-side HTTP request to a host-local published port (sbx forwards 127.0.0.1 only). */
async function toolCurl(url: string, timeoutSec: number, method: string, body: string | undefined): Promise<string> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new Error(`docker_curl: invalid URL "${url}" (use e.g. http://127.0.0.1:8080/health)`);
	}
	if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) {
		throw new Error(
			`docker_curl: only host-local published ports are reachable from the host process ` +
				`(sbx binds 127.0.0.1; tried host "${u.hostname}"). For the sandbox-internal address use docker_exec.`,
		);
	}
	const meth = (method || "GET").toUpperCase();
	const hasBody = body !== undefined;
	const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
		const req = http.request(
			{
				host: u.hostname,
				port: Number(u.port || 80),
				path: `${u.pathname}${u.search}`,
				method: meth,
				timeout: Math.max(1, timeoutSec) * 1000,
				headers: {
					accept: "*/*",
					"user-agent": "pi-docker-sandbox/1",
					...(hasBody ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body ?? "")) } : {}),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
				);
			},
		);
		req.on("timeout", () => req.destroy(new Error("timeout")));
		req.on("error", reject);
		if (hasBody) req.write(body ?? "");
		req.end();
	});
	const head = `HTTP ${result.status} ${result.headers["content-type"] ? `content-type: ${result.headers["content-type"]}` : ""}`.trim();
	const text = result.text.slice(0, 4000);
	return text.length ? `${head}\n\n${text}` : `${head}\n(empty response body)`;
}

async function toolInit(
	context: string,
	opts: { lang?: string; force?: boolean; compose?: boolean },
): Promise<string> {
	const dir = mapHostPath(context || ".");
	if (!fs.existsSync(dir)) throw new Error(`docker_init: directory not found: ${context}`);
	if (!fs.statSync(dir).isDirectory()) throw new Error(`docker_init: not a directory: ${context}`);

	const existing = fs.existsSync(path.join(dir, "Dockerfile"));
	if (existing && !opts.force) {
		return `docker_init: ${path.join(dir, "Dockerfile")} already exists (pass force=true to overwrite).`;
	}

	const lang: Lang = opts.lang ? (opts.lang.toLowerCase() as Lang) : detectLang(dir);
	const port = opts.lang === "go" || lang === "go" ? 8080 : lang === "python" ? 8000 : lang === "generic" ? 8080 : 3000;

	fs.writeFileSync(path.join(dir, "Dockerfile"), dockerfileFor(lang, port));
	if (!fs.existsSync(path.join(dir, ".dockerignore"))) {
		fs.writeFileSync(path.join(dir, ".dockerignore"), DOCKERIGNORE);
	}
	const wroteCompose = Boolean(opts.compose) && !fs.existsSync(path.join(dir, "compose.yaml"));
	if (wroteCompose) fs.writeFileSync(path.join(dir, "compose.yaml"), composeFor(port));

	return [
		`docker_init: scaffolded "${lang}" in ${dir}${existing ? " (overwrote Dockerfile)" : ""}`,
		`  wrote: Dockerfile${wroteCompose ? ", compose.yaml" : ""} (+ .dockerignore)`,
		`  image base: ${dockerfileFor(lang, port).split("\n")[0]}`,
		"next: docker_build(context=<dir>, tag=<name>:latest) then docker_run / docker_compose.",
		"Note: adjust CMD/ENTRYPOINT if your entrypoint differs (e.g. package.json scripts).",
	].join("\n");
}

async function toolVerify(): Promise<string> {
	const name = await ensureSandbox();
	const results: { check: string; ok: boolean; evidence: string; warning?: string }[] = [];

	// 1. transport (design assertion)
	results.push({
		check: "transport: tools invoke only `sbx exec` — no host docker socket, no host docker CLI",
		ok: true,
		evidence: "extension code imports only node built-ins (child_process/fs/http/path); it never references docker.sock, /var/run/docker.sock on the host, or the host docker binary",
	});

	// 2. env scrub — nothing docker-related leaks into the sandbox. A
	// DOCKER_* sentinel is injected into the HOST process env; runSbxCli's
	// scrubber must strip it before the sbx exec child (and thus the sandbox)
	// ever sees it. If the scrubber regresses, the sentinel leaks and fails.
	env.DOCKER_HOST_SENTINEL = "sbx-scrub-probe";
	let envOk = false;
	let envOut = "";
	try {
		const envCheck = await runSbxCli(["exec", name, "--", "sh", "-c", "env | grep -iE '^(DOCKER_|COMPOSE_)' || echo __CLEAN__"]);
		envOut = `${envCheck.stdout}\n${envCheck.stderr}`.trim();
		envOk = envCheck.code === 0 && envOut.includes("__CLEAN__") && !envOut.includes("DOCKER_HOST_SENTINEL");
	} finally {
		delete env.DOCKER_HOST_SENTINEL;
	}
	results.push({
		check: "env: no DOCKER_*/COMPOSE_* variables leak into the sandbox",
		ok: envOk,
		evidence: envOk ? "sandbox env contains no docker-related variables (scrubbed before sbx exec)" : `LEAKED: ${envOut.slice(0, 300)}`,
	});

	// 2b. env forwarding policy — secure-by-default: unless passthrough is
	// explicitly enabled, nothing outside the minimal safe set / allowlist may
	// reach the sandbox (probe technique, but for a NON-docker var so it is
	// subject to the allowlist gate, not just the docker scrub).
	if (!envPassthrough()) {
		env.__PI_DOCKER_SANDBOX_VERIFY_PROBE__ = "sbx-env-probe";
		let probeOk = false;
		let probeOut = "";
		try {
			const probe = await runSbxCli(["exec", name, "--", "sh", "-c", "env | grep __PI_DOCKER_SANDBOX_VERIFY_PROBE__ || echo __PROBE_ABSENT__"]);
			probeOut = `${probe.stdout}\n${probe.stderr}`.trim();
			probeOk = probe.code === 0 && probeOut.includes("__PROBE_ABSENT__") && !probeOut.includes("__PI_DOCKER_SANDBOX_VERIFY_PROBE__");
		} finally {
			delete env.__PI_DOCKER_SANDBOX_VERIFY_PROBE__;
		}
		results.push({
			check: "env: restricted forwarding (allowlist/strict) — non-allowlisted vars do not reach the sandbox",
			ok: probeOk,
			evidence: probeOk
				? `mode ${envForwardMode()}; the probe var is not visible inside the sandbox`
				: `PROBE LEAKED: ${probeOut.slice(0, 300)}`,
		});
	} else {
		results.push({
			check: "env: forwarding is in explicit passthrough mode (host env minus DOCKER_*/COMPOSE_*)",
			ok: true,
			evidence: `${envForwardMode()} — set DOCKER_SANDBOX_ENV_ALLOWLIST for precise opt-in, or unset DOCKER_SANDBOX_ENV_PASSTHROUGH to return to the secure default`,
			warning:
				"the host env (minus DOCKER_*/COMPOSE_*) is forwarded into the sandbox; anything deployed there can read it, " +
				"and compose interpolation can carry those vars into containers — use DOCKER_SANDBOX_ENV_ALLOWLIST instead unless you " +
				"deliberately need raw sbx semantics",
		});
	}

	// 3. inner daemon identity + pinned socket
	try {
		const id = (await docker(["info", "--format", "{{.ID}}"])).trim();
		results.push({
			check: "daemon: docker calls pinned to the sandbox daemon via -H unix:///var/run/docker.sock",
			ok: true,
			evidence: `sandbox daemon ID ${id}`,
		});
	} catch (e) {
		results.push({ check: "daemon: sandbox daemon reachable", ok: false, evidence: (e as Error).message.slice(0, 300) });
	}

	// 4. host docker config / host home not mounted into the sandbox
	// (exact host-user paths, so the sandbox's own /home/* is not a false positive)
	const hostUser = (env.USER ?? env.USERNAME ?? (env.HOME ? path.basename(env.HOME) : "user")).trim();
	const hostPaths = [`/Users/${hostUser}/.docker`, `/home/${hostUser}/.docker`, `/Users/${hostUser}/.ssh`, `/home/${hostUser}/.ssh`];
	const mountCheck = await runSbxCli(["exec", name, "--", "sh", "-c", `ls -d ${hostPaths.join(" ")} 2>/dev/null; echo __MOUNT__`]);
	const mountOut = `${mountCheck.stdout}\n${mountCheck.stderr}`.trim();
	const leakedPaths = mountOut.split("\n").filter((l) => l.trim() && !l.includes("__MOUNT__"));
	results.push({
		check: "mounts: host docker config and host home are NOT mounted into the sandbox",
		ok: mountCheck.code === 0 && leakedPaths.length === 0,
		evidence: leakedPaths.length ? `VISIBLE INSIDE SANDBOX: ${leakedPaths.join(", ")}` : `host paths (${hostPaths.join(", ")}) are not visible inside the sandbox`,
	});

	// 5. docker contexts inside the sandbox: only the sandbox's own
	const ctx = await docker(["context", "ls", "--format", "{{.Name}}"]);
	const ctxNames = ctx.split("\n").map((l) => l.trim()).filter(Boolean);
	results.push({
		check: "contexts: only the sandbox's own default docker context is reachable",
		ok: ctxNames.length === 1 && ctxNames[0] === "default",
		evidence: ctxNames.length ? ctxNames.join(", ") : "(none)",
	});

	// 6. host socket not visible inside the sandbox. On macOS the host (Docker
	// Desktop / colima) socket lives at ~/.docker/run/docker.sock and must NOT
	// exist inside the sandbox. On Linux the canonical /var/run/docker.sock
	// path is ALSO the sandbox's own pinned socket, so it cannot be
	// distinguished by path — daemon identity is asserted by check 3 instead.
	let sockResult: { check: string; ok: boolean; evidence: string };
	if (process.platform === "darwin") {
		const hostSock = path.join(env.HOME ?? "/Users/unknown", ".docker/run/docker.sock");
		const sockCheck = await runSbxCli(["exec", name, "--", "sh", "-c", `test -S ${hostSock} && echo __HOST_SOCK_VISIBLE__ || echo __OK__`]);
		const sockOut = `${sockCheck.stdout}\n${sockCheck.stderr}`.trim();
		const sockOk = sockCheck.code === 0 && sockOut.includes("__OK__");
		sockResult = {
			check: "socket: the host Docker socket is not visible inside the sandbox",
			ok: sockOk,
			evidence: sockOk ? `host socket ${hostSock} does not exist inside the sandbox` : sockOut.slice(0, 300),
		};
	} else {
		sockResult = {
			check: "socket: the host Docker socket is not visible inside the sandbox (linux: N/A by path)",
			ok: true,
			evidence:
				"on linux the canonical /var/run/docker.sock path is also the sandbox's own pinned socket, so a path check cannot distinguish host from sandbox; daemon identity is asserted by the daemon check above",
		};
	}
	results.push(sockResult);

	// 7. port bindings are host-localhost only
	const ls = await runSbxCli(["ls"]);
	const row = ls.stdout.split("\n").find((l) => l.includes(name)) ?? "";
	const nonLocal = /0\.0\.0\.0:[0-9]/.test(row) && !/127\.0\.0\.1/.test(row);
	results.push({
		check: "network: published ports bind to host 127.0.0.1 only",
		ok: !nonLocal,
		evidence: nonLocal ? row.trim() : (row.trim() || "no published ports currently"),
	});

	const failed = results.filter((r) => !r.ok);
	const warned = results.filter((r) => r.warning);
	const lines = [
		`Isolation audit for sandbox "${name}"`,
		...results.map((r) => `  [${r.ok ? "PASS" : "FAIL"}] ${r.check}\n        ${r.evidence}${r.warning ? `\n        \u26a0 ${r.warning}` : ""}`),
	];
	lines.push(failed.length ? `\n${failed.length} check(s) FAILED — do not deploy until resolved.` : "\nAll isolation checks passed. The agent's docker reach is confined to this sandbox.");
	if (warned.length) {
		lines.push(`\n\u26a0 ${warned.length} warning(s):`);
		for (const w of warned) lines.push(`  - ${w.check} — ${w.warning}`);
	}
	return lines.join("\n");
}

async function toolSandboxRm(): Promise<string> {
	const name = sessionSandboxName();
	const r = await runSbxCli(["rm", "--force", name]);
	if (r.code !== 0) {
		throw new Error(`removing sandbox "${name}" failed: ${`${r.stdout}\n${r.stderr}`.trim().slice(0, 800)}`);
	}
	removeOwnerMarker(name);
	return `sandbox "${name}" removed (microVM and everything inside it deleted).`;
}

/** Whether to keep the sandbox VM running while this pi process is alive. */
function keepalive(): boolean {
	const v = (env.DOCKER_SANDBOX_KEEPALIVE ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Arm a detached watchdog that tears the sandbox down when THIS pi process
 * exits — works even for SIGKILL/power kills that never fire session_shutdown.
 * The watchdog is spawned detached (new session) so process-group kills of pi
 * do not take it down. Captures the teardown mode at arm time.
 * With DOCKER_SANDBOX_KEEPALIVE=1 it also pokes the sandbox every ~60s so
 * sandboxd's idle-stop (which fires ~2-4 min after the last sbx client
 * disconnects) does not take services down mid-session.
 */
function spawnWatchdog(): void {
	const mode = teardownMode();
	const name = sessionSandboxName();
	const pid = process.pid;
	const keep = keepalive();
	// The watchdog has two independent jobs: teardown on pi exit, and (with
	// DOCKER_SANDBOX_KEEPALIVE=1) keepalive pokes while pi lives. Keepalive
	// applies even when teardown is "none" — a pinned/shared sandbox is exactly
	// the case where you want the VM kept alive but NOT removed.
	if (mode === "none" && !keep) return;
	const op = mode === "stop" ? `stop ${name}` : `rm --force ${name}`;
	const keepLine = keep ? `if [ $((i % 12)) -eq 0 ]; then ${findSbxCli()} ls 2>/dev/null | grep -Fq ${name} && ${findSbxCli()} exec ${name} -- true 2>/dev/null; fi` : "";
	const lines = [
		`PID=${pid}`,
		`i=0`,
		`while kill -0 $PID 2>/dev/null; do`,
		`  i=$((i + 1))`,
		keepLine,
		`  sleep 5`,
		`done`,
	];
	if (mode !== "none") {
		lines.push(
			`for i in 1 2 3 4 5; do`,
			`  ${findSbxCli()} ${op} 2>/dev/null && exit 0`,
			`  sleep 2`,
			`done`,
			`exit 1`,
		);
	}
	const script = lines.filter((l) => l !== "").join("\n");
	try {
		const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore", env: scrubbedEnv() });
		child.unref();
		console.error(`[docker-sandbox] watchdog armed for sandbox "${name}" (pid ${pid}, teardown=${mode}, keepalive=${keep})`);
	} catch (e) {
		console.error(`[docker-sandbox] failed to arm watchdog: ${(e as Error).message}`);
	}
}

/* ------------------------------------------------------------------ */
/* stale-sandbox garbage collection (crash safety net)                 */
/* ------------------------------------------------------------------ */

/** Possible locations of sandboxd's per-sandbox state files. */
function stateDirCandidates(): string[] {
	const base = env.HOME ?? "";
	return [
		path.join(base, "Library/Application Support/com.docker.sandboxes/sandboxes/sandboxd/runtimes"),
		path.join(base, ".local/share/docker-sandboxes/sandboxes/sandboxd/runtimes"),
	];
}

/** Age in ms of a sandbox's state file (mtime), or null if unknown. */
function sandboxAgeMs(name: string): number | null {
	for (const dir of stateDirCandidates()) {
		try {
			const st = fs.statSync(path.join(dir, `${name}.json`));
			if (st.isFile()) return Date.now() - st.mtimeMs;
		} catch {
			/* try next */
		}
	}
	return null;
}

/** Record which pi process owns this sandbox (used by the GC sibling guard). */
function writeOwnerMarker(name: string): void {
	for (const dir of stateDirCandidates()) {
		try {
			if (fs.existsSync(dir)) {
				fs.writeFileSync(path.join(dir, `${name}.pi-owner`), String(process.pid));
				return;
			}
		} catch {
			/* try next */
		}
	}
}

/** Owner pid recorded for a sandbox, or null. */
function readOwnerPid(name: string): number | null {
	for (const dir of stateDirCandidates()) {
		try {
			const v = Number(fs.readFileSync(path.join(dir, `${name}.pi-owner`), "utf8").trim());
			if (Number.isInteger(v) && v > 0) return v;
		} catch {
			/* try next */
		}
	}
	return null;
}

function ownerAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function removeOwnerMarker(name: string): void {
	for (const dir of stateDirCandidates()) {
		try {
			fs.rmSync(path.join(dir, `${name}.pi-owner`), { force: true });
		} catch {
			/* ignore */
		}
	}
}

/**
 * Remove stale session sandboxes: names starting with pi-sbx-, currently
 * stopped, not this session's own, and older than `hours` (0 = any age).
 * Never touches running sandboxes or non-pi sandboxes.
 */
async function gcSweep(hours: number): Promise<string> {
	const ls = await runSbxCli(["ls", "--json"]);
	if (ls.code !== 0) {
		return `gc: "sbx ls --json" failed (${`${ls.stdout}\n${ls.stderr}`.trim().slice(0, 300)})`;
	}
	let boxes: { name?: string; status?: string }[] = [];
	try {
		const parsed = JSON.parse(ls.stdout) as { sandboxes?: unknown };
		boxes = Array.isArray(parsed.sandboxes) ? (parsed.sandboxes as { name?: string; status?: string }[]) : [];
	} catch {
		return "gc: could not parse `sbx ls --json` output.";
	}

	const current = sessionSandboxName();
	const thresholdMs = hours > 0 ? hours * 3600_000 : 0;
	const removed: string[] = [];
	const kept: string[] = [];
	for (const b of boxes) {
		const n = b.name;
		if (!n || !n.startsWith("pi-sbx-") || n === current) continue;
		if (b.status === "running") {
			kept.push(`${n} (running)`);
			continue;
		}
		// Sibling guard: never remove a sandbox whose owner pi process is alive
		// (it may be idle with an idle-stopped VM — concurrent sessions must not
		// reap each other). Only stop-orphaned sandboxes are candidates.
		const owner = readOwnerPid(n);
		if (owner !== null && ownerAlive(owner)) {
			kept.push(`${n} (owner pid ${owner} alive)`);
			continue;
		}
		if (thresholdMs > 0) {
			const age = sandboxAgeMs(n);
			if (age === null || age < thresholdMs) {
				kept.push(`${n} (stopped but recent/unknown age)`);
				continue;
			}
		}
		const r = await runSbxCli(["rm", "--force", n]);
		if (r.code === 0) {
			removed.push(n);
			removeOwnerMarker(n);
		} else {
			kept.push(`${n} (rm failed: ${`${r.stdout}\n${r.stderr}`.trim().slice(0, 120)})`);
		}
	}
	return [
		`gc sweep (${hours > 0 ? `>${hours}h` : "any age"}, namespace pi-sbx-*, stopped only):`,
		removed.length ? `  removed: ${removed.join(", ")}` : "  removed: none",
		kept.length ? `  kept: ${kept.join("; ")}` : "  kept: none",
	].join("\n");
}

/* ------------------------------------------------------------------ */
/* tool result helper                                                  */
/* ------------------------------------------------------------------ */

/** Standard text-only tool result (structured `details` are unused by this extension). */
function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

/* ------------------------------------------------------------------ */
/* extension registration                                              */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
	// Lifecycle: tear down this session's sandbox when the session ends
	// (exit / Ctrl+C / Ctrl+D / SIGHUP / SIGTERM, /new, /resume, /fork).
	pi.on("session_shutdown", async () => {
		await teardownSandbox("session_shutdown");
	});

	// Crash safety net: sweep stale pi-sbx-* sandboxes at session start, and
	// arm the watchdog + owner marker for the current sandbox name (covers
	// /resume case).
	pi.on("session_start", async () => {
		spawnWatchdog();
		writeOwnerMarker(sessionSandboxName());
		const raw = Number(env.DOCKER_SANDBOX_GC_HOURS ?? "24");
		if (!Number.isFinite(raw) || raw <= 0) return;
		try {
			console.error(`[docker-sandbox] ${await gcSweep(raw)}`);
		} catch (e) {
			console.error(`[docker-sandbox] gc at startup failed: ${(e as Error).message}`);
		}
	});

	pi.registerTool({
		name: "docker_status",
		label: "Docker sandbox status",
		description:
			"Check this session's docker sandbox (an sbx microVM with its own private daemon): engine version, " +
			"resources, container/image counts. The sandbox is auto-provisioned on first use if missing. " +
			"NOTE: this sandbox is the deploy target; the host's docker is never used. Run docker_verify for the isolation audit.",
		parameters: Type.Object({}),
		execute: async () => textResult(await toolStatus()),
	});

	pi.registerTool({
		name: "docker_verify",
		label: "Verify sandbox isolation",
		description:
			"Run a live isolation audit of the docker sandbox: transport (sbx only, no host docker), env scrub, " +
			"daemon pinning, host mounts not visible, docker contexts, host socket not visible, localhost-only port binds. " +
			"Returns PASS/FAIL per check with evidence. Run this before/after deploys to confirm isolation is maintained.",
		parameters: Type.Object({}),
		execute: async () => textResult(await toolVerify()),
	});

	pi.registerTool({
		name: "docker_images",
		label: "List sandbox images",
		description: "List images inside the docker sandbox (name:tag, id, size, created).",
		parameters: Type.Object({}),
		execute: async () => textResult(await toolImages()),
	});

	pi.registerTool({
		name: "docker_ps",
		label: "List sandbox containers",
		description:
			"List containers in the docker sandbox. Pass all=true to include stopped ones. " +
			"Containers created by this extension carry the label com.pi.sandbox=true.",
		parameters: Type.Object({ all: Type.Optional(Type.Boolean({ description: "Include stopped containers (default false)" })) }),
		execute: async (_id, params: { all?: boolean }) => textResult(await toolPs(Boolean(params.all))),
	});

	pi.registerTool({
		name: "docker_pull",
		label: "Pull image into sandbox",
		description: "Pull an image into the sandbox daemon, e.g. \"nginx:1.27\" or \"node:22-alpine\". Returns status/digest.",
		parameters: Type.Object({ image: Type.String({ description: "Image reference, e.g. nginx:1.27" }) }),
		execute: async (_id, params: { image: string }) => textResult(await toolPull(params.image)),
	});

	pi.registerTool({
		name: "docker_run",
		label: "Run a container in the sandbox",
		description:
			"Run a container inside the docker sandbox. Default: detach (returns id + published ports). " +
			"detach=false runs in foreground and returns the container's output when it exits. " +
			"ports: array like [\"8080:3000\"] (host:container) — host port must be >= 1024, and AVOID container " +
			"port 80 (the sandbox's port proxy resets it); the extension publishes to host 127.0.0.1 and reports " +
			"the URL. Detached services default to restart=unless-stopped (sandboxd idle-stops sandbox VMs). " +
			"volumes: array like [\"/workspace/app:/srv/app:ro\"] — /workspace paths map to the sandbox mount. " +
			"env: array of K=V. network: bridge|host|none. workdir: workdir in container.",
		parameters: runParamsSchema,
		execute: async (_id, params: RunParams) => textResult(await toolRun(params)),
	});

	pi.registerTool({
		name: "docker_logs",
		label: "Sandbox container logs",
		description: "Fetch logs from a container in the sandbox (by id or name). tail limits lines, timestamps adds them.",
		parameters: Type.Object({
			id: Type.String({ description: "Container id (12+ chars) or name" }),
			tail: Type.Optional(Type.Number({ description: "Last N lines (default 200)" })),
			timestamps: Type.Optional(Type.Boolean({ description: "Prefix timestamps (default false)" })),
		}),
		execute: async (_id, params: { id: string; tail?: number; timestamps?: boolean }) =>
			textResult(await toolLogs(params.id, params.tail ?? 200, Boolean(params.timestamps))),
	});

	pi.registerTool({
		name: "docker_exec",
		label: "Exec in sandbox container",
		description: "Run a command inside a running container in the sandbox and return its output, e.g. docker_exec(id, \"ls -la /app\").",
		parameters: Type.Object({
			id: Type.String({ description: "Container id or name" }),
			command: Type.Optional(
				Type.Union([Type.String(), Type.Array(Type.String())], { description: "Command, string or array" }),
			),
		}),
		execute: async (_id, params: { id: string; command: string | string[] }) =>
			textResult(await toolExec(params.id, params.command)),
	});

	pi.registerTool({
		name: "docker_build",
		label: "Build image in sandbox",
		description:
			"Build a docker image inside the sandbox from a directory in the workspace (host path mapping applies; the " +
			"context is read from the sandbox's mounted workspace). context: workspace dir containing the Dockerfile. " +
			"tag: e.g. myapp:latest. dockerfile: optional relative Dockerfile path. buildargs: optional JSON string of ARG values. " +
			"Use docker_init first to scaffold a Dockerfile for a directory.",
		parameters: Type.Object({
			context: Type.String({ description: "Workspace directory with the Dockerfile, e.g. /workspace/app" }),
			tag: Type.String({ description: "Image tag, e.g. myapp:latest" }),
			dockerfile: Type.Optional(Type.String({ description: "Optional Dockerfile path relative to context" })),
			buildargs: Type.Optional(Type.String({ description: "Optional JSON string of build args, e.g. {\"VERSION\":\"1.0\"}" })),
		}),
		execute: async (_id, params: { context: string; tag: string; dockerfile?: string; buildargs?: string }) =>
			textResult(await toolBuild(params.context, params.tag, params.dockerfile, params.buildargs)),
	});

	pi.registerTool({
		name: "docker_init",
		label: "Scaffold a Dockerfile",
		description:
			"Scaffold a Dockerfile (+ .dockerignore, optional compose.yaml) for a workspace directory so you can quickly " +
			"containerize a project. Detects language from files: package.json (node), pnpm-lock.yaml (pnpm), go.mod (go), " +
			"pyproject.toml/requirements.txt (python), Cargo.toml (rust), else generic alpine. " +
			"lang overrides detection. force overwrites an existing Dockerfile. compose also writes compose.yaml. " +
			"After scaffolding, use docker_build then docker_run or docker_compose.",
		parameters: Type.Object({
			context: Type.Optional(Type.String({ description: "Workspace directory to scaffold (default: workspace root)" })),
			lang: Type.Optional(Type.String({ description: "Override language: node|pnpm|go|python|rust|generic" })),
			force: Type.Optional(Type.Boolean({ description: "Overwrite existing Dockerfile (default false)" })),
			compose: Type.Optional(Type.Boolean({ description: "Also write compose.yaml (default false)" })),
		}),
		execute: async (_id, params: { context?: string; lang?: string; force?: boolean; compose?: boolean }) =>
			textResult(await toolInit(params.context ?? ".", { lang: params.lang, force: Boolean(params.force), compose: Boolean(params.compose) })),
	});

	pi.registerTool({
		name: "docker_compose",
		label: "Compose deploy in sandbox",
		description:
			"Deploy or manage a docker compose project inside the sandbox. file: compose file in the workspace " +
			"(default: compose.yaml/compose.yml/docker-compose.yml in workspace root). action: up (default; builds + starts " +
			"detached), down, ps, logs, restart, stop, config, or any compose verb. service: optional service name. " +
			"extraArgs: optional extra CLI args. This is the main deploy path.",
		parameters: Type.Object({
			file: Type.Optional(Type.String({ description: "Compose file path in workspace (default auto-detect)" })),
			action: Type.Optional(Type.String({ description: "up (default), down, ps, logs, restart, stop, config, or compose verb" })),
			service: Type.Optional(Type.String({ description: "Optional service name" })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra compose CLI args" })),
		}),
		execute: async (_id, params: { file?: string; action?: string; service?: string; extraArgs?: string[] }) =>
			textResult(await toolCompose(params.file, params.action ?? "up", params.service, params.extraArgs ?? [])),
	});

	pi.registerTool({
		name: "docker_stop",
		label: "Stop sandbox container",
		description: "Stop a container in the sandbox by id or name (graceful, 10s timeout).",
		parameters: Type.Object({ id: Type.String({ description: "Container id or name" }) }),
		execute: async (_id, params: { id: string }) => textResult(await toolLifecycle(params.id, "stop")),
	});

	pi.registerTool({
		name: "docker_start",
		label: "Start sandbox container",
		description: "Start a stopped container in the sandbox by id or name.",
		parameters: Type.Object({ id: Type.String({ description: "Container id or name" }) }),
		execute: async (_id, params: { id: string }) => textResult(await toolLifecycle(params.id, "start")),
	});

	pi.registerTool({
		name: "docker_rm",
		label: "Remove sandbox container",
		description: "Force-remove a container in the sandbox by id or name (also removes anonymous volumes).",
		parameters: Type.Object({ id: Type.String({ description: "Container id or name" }) }),
		execute: async (_id, params: { id: string }) => textResult(await toolLifecycle(params.id, "rm")),
	});

	pi.registerTool({
		name: "docker_sandbox_rm",
		label: "Remove this session's sandbox",
		description:
			"DESTRUCTIVE: remove this pi session's entire sandbox (the sbx microVM and everything inside it — images, " +
			"containers, volumes). Use when the session is done and the sandbox is no longer needed. The sandbox is " +
			"auto-recreated on the next docker_* call. See also DOCKER_SANDBOX to share a persistent sandbox.",
		parameters: Type.Object({}),
		execute: async () => textResult(await toolSandboxRm()),
	});

	pi.registerTool({
		name: "docker_curl",
		label: "Probe a published container port",
		description:
			"Send an HTTP request to a URL on the HOST's localhost to verify a deployed container is serving — sbx " +
			"publishes container ports on host 127.0.0.1 only, and this runs in the host pi process, so it is the way " +
			"to check a running service from the agent (the agent's VM cannot reach host loopback). " +
			"url: e.g. http://127.0.0.1:8080/health. method: GET (default), POST, PUT, etc. body: optional request body " +
			"(content-type application/json). Only 127.0.0.1/localhost/::1 hosts are allowed. Returns status + body.",
		parameters: Type.Object({
			url: Type.String({ description: "Host-local URL of the published port, e.g. http://127.0.0.1:8080/health" }),
			timeoutSec: Type.Optional(Type.Number({ description: "Timeout in seconds (default 10)" })),
			method: Type.Optional(Type.String({ description: "HTTP method: GET (default), POST, PUT, DELETE, HEAD, ..." })),
			body: Type.Optional(Type.String({ description: "Optional request body (sent as application/json)" })),
		}),
		execute: async (_id, params: { url: string; timeoutSec?: number; method?: string; body?: string }) =>
			textResult(await toolCurl(params.url, params.timeoutSec ?? 10, params.method ?? "GET", params.body)),
	});

	pi.registerTool({
		name: "docker_resources",
		label: "Sandbox resource usage",
		description:
			"Report resource usage of the sandbox VM and its docker: VM memory/cpu/disk, docker disk (images/containers/" +
			"build cache), and per-running-container cpu/memory. Warns when memory or disk exceed 85% and lists " +
			"remediation (stop/rm containers, docker_prune, cap containers with docker_run(memory=...), or raise " +
			"DOCKER_SANDBOX_MEMORY/CPUS and recreate). Run this when deploys fail, builds error, or containers exit " +
			"abnormally (e.g. OOMKilled, exit 137).",
		parameters: Type.Object({}),
		execute: async () => textResult(await toolResources()),
	});

	pi.registerTool({
		name: "docker_prune",
		label: "Reclaim sandbox space",
		description:
			"docker system prune -af inside the sandbox: removes stopped containers, unused networks, dangling images " +
			"and build cache. volumes=true also removes anonymous volumes. Use when docker_resources shows high disk " +
			"usage or builds fail with no-space errors.",
		parameters: Type.Object({ volumes: Type.Optional(Type.Boolean({ description: "Also remove anonymous volumes (default false)" })) }),
		execute: async (_id, params: { volumes?: boolean }) => textResult(await toolPrune(Boolean(params.volumes))),
	});

	pi.registerTool({
		name: "docker_gc",
		label: "Garbage-collect stale sandboxes",
		description:
			"Remove stale session sandboxes left behind by crashed/killed pi sessions. Only touches sandboxes whose " +
			"name starts with pi-sbx-, that are currently STOPPED, whose owner pi process is DEAD (each session writes an " +
			"owner marker — live concurrent sessions are never reaped, even with hours=0), and older than the given age. " +
			"hours: age threshold (default 24; 0 = any stopped pi-sbx-* sandbox with a dead owner). Running sandboxes and " +
			"non-pi sandboxes are never touched. Runs automatically at session start per DOCKER_SANDBOX_GC_HOURS.",
		parameters: Type.Object({
			hours: Type.Optional(
				Type.Number({ description: "Remove stopped pi-sbx-* sandboxes older than this many hours (0 = any; default 24)" }),
			),
		}),
		execute: async (_id, params: { hours?: number }) => textResult(await gcSweep(params.hours ?? 24)),
	});

	pi.registerCommand("docker", {
		description: "Show docker sandbox status and how to use it",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				[
					"Docker sandbox extension (sbx)",
					`sandbox: ${sessionSandboxName()}  (env DOCKER_SANDBOX overrides; auto-provisioned on first use)`,
					`workspace mounted: ${hostRoot}`,
					"Tools: docker_status, docker_verify, docker_ps, docker_images, docker_pull, docker_run,",
					"docker_logs, docker_exec, docker_build, docker_init, docker_compose, docker_stop/start/rm,",
					"docker_sandbox_rm, docker_gc.",
					"Lifecycle: sandbox auto-created on first use; torn down on session end",
					`(DOCKER_SANDBOX_TEARDOWN=${teardownMode()}); stale sandboxes GC'd per DOCKER_SANDBOX_GC_HOURS.`,
					`Workspace: ${workspaceRo() ? "READ-ONLY in sandbox (agent writes via /workspace)" : "read-write"} (DOCKER_SANDBOX_WORKSPACE_RO).`,
					`Env forwarding: ${envForwardMode()} (default strict; _ALLOWLIST opts in, _PASSTHROUGH opts out).`,
					"Containers get label com.pi.sandbox=true.",
					"Deploy target = sandbox daemon only; host docker is never used.",
				].join("\n"),
				"info",
			);
		},
	});
}

// Named exports for tests (pi's loader only calls the default factory).
export { scrubbedEnv, envForwardMode, envAllowlist, envPassthrough, sessionSandboxName };
