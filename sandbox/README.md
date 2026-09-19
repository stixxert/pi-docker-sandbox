# sbx execution backend

Run **pi on the host** with its built-in tools executed **inside a Docker
Sandbox** (`sbx`) — the same shape as pi's
[Gondolin example](https://github.com/earendil-works/pi-mono), except the
sandbox is an sbx microVM instead of a local QEMU VM.

```bash
cd /path/to/project
pi -e /path/to/pi-docker-sandbox/sandbox
```

That is the whole setup. There is no template to build, no pi to install
inside the sandbox, and no state to seed.

## What it routes

`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, plus the user's `!`
commands. All of them are **overrides of the built-in tools** — same names,
same schemas, same descriptions, same prompt snippets and guidelines. Only
the execution changes.

That is deliberate, and it is the whole answer to "does this cost context?":
**overriding adds zero new tool schema.** Registering an `sbx_exec` tool
instead would add tokens to the system prompt on *every turn, forever*.

The system prompt's working-directory line is rewritten to say where commands
actually run, so the model is never guessing.

## Why not run pi inside the sandbox?

Running pi inside an sbx sandbox is a bigger machine:

| | pi inside the sandbox | this extension |
|---|---|---|
| Template with `pi` npm-installed | required | **not needed** |
| Template with browser/pnpm baked | required for screenshots | optional, pi-free image is enough |
| `bootstrap-pi.sh` seeding into sandbox `~/.pi` | required | **not needed** — host `~/.pi` is the real one |
| Per-sandbox auth / sessions / model cache | required, per project | **none** — host config, host keys |
| `sbx secret` to get a model key in | required | **not needed** |
| `sbx create` + attach + type `pi` | required | one command from the project dir |
| Pick up a new pi version | rebuild the sandbox | just restart pi |

## Design notes

**Paths are identical on both sides.** `ensureSandbox()` mounts the workspace
at its host absolute path, so `/tmp/x/f.ts` is the same file inside the
sandbox. No `/workspace` translation is involved (unlike the `docker_*` tools,
which map through `mapHostPath`).

**Bytes move as base64 in argv.** `sbx exec` stdin forwarding is not
guaranteed, so file contents travel as base64 arguments (`base64 -d >
"$2"`), chunked at 384 KB per call. The `read` path base64-decodes the file so
images and any non-UTF-8 content survive intact.

**Host secrets do not enter the sandbox.** pi's built-in `bash` tool builds
the command environment from the *full* host environment, so exporting it
verbatim would copy your API keys and tokens into the sandbox, where anything
running there could read them. The backend forwards **only `PI_*` session
metadata** (plus any names you opt into with `DOCKER_SANDBOX_ENV_ALLOWLIST`),
and never `DOCKER_*`/`COMPOSE_*`. Covered by a test.

**grep is reimplemented, not re-pointed.** pi's `grep` tool spawns host
`ripgrep` for match discovery regardless of custom operations — so simply
giving it sandbox operations would scan the *host* filesystem and require
`rg` on the host. The tool is replaced wholesale by a walk-and-match over
the transport, so matches come from sandbox content.

**`.gitignore` is honoured by using git itself.** `grep`/`find` enumerate
with `git ls-files --cached --others --exclude-standard`, which is exactly
"tracked plus untracked-but-not-ignored" — so build output (`dist/`,
`.next/`, coverage) and vendored trees stay out of results, matching what
the built-in tool descriptions promise. It runs with `safe.directory=*`,
because the workspace is a mount whose owner need not match the sandbox user
(git otherwise refuses with "detected dubious ownership") — a read-only
index query, so no repo-provided code is executed. When git is unavailable
or the path is not a repo, a pruned walk is used and only `.git` and
`node_modules` are skipped.

**No shell injection surface.** Paths and file bodies are passed as
*positional* arguments to `sh -c` (`"$1"`, `"$2"`), never spliced into the
script text, so a path can never be read as shell syntax or as an option.
`shQuote()` handles the environment exports.

**Listings are one round-trip.** pi's `ls` tool calls `stat()` for every
entry; over `sbx exec` that would be N+3 sandbox round-trips per listing. A
single POSIX-sh pass returns `d`/`f` + name and is memoised for the duration
of that one tool call (verified: 25 entries => ≤ 4 round-trips).

**It degrades instead of breaking.** If `sbx` is missing or the sandbox cannot
be provisioned, the tools **fail closed** rather than silently running on the
host: the call is refused with an actionable error naming the cause and the
opt-in, the user is notified, and the system prompt says so explicitly — the
agent is never led to believe it is sandboxed when it is not. Running directly
on the host requires an explicit `DOCKER_SANDBOX_ALLOW_UNSANDBOXED=1`.

## Trying it out (before publishing)

One command, nothing installed, no settings touched:

```bash
bash sandbox/try.sh                 # auto: real sbx if usable, else a local container
bash sandbox/try.sh --sbx           # force a real Docker Sandbox
bash sandbox/try.sh --docker        # force a local container
bash sandbox/try.sh -- --model x/y  # extra args are passed to pi
```

It loads the extension with `pi -e` — exactly how `pix` loads gondolin — so the
blast radius is one pi process. Anything it creates (a container, or an sbx
sandbox) is removed on exit.

**The `--docker` path is not a toy.** It runs the *identical* ops layer with
only the `exec <target> --` verb changed, which is what makes the backend
testable on a machine that cannot run `sbx` at all (no KVM / nested virt).

### Verifying it is actually routing

Both tools are overridden, so check with something whose answer differs inside
and outside:

```bash
# bash: the container image, not your host OS
bash sandbox/try.sh --docker -- -p --tools bash "Run: cat /etc/os-release | head -1"
```

```bash
# file tools: a path that exists ONLY inside the sandbox
docker exec <container> sh -c 'echo hi > /opt/only-in-sandbox.txt'
bash sandbox/try.sh --docker -- -p --tools read "Read /opt/only-in-sandbox.txt"
```

If the first reports the container's OS and the second returns the file, the
routing works. If the extension failed to load you get a missing-tool error
instead — and if no sandbox can be resolved, tool calls are **refused** by
default rather than falling back to the host (the refusal and its opt-in are
reported in the system prompt and via `/sbx`).

### On the host, with real sbx

```bash
brew install docker/tap/sbx && sbx login     # once
cd /path/to/project
bash /path/to/pi-docker-sandbox/sandbox/try.sh
# or directly:
pi -e /path/to/pi-docker-sandbox/sandbox
```

The extension auto-provisions the sandbox. `bash template/build.sh` first if you
want the lightweight template; `try.sh` tells you when it is missing.

### Notes on loading paths

- `pi -e <file>` always works: `-e sandbox/index.ts`.
- `pi -e <dir>` needs a `pi` manifest, so `sandbox/package.json` exists for that
  (same shape as the gondolin extension).
- **Do not symlink only `sandbox/` into `~/.pi/agent/extensions/`**: the
  extension imports the shared sbx kernel from `../index.ts`, so it has to stay
  inside the repository. Point `-e` at the repo instead (or install the repo as
  a package and load the repo-relative subdirectory).

## Configuration

Reuses the `docker_*` extension's sandbox settings — the sandbox is the same
kind of object, so `DOCKER_SANDBOX` (pin a name), `DOCKER_SANDBOX_CPUS`,
`DOCKER_SANDBOX_MEMORY`, `DOCKER_SANDBOX_TEMPLATE`,
`DOCKER_SANDBOX_WORKSPACE_RO`, `DOCKER_SANDBOX_KEEPALIVE` and
`DOCKER_SANDBOX_TEARDOWN` all apply. `DOCKER_SANDBOX_WORKSPACE_RO=1` is the
interesting one here: the sandbox then sees the project read-only while your
edits go through pi's own tools.

| Variable | Effect |
|---|---|
| `SBX_BACKEND=docker` + `SBX_DOCKER_CONTAINER=<id>` | route into a container instead (testing / non-sbx hosts) |
| `DOCKER_SANDBOX_KEEPALIVE` | **default `1` here** — keeps the VM running for the life of the pi process; set `0` to allow idle-stop |
| `DOCKER_SANDBOX_ENV_ALLOWLIST` | additionally export these host vars into the sandbox shell (default: `PI_*` only) |
| `DOCKER_SANDBOX` | pin the sandbox name (also disables per-project derivation) |
| `DOCKER_SANDBOX_ALLOW_UNSANDBOXED=1` | **fail-closed default override** — permit tools to run directly on the host when no sandbox can be resolved (default: refuse) |
| `SBX_EPHEMERAL` | `1` = throwaway per-session sandbox, removed at exit |
| `SBX_PI_DEBUG` | `1` = log per-phase startup timings to stderr |
| `DOCKER_SANDBOX_TEARDOWN` | `remove` / `stop` / `none` (a per-project sandbox defaults to `none`) |

Note: `DOCKER_SANDBOX_WORKSPACE_RO=1` is **not** compatible with this backend —
the sandbox would mount the project read-only, so `write`/`edit` would fail.
The extension warns at session start if it is set.

Two variables are **exported** for sibling extensions:
`PI_SBX_SANDBOX` (sandbox name) and `PI_SBX_BACKEND` (`sbx` / `docker`).
An extension that shells out to a tool which only exists inside the sandbox
(the webdev/`webshot` toolchain, for example) can use these to detect
"host pi, but there is a sandbox" and route accordingly.

## Lifecycle

The sandbox is **one per project, reused across runs**, and stays warm for as
long as pi is running:

- **Per-project name.** The sandbox is `pi-sbx-<project>-<hash>`, derived from
the nearest VCS root (the rule `sbxpi` uses), so running pi from a
subdirectory lands in the same sandbox. A pinned name also makes teardown
`none`, which is the point — see below.
- **Keepalive is ON by default.** sandboxd stops an idle sandbox ~2–4 min after
the last `sbx` call, which would make the first tool call after a pause pay a
multi-second VM boot. A detached watchdog pokes the VM every ~60 s while pi
runs, so it never goes cold mid-session. `DOCKER_SANDBOX_KEEPALIVE=0` opts out.
- **It is not destroyed when pi exits.** The VM is idle-stopped by sandboxd (so
  it costs no memory), but the sandbox and everything in it — pulled docker
  images, installed packages — survives. The next run reuses it.
- **...and pi being killed hard is still handled.** The watchdog is detached and
  outlives pi, so keepalive/teardown bookkeeping never depends on a clean exit.
- **`SBX_EPHEMERAL=1`** restores the old behaviour: a throwaway
  `pi-sbx-<pid>-<rand>` sandbox removed at exit. Use it for one-off experiments.
- A `docker` backend target is never managed — it is caller-supplied, and no sbx
  lifecycle is armed for it.

### Startup latency (why the name matters)

A per-process name combined with teardown `remove` means **a fresh `sbx create`
on every pi run** — 10–15 s, every time, because a brand-new VM has to be
provisioned and its image layers prepared. That is the single biggest cost in
this backend and it is entirely avoidable: with the per-project name the create
happens once per project, and every later run just attaches (sub-second, plus a
VM start if it has gone cold).

To see where the time actually goes:

```bash
SBX_PI_DEBUG=1 pi -e /path/to/pi-docker-sandbox/sandbox

[sbx] template: 210ms
[sbx] ensure sandbox (create if missing): 13800ms     ← first run: it is creating
[sbx] backend=sbx sandbox=pi-sbx-myapp-1a2b3c4d template=stock base keepalive=1 total=14100ms

# second run, same project:
[sbx] template: 190ms
[sbx] ensure sandbox (create if missing): 640ms
[sbx] backend=sbx sandbox=pi-sbx-myapp-1a2b3c4d template=stock base keepalive=1 total=830ms
```

Resolving the sandbox also happens **in the background**: `session_start` does
not await it, so pi's prompt is usable immediately and the cost overlaps with
you reading it instead of gating it. The first tool call awaits the same
memoised promise.

`/sbx` prints the active backend, target and whether the sandbox is
project-scoped.

## Known limitations

- **Timeouts, not cancellation, for file tools.** pi's `*Operations`
  interfaces (other than `BashOperations`) do not receive an `AbortSignal`,
  so a wedged `sbx exec` is bounded by a 120 s timeout rather than cancelled
  by Esc. `bash` gets a real signal and is killed on abort.
- **Processes started inside the sandbox survive an abort.** Killing the
  `sbx`/`docker` CLI's process group does not reach a process already running
  inside the VM; a runaway dev server there lives until the sandbox is torn
  down (or `SBX_BACKEND=docker`'s container is stopped).
- **Names containing newlines** are not representable in the directory
  listing format (the same trade-off the tools' text output already makes).
- **`.gitignore` needs git.** Without git in the sandbox, only `.git` and
  `node_modules` are skipped. sbx images ship git, so this is the exception.

## Tests

```bash
npm run typecheck
npm test          # docker_* extension: registration, guards, confinement
npm run e2e       # this backend, end-to-end against a real container
```

`sbx` cannot run in CI or in a nested sandbox (it boots microVMs through a
host hypervisor), which is exactly why the transport is pluggable: `npm run
e2e` drives the identical ops layer against a real container via
`docker exec`, and the only difference from the product path is which binary
performs `exec <target> --`.

## Relationship to the `docker_*` tools

They stay, unchanged. But note the overlap: once `bash` runs *inside* the
sandbox, `docker build` / `docker compose up` in a plain shell already hit the
sandbox's own daemon, so the `docker_*` deploy surface becomes optional sugar
rather than the only way to deploy.
