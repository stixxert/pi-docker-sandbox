# Isolation model & verification

This extension is designed so a pi agent's docker reach is **confined to its
own sandbox microVM** and the host's docker is never exposed to it.

## Threat model

- **Agent is untrusted at the docker layer.** It may try to reach any docker
  daemon it can find, read host config, or escape its sandbox.
- **Host user is trusted.** The host runs Docker Sandboxes (`sbx`), which
  isolate each sandbox as a microVM with its own kernel.
- Out of scope: an agent that compromises the host OS itself (that would
  bypass any docker-level control — the sandbox is not a host security
  boundary, it is a docker-access boundary).

## Design guarantees (by construction)

1. **Transport: `sbx` only.** The extension imports only
   `node:child_process/fs/path` and invokes `sbx exec <sandbox> -- docker ...`.
   It never opens a docker socket, never speaks the Docker Engine HTTP API,
   and never invokes a host `docker` binary. There is no code path that can
   fall back to a host daemon.
2. **Env scrubbing.** Before any `sbx exec`, all `DOCKER_*` and `COMPOSE_*`
   variables are removed from the child environment. A leaked `DOCKER_HOST`
   or `DOCKER_CONTEXT` on the host cannot redirect the inner docker CLI.
3. **Daemon pinning.** Every inner docker invocation is pinned with
   `-H unix:///var/run/docker.sock`, i.e. the sandbox's own daemon.
4. **Per-session sandboxes.** Each pi session gets a uniquely named sandbox
   (`pi-sbx-<pid>-<random>`, or an explicit `DOCKER_SANDBOX`), auto-provisioned
   with only the session's workspace mounted. Two concurrent sessions cannot
   share or observe each other's docker state. (The execution backend below
   pins a per-project name instead, which makes the sandbox project-scoped and
   no longer removed at exit — see that section.)
5. **Filesystem.** Only the session workspace (the dir mounted at `/workspace`
   in the agent VM) is direct-mounted into the sandbox. Host `~/.docker`,
   `~/.ssh`, `~/.agent`, and other host paths are not mounted. Path mapping is
   confined to the workspace: `/workspace/..` traversal, absolute host paths,
   and symlinks that point outside the workspace are all rejected
   (`mapHostPath`), so the agent cannot reach host paths outside the mounted
   workspace via build contexts, volume binds, or `docker_init`.
6. **Env confidentiality (secure by default).** `DOCKER_*`/`COMPOSE_*` are
   always stripped from every child env. By default only a minimal safe set
   (`HOME`, `PATH`, `USER`, `LOGNAME`, `TMPDIR`, `SHELL`, `LANG`, `TERM`) is
   forwarded. Opt in precisely with `DOCKER_SANDBOX_ENV_ALLOWLIST="A,B"`
   (adds exactly `A`,`B`), or opt out entirely with
   `DOCKER_SANDBOX_ENV_PASSTHROUGH=1` (host env minus the docker vars).
   Anything running inside the sandbox can read whatever reaches it — this
   knob confines that surface.
7. **Input validation.** Tool arguments that reach the docker CLI positionally
   (container ids, image refs, tags, names) are validated to reject values that
   start with `-` (which docker would parse as flags) or contain control
   characters. `docker_run` validates port/volume/memory specs, and
   `docker_curl` is restricted to a safe HTTP-method allowlist and a 1 MiB body
   limit.

### Read-only workspace mode (`DOCKER_SANDBOX_WORKSPACE_RO=1`)

sbx requires the primary workspace to be rw, so in this mode the extension
creates a small scratch primary (`~/.sbx-prime-<sandbox>`) and mounts the
project as an **additional read-only** workspace. Consequences (all verified):

- Writes from inside the sandbox to the project fail (`Read-only file system`).
- `docker build` from the project context still works (the daemon only reads
  the context; build cache lives in the sandbox VM).
- `docker compose up --build` works.
- Bind mounts sourced from the project are read-only in containers (the
  extension appends `:ro` automatically); containers cannot modify project
  files.
- All project writes must go through the agent's own tools (`/workspace` in
  its VM) — the intended trust boundary. The sandbox becomes a pure
  read-and-execute environment for the project.

Read-only mode is **not** usable together with the execution backend below:
that backend's `write`/`edit`/`mkdir` operate on the mounted project, so they
would simply fail.

## Execution backend (built-in tools routed into the sandbox)

The `sandbox/` entry point uses the *same* sandbox differently: pi stays on the
host and `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` plus the user's
`!` commands execute **inside** it (see [sandbox/README.md](sandbox/README.md)).
It protects a different thing, so it carries its own guarantees:

1. **The host environment does not leak in.** pi's `bash` tool builds its child
   environment from the *full* host environment, so forwarding it verbatim
   would copy host API keys and tokens into the sandbox. Only `PI_*` session
   metadata is forwarded (plus names listed in `DOCKER_SANDBOX_ENV_ALLOWLIST`),
   and `DOCKER_*`/`COMPOSE_*` can never be allowlisted. Covered by a test.
2. **The agent's file access is confined to the sandbox.** Because the file
   tools are overridden, not just the shell, an absolute path resolves inside
   the sandbox — no built-in tool can read or write a host path outside the
   mounted workspace.
3. **No shell-injection surface.** Paths and file bodies are passed as
   *positional* arguments to `sh -c`, never spliced into the script text, so a
   path cannot be reinterpreted as shell syntax or as a CLI option.
4. **`grep` is reimplemented over the transport.** pi's grep tool spawns host
   ripgrep regardless of custom operations; the backend walks and matches
   in-sandbox instead, so a search cannot silently read host files.

What this mode does **not** do:

- **It does not confine pi's own process.** Extension tools other than these
  built-in overrides still run on the host (subagents, `webshot`, ...). This is
  a sandbox for the tools, not a wrapper around pi.
- The sandbox has network access per its sbx network policy, and its own `/etc`,
  `/usr` and so on are readable by the agent.
- Killing the `sbx`/`docker` CLI on abort does not necessarily kill a process
  already running inside the VM.

## Live verification: `docker_verify`

The `docker_verify` tool runs a runtime audit of the sandbox and reports
PASS/FAIL with evidence for each check:

| Check | What it proves |
|-------|----------------|
| transport | only `sbx exec` is used (design assertion) |
| env scrub | no `DOCKER_*`/`COMPOSE_*` vars exist inside the sandbox (a `DOCKER_HOST_SENTINEL` is injected into the host process env and asserted absent inside the sandbox — so this tests the scrubber itself, not just the VM base env) |
| env forwarding | the active mode (strict by default / allowlist / passthrough) is reported; unless passthrough is explicitly enabled, a non-allowlisted probe var is injected into the host env and asserted absent inside the sandbox; explicit passthrough is flagged with a warning |
| daemon pinning | docker calls reach the sandbox daemon (`-H unix:///var/run/docker.sock`) |
| mounts | host docker config / host home are NOT visible inside the sandbox |
| contexts | only the sandbox's own `default` docker context is reachable |
| host socket | the host Docker Desktop socket (`~/.docker/run/docker.sock`, macOS) does not exist inside the sandbox; on Linux the canonical `/var/run/docker.sock` path is also the sandbox's own pinned socket, so that check is scoped to macOS and Linux daemon identity rests on the daemon-pinning check |
| port binds | published ports bind to host `127.0.0.1` only (sbx forwarding) |

Run it before and after deploys. If any check FAILs, treat the sandbox as
compromised and remove it (`docker_sandbox_rm` / `sbx rm <name>`).

## Lifecycle & teardown (isolation relevant)

Teardown is guaranteed by **two independent mechanisms**, so a sandbox cannot
outlive its session except by host reboot:

1. **Watchdog (primary, crash-proof).** When a session's sandbox is created
   (and at every `session_start`), a detached shell process is armed that
   polls the pi process with `kill -0`. The moment pi exits — gracefully or
   via `kill -9`/process-manager kill — the watchdog runs the teardown
   (`sbx rm --force` or `sbx stop`, retried 5x to ride out sandboxd races).
   It is spawned `detached` (own session), so process-group kills of pi do
   not take it down.
2. **`session_shutdown` hook (fast path).** On graceful exits and
   `/new`/`/resume`/`/fork` it tears down immediately without waiting for the
   watchdog poll.

Policy: `DOCKER_SANDBOX_TEARDOWN` = `remove` (default for session-scoped
sandboxes) \| `stop` \| `none` (default for pinned `DOCKER_SANDBOX` names).
Pinned/shared sandboxes are left alone unless the user opts in.

**Crash-path GC:** if the host reboots, both mechanisms die and the sandbox is
left stopped. The GC sweep (at session start and via `docker_gc`) reclaims
`pi-sbx-*` sandboxes that are stopped, not the current session's, and older
than `DOCKER_SANDBOX_GC_HOURS` (default 24h). Running sandboxes and non-pi
sandboxes are never touched.

**Manual:** `docker_sandbox_rm` removes the current session's sandbox;
`sbx rm --force <name>` from a host pane removes any sandbox.

## Known boundaries (documented, not bugs)

- The sandbox can read/write the mounted workspace — that is the deploy
  surface by design.
- A compromised sandbox could in principle attack the host through the
  workspace mount (e.g. plant files the host user later executes). Same trust
  level as any agent tooling writing to the workspace.
- `sbx` port forwarding binds `127.0.0.1` on the host; apps inside the sandbox
  are not reachable from the LAN unless the host user forwards further.
- `docker_curl` is confined to ports the sandbox itself published (it reads the
  live `sbx ports` mappings and rejects any other host-localhost port), so it
  cannot be used to probe unrelated host services on localhost.
