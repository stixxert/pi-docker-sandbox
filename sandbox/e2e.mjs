/**
 * End-to-end test for the sbx execution backend.
 *
 * `sbx` itself cannot run here: it boots microVMs through a host hypervisor and
 * this machine is already a sandbox VM with no nested virtualization
 * (/dev/kvm is absent). The transport is therefore pluggable, and the
 * *identical* ops layer is driven here against a real container via
 * `docker exec` — the only difference from the product path is which binary
 * runs `exec <target> --`.
 *
 * What this proves:
 *   - the workspace is visible at the SAME absolute path inside the sandbox
 *     (the assumption the whole design rests on)
 *   - bash runs in the sandbox and propagates exit codes
 *   - read/write move arbitrary bytes with no stdin dependency
 *   - ls/find/grep return correct results through pi's routed tools
 *   - the extension registers exactly the 7 built-in names — no new tools, so
 *     zero added prompt cost — and each one executes end-to-end
 *   - when the sandbox is unavailable, pi degrades to local tools instead of
 *     breaking (sbx is genuinely absent here, so that path is exercised for real)
 *
 * Run: node sandbox/e2e.mjs       (requires docker)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTs } from "../test-loader.mjs";

const CONTAINER = `sbx-e2e-${process.pid}`;
const IMAGE = process.env.SBX_E2E_IMAGE ?? "debian:stable-slim";
const workdir = fs.mkdtempSync(path.join("/tmp", "sbx-e2e-"));
const repoRoot = path.resolve(import.meta.dirname, "..");
// Stand in the project directory, exactly as pi would be launched there: the
// extension captures process.cwd() as the workspace root.
process.chdir(workdir);

let failures = 0;
function check(name, condition, detail = "") {
	if (!condition) failures++;
	const suffix = condition || !detail ? "" : ` — ${detail}`;
	console.log(`  [${condition ? "PASS" : "FAIL"}] ${name}${suffix}`);
}

function docker(args, opts = {}) {
	return execFileSync("docker", args, { encoding: "utf8", ...opts });
}

/* ------------------------------------------------------------------ */
/* TypeScript loading: Node >= 23.6 strips types natively; this sandbox */
/* runs Node 22, so fall back to the loader pi itself uses (see          */
/* ../test-loader.mjs).                                                   */
/* ------------------------------------------------------------------ */

/** Drive the extension factory with a mock pi and return its tools by name. */
function collectTools(factory) {
	const registered = [];
	const commands = [];
	factory({
		registerTool: (def) => registered.push(def),
		registerCommand: (name, def) => commands.push(name),
		on: () => {},
	});
	return { registered, commands, byName: Object.fromEntries(registered.map((t) => [t.name, t])) };
}

const asText = (result) => JSON.stringify(result?.content ?? result);

/* ------------------------------------------------------------------ */

console.log(`\n=== sbx backend e2e ===`);
console.log(`workspace: ${workdir}`);
console.log(`image:     ${IMAGE}`);

const { createDockerTransport, resolveTransport, templateListHas } = await loadTs("sandbox/transport.ts");
const { createReadOps, createWriteOps, createLsOps, createBashOps } = await loadTs("sandbox/operations.ts");
const { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool } =
	await import("@earendil-works/pi-coding-agent");

try {
	docker(["rm", "-f", CONTAINER], { stdio: "ignore" });
	docker(["run", "-d", "--name", CONTAINER, "-v", `${workdir}:${workdir}`, "-w", workdir, IMAGE, "sleep", "600"]);
} catch (err) {
	console.error(`could not start the test container (is docker available?): ${err.message}`);
	process.exit(2);
}

try {
	process.env.SBX_BACKEND = "docker";
	process.env.SBX_DOCKER_CONTAINER = CONTAINER;

	const transport = createDockerTransport(CONTAINER);
	const extension = (await loadTs("sandbox/index.ts")).default;
	const { registered, commands, byName } = collectTools(extension);

	/* --- registration ------------------------------------------------ */
	console.log("\nregistration (zero added prompt cost)");
	const expectedNames = ["bash", "edit", "find", "grep", "ls", "read", "write"];
	check("registers exactly the 7 built-in tool names", JSON.stringify(registered.map((t) => t.name).sort()) === JSON.stringify(expectedNames), registered.map((t) => t.name).join(","));
	check("adds no new tool schemas", registered.length === expectedNames.length, `${registered.length} tools`);
	check("registers the /sbx status command", commands.includes("sbx"), commands.join(","));
	// Regression guard: an override built from createXTool() (wrapped AgentTool)
	// silently loses these, which deletes the built-in tool guidance from the
	// system prompt. pi builds that table from the registered tool objects.
	const missingGuidance = registered.filter((t) => !t.promptSnippet).map((t) => t.name);
	check("every override keeps its prompt snippet", missingGuidance.length === 0, `missing on: ${missingGuidance.join(",")}`);
	check("prompt guidelines survive the override", (byName.edit.promptGuidelines ?? []).length > 0, JSON.stringify(byName.edit.promptGuidelines));

	/* --- the mount assumption ---------------------------------------- */
	console.log("\nsame-path mount (the assumption the design rests on)");
	const pwd = await byName.bash.execute("t1", { command: "pwd" }, undefined, undefined, undefined);
	check("sandbox cwd equals the host path", pwd.content[0].text.trim() === workdir, pwd.content[0].text.trim());

	fs.writeFileSync(path.join(workdir, "from-host.txt"), "written on the host\n");
	const seen = await byName.bash.execute("t2", { command: "cat from-host.txt", timeout: 30 }, undefined, undefined, undefined);
	check("sandbox sees a host-written file", asText(seen).includes("written on the host"));

	const uname = await byName.bash.execute("t3", { command: "uname -s" }, undefined, undefined, undefined);
	check("bash runs in Linux, not on the host", uname.content[0].text.trim() === "Linux", uname.content[0].text.trim());

	/* --- exit codes --------------------------------------------------- */
	console.log("\nexit codes");
	let exitOk = false;
	try {
		const bad = await byName.bash.execute("t4", { command: "exit 42" }, undefined, undefined, undefined);
		exitOk = /42/.test(asText(bad));
	} catch (err) {
		exitOk = /42/.test(String(err.message));
	}
	check("a non-zero exit is surfaced to the model", exitOk);

	/* --- binary-safe file reads --------------------------------------- */
	console.log("\nfile primitives (base64 over argv, no stdin)");
	// The write *interface* is string/UTF-8 (identical to pi's local write tool),
	// so binary fidelity lives on the read path — which is what images use.
	const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x0a, 0x0d, 0xc3, 0xa9]);
	const binPath = path.join(workdir, "binary.bin");
	fs.writeFileSync(binPath, bytes); // the mount makes this visible inside the sandbox
	const roundTrip = await createReadOps(transport).readFile(binPath);
	check("arbitrary bytes read byte-exact", Buffer.compare(roundTrip, bytes) === 0, `got ${roundTrip.toString("hex")} want ${bytes.toString("hex")}`);
	check(
		"image mime detection drives the read tool's image path",
		(await createReadOps(transport).detectImageMimeType?.(path.join(workdir, "x.png"))) === "image/png",
	);

	const big = "abcdefghij".repeat(200_000); // 2 MB => several argv-sized chunks
	const bigPath = path.join(workdir, "big.txt");
	await createWriteOps(transport).writeFile(bigPath, big);
	check("multi-chunk large write is byte-exact", fs.readFileSync(bigPath, "utf8") === big, `${fs.statSync(bigPath).size} bytes`);

	/* --- routed pi tools ---------------------------------------------- */
	console.log("\nrouted pi tools");
	check("read tool returns file contents", asText(await byName.read.execute("t5", { path: path.join(workdir, "from-host.txt") }, undefined, undefined, undefined)).includes("written on the host"));

	const editResult = await byName.edit.execute(
		"t6",
		{ path: path.join(workdir, "from-host.txt"), edits: [{ oldText: "written on the host", newText: "edited in the sandbox" }] },
		undefined,
		undefined,
		undefined,
	);
	check("edit tool applied the change", fs.readFileSync(path.join(workdir, "from-host.txt"), "utf8").includes("edited in the sandbox"), asText(editResult).slice(0, 160));

	check("ls lists sandbox entries", asText(await byName.ls.execute("t7", { path: workdir }, undefined, undefined, undefined)).includes("from-host.txt"));
	check("find matches a glob", asText(await byName.find.execute("t8", { pattern: "*.txt", path: workdir }, undefined, undefined, undefined)).includes("big.txt"));
	check("grep finds a pattern", asText(await byName.grep.execute("t9", { pattern: "edited in the sandbox", path: workdir }, undefined, undefined, undefined)).includes("edited in the sandbox"));

	/* --- grep really runs inside the sandbox -------------------------- */
	console.log("\ngrep executes in the sandbox, not via host ripgrep");
	// A directory that exists ONLY inside the container's own filesystem.
	const sandboxOnly = `/opt/sbx-e2e-only-${process.pid}`;
	const marker = `marker-${process.pid}`;
	await byName.bash.execute(
		"g1",
		{ command: `mkdir -p '${sandboxOnly}' && printf '%s\\n' '${marker}' > '${sandboxOnly}/inside.txt'` },
		undefined,
		undefined,
		undefined,
	);
	check("the sandbox-only path is invisible to the host", !fs.existsSync(sandboxOnly), `host has ${sandboxOnly}`);
	const sandboxGrep = await byName.grep.execute("g2", { pattern: marker, path: sandboxOnly }, undefined, undefined, undefined);
	check("grep finds a file only the sandbox can see", asText(sandboxGrep).includes(marker), asText(sandboxGrep).slice(0, 200));

	const contextGrep = await byName.grep.execute(
		"g3",
		{ pattern: marker, path: sandboxOnly, context: 1, literal: true },
		undefined,
		undefined,
		undefined,
	);
	check("literal + context grep returns the match", asText(contextGrep).includes("inside.txt"), asText(contextGrep).slice(0, 200));

	/* --- sandbox env hygiene ------------------------------------------ */
	console.log("\nsandbox env hygiene");
	const secret = `leak-me-${process.pid}`;
	process.env.SBX_E2E_SECRET = secret;
	const leaked = await byName.bash.execute("e1", { command: "printf '%s' \"$SBX_E2E_SECRET\"" }, undefined, undefined, undefined);
	check("host secrets are NOT exported into the sandbox", !leaked.content[0].text.includes(secret), leaked.content[0].text.slice(0, 80));

	let captured = "";
	await createBashOps(transport, { allowEnv: (name) => name.startsWith("PI_") }).exec(
		"printf '%s' \"$PI_MODEL:$SBX_E2E_SECRET\"",
		workdir,
		{
			onData: (chunk) => {
				captured += chunk.toString();
			},
			env: { PI_MODEL: "kept", SBX_E2E_SECRET: secret },
		},
	);
	check("PI_* session metadata is forwarded", captured.includes("kept"), captured);
	check("non-PI environment is dropped", !captured.includes(secret), captured);
	delete process.env.SBX_E2E_SECRET;

	/* --- find pruning -------------------------------------------------- */
	console.log("\nfind pruning");
	const nmDir = path.join(workdir, "node_modules", "pkg");
	fs.mkdirSync(nmDir, { recursive: true });
	fs.writeFileSync(path.join(nmDir, "buried.txt"), "x");
	const pruned = await byName.find.execute("f1", { pattern: "buried.txt", path: workdir }, undefined, undefined, undefined);
	check("find does not enumerate node_modules", !asText(pruned).includes("buried.txt"), asText(pruned).slice(0, 160));

	/* --- .gitignore fidelity + path errors ---------------------------- */
	console.log("\n.gitignore fidelity (git-index enumeration)");
	let gitAvailable = true;
	try {
		docker(["exec", CONTAINER, "sh", "-c", "apt-get update -qq && apt-get install -y -qq git"], { stdio: "ignore" });
	} catch {
		gitAvailable = false;
		console.log("  (git unavailable in the test image — skipping the git-index assertions)");
	}

	fs.mkdirSync(path.join(workdir, "ignored"), { recursive: true });
	fs.writeFileSync(path.join(workdir, ".gitignore"), "ignored/\nnode_modules/\n*.log\n");
	fs.writeFileSync(path.join(workdir, "ignored", "secret.txt"), "hidden-needle\n");
	fs.writeFileSync(path.join(workdir, "debug.log"), "hidden-needle\n");
	fs.writeFileSync(path.join(workdir, "visible.txt"), "hidden-needle\n");
	if (gitAvailable) {
		await byName.bash.execute("gi0", { command: "git init -q" }, undefined, undefined, undefined);

		const ignoredGrep = await byName.grep.execute("gi1", { pattern: "hidden-needle", path: workdir }, undefined, undefined, undefined);
		const grepText = asText(ignoredGrep);
		check("grep finds the non-ignored file", grepText.includes("visible.txt"), grepText.slice(0, 200));
		check("grep skips a .gitignore'd directory", !grepText.includes("secret.txt"), grepText.slice(0, 200));
		check("grep skips a .gitignore'd file pattern", !grepText.includes("debug.log"), grepText.slice(0, 200));

		const ignoredFind = await byName.find.execute("gi2", { pattern: "*.txt", path: workdir }, undefined, undefined, undefined);
		const findText = asText(ignoredFind);
		check("find honours .gitignore too", findText.includes("visible.txt") && !findText.includes("secret.txt"), findText.slice(0, 200));
		check("find no longer surfaces node_modules", !findText.includes("buried.txt"), findText.slice(0, 200));
	}

	let missingError = "no-error";
	try {
		await byName.grep.execute("gi3", { pattern: "x", path: path.join(workdir, "does-not-exist") }, undefined, undefined, undefined);
	} catch (err) {
		missingError = String(err.message);
	}
	check("grep on a missing path errors instead of claiming no matches", /not found/i.test(missingError), missingError.slice(0, 120));

	/* --- context coalescing ------------------------------------------- */
	console.log("\noverlapping context windows");
	fs.writeFileSync(path.join(workdir, "coalesce.txt"), "needle-1\nneedle-2\nneedle-3\n");
	const coalesced = await byName.grep.execute(
		"c1",
		{ pattern: "needle", path: path.join(workdir, "coalesce.txt"), context: 2 },
		undefined,
		undefined,
		undefined,
	);
	const needleCount = (asText(coalesced).match(/needle-/g) ?? []).length;
	check("each line is emitted once despite overlapping windows", needleCount === 3, `${needleCount} occurrences`);

	/* --- round-trip economy ------------------------------------------- */
	console.log("\nls round-trip economy");
	const lsDir = path.join(workdir, "many");
	fs.mkdirSync(lsDir, { recursive: true });
	for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(lsDir, `f${i}.txt`), "x");
	let calls = 0;
	const counting = {
		kind: "docker",
		target: CONTAINER,
		exec: (argv, opts) => {
			calls++;
			return transport.exec(argv, opts);
		},
	};
	const lsOps = createLsOps(counting);
	await lsOps.exists(lsDir);
	const rootStat = await lsOps.stat(lsDir);
	const entries = await lsOps.readdir(lsDir);
	for (const name of entries) await lsOps.stat(path.join(lsDir, name));
	check("a 25-entry listing costs <= 4 sandbox round-trips", calls <= 4, `${calls} calls`);
	check("listing returned every entry", entries.length === 25, `${entries.length} entries`);
	check("the listed directory is reported as a directory", rootStat.isDirectory() === true);
	check("entries are reported as files", (await lsOps.stat(path.join(lsDir, "f0.txt"))).isDirectory() === false);

	/* --- degradation: sbx absent -------------------------------------- */
	console.log("\ndegradation when no sandbox is available");
	process.env.SBX_BACKEND = "sbx";
	delete process.env.SBX_DOCKER_CONTAINER;
	delete process.env.PI_SBX_SANDBOX;

	const degraded = collectTools((await loadTs("sandbox/index.ts")).default);
	check("still registers the 7 tools", degraded.registered.length === expectedNames.length);
	let localOk = false;
	try {
		const out = await degraded.byName.bash.execute("t10", { command: "echo local-fallback" }, undefined, undefined, undefined);
		localOk = asText(out).includes("local-fallback");
	} catch (err) {
		localOk = /local-fallback/.test(String(err.message));
	}
	check("pi keeps working with local tools instead of breaking", localOk);
	check("the degradation is advertised to sibling extensions", process.env.PI_SBX_SANDBOX === undefined);

	/* --- project-scoped sandbox naming --------------------------------- */
	console.log("\nproject-scoped sandbox naming (the startup-time fix)");
	const { defaultProjectSandbox } = await loadTs("sandbox/transport.ts");
	const fixture = path.join(os.tmpdir(), `sbx-name-${process.pid}`);
	fs.mkdirSync(path.join(fixture, ".git"), { recursive: true });
	fs.mkdirSync(path.join(fixture, "packages", "app"), { recursive: true });
	fs.mkdirSync(path.join(fixture, "other", ".git"), { recursive: true });

	delete process.env.DOCKER_SANDBOX;
	delete process.env.SBX_EPHEMERAL;
	const first = defaultProjectSandbox(fixture);
	delete process.env.DOCKER_SANDBOX;
	const second = defaultProjectSandbox(fixture);
	check("derives a stable per-project name", Boolean(first) && first === second, `${first} vs ${second}`);
	check("name is a valid sandbox name", /^pi-sbx-[A-Za-z0-9._+-]+-[0-9a-f]{8}$/.test(first ?? ""), String(first));

	delete process.env.DOCKER_SANDBOX;
	const fromSubdir = defaultProjectSandbox(path.join(fixture, "packages", "app"));
	check("a subdirectory resolves to the SAME sandbox", fromSubdir === first, `${fromSubdir} vs ${first}`);

	delete process.env.DOCKER_SANDBOX;
	const otherProject = defaultProjectSandbox(path.join(fixture, "other"));
	check("a different project gets a different sandbox", otherProject !== first, `${otherProject} vs ${first}`);

	process.env.DOCKER_SANDBOX = "my-pinned";
	check("an explicit DOCKER_SANDBOX wins", defaultProjectSandbox(fixture) === "my-pinned", String(process.env.DOCKER_SANDBOX));
	check("an explicit name is never overwritten", process.env.DOCKER_SANDBOX === "my-pinned");

	delete process.env.DOCKER_SANDBOX;
	process.env.SBX_EPHEMERAL = "1";
	check(
		"SBX_EPHEMERAL=1 restores per-session sandboxes",
		defaultProjectSandbox(fixture) === undefined && process.env.DOCKER_SANDBOX === undefined,
		String(process.env.DOCKER_SANDBOX),
	);
	delete process.env.SBX_EPHEMERAL;
	fs.rmSync(fixture, { recursive: true, force: true });

	/* --- keepalive + session lifecycle --------------------------------- */
	console.log("\nkeepalive and session lifecycle");
	process.env.SBX_BACKEND = "sbx";
	delete process.env.SBX_DOCKER_CONTAINER;
	delete process.env.DOCKER_SANDBOX_KEEPALIVE;
	try {
		await resolveTransport();
	} catch {
		/* sbx is absent here — expected; the env defaulting happens first */
	}
	check("keepalive defaults ON for the sbx backend", process.env.DOCKER_SANDBOX_KEEPALIVE === "1", String(process.env.DOCKER_SANDBOX_KEEPALIVE));

	process.env.DOCKER_SANDBOX_KEEPALIVE = "0";
	try {
		await resolveTransport();
	} catch {
		/* expected */
	}
	check("an explicit KEEPALIVE=0 still wins", process.env.DOCKER_SANDBOX_KEEPALIVE === "0", String(process.env.DOCKER_SANDBOX_KEEPALIVE));

	process.env.DOCKER_SANDBOX_KEEPALIVE = "1";
	process.env.DOCKER_SANDBOX_TEARDOWN = "none"; // no stray teardown attempt
	process.env.DOCKER_SANDBOX_GC_HOURS = "0"; // skip the startup sweep
	process.env.DOCKER_SANDBOX_DEBUG = "1"; // lifecycle notes are debug-gated (silent in the TUI by default)
	const { armSessionLifecycle } = await loadTs("index.ts");
	const lifecycleLog = [];
	const realError = console.error;
	console.error = (...args) => lifecycleLog.push(args.join(" "));
	await armSessionLifecycle();
	await armSessionLifecycle();
	console.error = realError;
	check(
		"session lifecycle arms exactly once (idempotent)",
		lifecycleLog.filter((line) => /watchdog armed/.test(line)).length === 1,
		lifecycleLog.join(" | ").slice(0, 160),
	);
	delete process.env.DOCKER_SANDBOX_TEARDOWN;
	delete process.env.DOCKER_SANDBOX_GC_HOURS;
	delete process.env.DOCKER_SANDBOX_DEBUG;

	/* --- lightweight template handshake -------------------------------- */
	console.log("\nlightweight template handshake");
	const tag = "pi-sbx-lite:1a2b3c4d";
	const fullRef = `docker.io/library/${tag}`;
	// Both `sbx template ls` layouts the existing sbxpi detector had to cope with.
	const tableLayout = [
		"REPOSITORY                        TAG",
		"docker.io/docker/sandbox-templates  shell",
		`docker.io/library/pi-sbx-lite      1a2b3c4d`,
	].join("\n");
	const flatLayout = ["docker.io/docker/sandbox-templates:shell", fullRef].join("\n");
	check("parses the table layout", templateListHas(tableLayout, tag) === true);
	check("parses the flat layout", templateListHas(flatLayout, tag) === true);
	check("does not match a different version", templateListHas(tableLayout, "pi-sbx-lite:deadbeef") === false);
	check("does not match an unrelated template", templateListHas(tableLayout, "pi:v1") === false);
	// A stock row must never be mistaken for ours (the bug the basename match exists to avoid).
	check(
		"never matches the stock base row by accident",
		templateListHas("docker.io/docker/sandbox-templates  shell", "pi-sbx-lite:1a2b3c4d") === false,
	);

	// The handshake must never be the reason a session fails.
	process.env.SBX_BACKEND = "sbx";
	delete process.env.SBX_DOCKER_CONTAINER;
	const stateDir = path.join(os.tmpdir(), `pi-sbx-lite-test-${process.pid}`);
	fs.mkdirSync(path.join(stateDir, "pi-sbx-lite"), { recursive: true });
	process.env.XDG_CACHE_HOME = stateDir;

	delete process.env.DOCKER_SANDBOX_TEMPLATE;
	try {
		await resolveTransport();
	} catch {
		/* sbx absent, expected */
	}
	check("no recorded template => no template is forced", process.env.DOCKER_SANDBOX_TEMPLATE === undefined, String(process.env.DOCKER_SANDBOX_TEMPLATE));

	// A recorded ref that cannot be verified (no sbx here) must be ignored, not trusted.
	fs.writeFileSync(path.join(stateDir, "pi-sbx-lite", "template-ref"), `${fullRef}\n`);
	try {
		await resolveTransport();
	} catch {
		/* expected */
	}
	check(
		"an unverifiable recorded template degrades to the stock base",
		process.env.DOCKER_SANDBOX_TEMPLATE === undefined,
		String(process.env.DOCKER_SANDBOX_TEMPLATE),
	);

	// An explicit setting is never overridden by the recorded one.
	process.env.DOCKER_SANDBOX_TEMPLATE = "my-explicit:v9";
	try {
		await resolveTransport();
	} catch {
		/* expected */
	}
	check("an explicit DOCKER_SANDBOX_TEMPLATE wins", process.env.DOCKER_SANDBOX_TEMPLATE === "my-explicit:v9", String(process.env.DOCKER_SANDBOX_TEMPLATE));
	delete process.env.DOCKER_SANDBOX_TEMPLATE;
	delete process.env.XDG_CACHE_HOME;

	/* --- tooling reachable inside the sandbox ------------------------- */
	console.log("\ninfo");
	const dockerInside = await byName.bash.execute("t11", { command: "command -v docker || echo none" }, undefined, undefined, undefined);
	console.log(`  docker inside the test container: ${dockerInside.content[0].text.trim()}`);
	console.log(`  (an sbx sandbox always has its own docker daemon — that is why routing bash`);
	console.log(`   makes the docker_* deploy tools redundant)`);
} finally {
	try {
		docker(["rm", "-f", CONTAINER], { stdio: "ignore" });
	} catch {}
	fs.rmSync(workdir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
