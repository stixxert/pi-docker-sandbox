# docker-sandbox-extension

A [pi](https://pi.dev) extension that gives an AI coding agent a **private
docker sandbox** to deploy into — powered by
[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx`).

Each pi session gets its own **sandbox microVM with its own docker daemon**,
running in parallel to the agent. The agent can pull images, build, run
containers, and `docker compose up` — while the **host's docker is never
exposed to it**.

## Why

Agents that can deploy are powerful; agents that can reach your real docker
daemon are a liability. With this extension:

- Every docker operation happens inside a disposable microVM with its own
  daemon — nothing appears in the host's `docker ps`.
- The extension **never touches a host docker socket or CLI**; it only shells
  out to `sbx exec`. There is no fallback path to the host daemon.
- Docker env vars (`DOCKER_HOST`, `DOCKER_CONTEXT`, …) are scrubbed and the
  inner CLI is pinned to the sandbox daemon, so leaked host config cannot
  redirect it.
- `docker_verify` runs a live isolation audit (PASS/FAIL per check).

## Requirements

- [pi](https://pi.dev) (the extension runs in the host pi process)
- The Docker Sandboxes CLI (`sbx`) — a standalone binary; **no Docker Desktop
  required**
- A host hypervisor for `sbx` to boot microVMs on. The sandbox is a real VM
  with its own kernel, so the virtualization backend is platform-specific:
  - **macOS 14 (Sonoma)+ on Apple silicon** — uses Apple's Virtualization
    framework (Intel Macs are not supported by `sbx`)
  - **Linux x86_64 with KVM** — needs hardware virtualization and your user
    in the `kvm` group (`lsmod | grep kvm` should list `kvm_intel` /
    `kvm_amd` / `kvm_arm64`)

See [Install](#install) for one-line installs per platform.

## Install

**1. Install the `sbx` CLI** (one line per platform):

macOS — Apple silicon, Sonoma 14+:

```bash
brew install docker/tap/sbx && sbx login
```

Linux — Debian/Ubuntu x86_64 with KVM:

```bash
curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh && sudo apt-get install -y docker-sbx && sudo usermod -aG kvm "$USER" && newgrp kvm && sbx login
```

First `sbx login` opens a browser for Docker OAuth and asks you to pick a
default network policy ("Balanced" is a good default). `newgrp kvm` drops you
into a shell with the group active; log out and back in for it to stick.

**2. Install the extension** — as a pi package (recommended). The repo
declares itself via the `pi` manifest in `package.json` (loads `index.ts`),
so it installs like any pi package — from git, npm, or a local checkout:

```bash
pi install git:git@github.com:stixxert/pi-docker-sandbox
# or from npm:
pi install npm:@stixxert/pi-docker-sandbox
# or try it for a single run without installing:
pi -e git:git@github.com:stixxert/pi-docker-sandbox
# or install the checkout you're developing in:
pi install ./path/to/this/repo
```

**Manually** — the extension is a single file with no build step, so you can
copy it to one of pi's auto-discovery locations, then `/reload` in pi:

```bash
cp index.ts ~/.pi/agent/extensions/docker-sandbox.ts   # global, or
cp index.ts .pi/extensions/docker-sandbox.ts           # project-local
```

or load it directly for a quick test:

```bash
pi -e ./index.ts
```

The sandbox is **auto-provisioned on first use** (2 CPU / 2 GB, session
workspace mounted). No manual steps required.

## Tools

| Tool | Purpose |
|------|---------|
| `docker_status` | Sandbox presence, engine version, resources |
| `docker_verify` | Live isolation audit (PASS/FAIL per check) |
| `docker_resources` | VM memory/cpu/disk + docker disk + per-container usage, with warnings |
| `docker_prune` | Reclaim sandbox space (`docker system prune -af`) |
| `docker_ps` / `docker_images` | List containers / images in the sandbox |
| `docker_pull` | Pull an image into the sandbox daemon |
| `docker_run` | Run a container (ports, env, memory cap, volumes, network, restart; detach or foreground) |
| `docker_logs` / `docker_exec` | Inspect a running container |
| `docker_build` | Build an image from a workspace directory |
| `docker_init` | Scaffold a Dockerfile (+ compose) with language detection |
| `docker_compose` | Deploy/manage compose projects (`up -d --build`) |
| `docker_stop` / `docker_start` / `docker_rm` | Container lifecycle |
| `docker_curl` | Probe a published port from the host process (GET/POST/PUT; only ports this sandbox published) |
| `docker_sandbox_rm` | Remove this session's sandbox (microVM + everything inside) |
| `docker_gc` | Sweep stale `pi-sbx-*` sandboxes left by crashed sessions |

All containers get the label `com.pi.sandbox=true`.

## Multi-session sandbox naming

Each pi session gets its own sandbox named `pi-sbx-<pid>-<random>` — unique per
process, never repeats, and independent of any host environment (herdr, tmux,
terminal). Concurrent sessions never share docker state. For a stable,
persistent name (e.g. a shared sandbox reused across restarts), pin
`DOCKER_SANDBOX` explicitly.

- `DOCKER_SANDBOX` — pin an explicit (e.g. shared, persistent) sandbox name.
- `DOCKER_SANDBOX_AUTOCREATE=0` — disable auto-provisioning (create manually
  with `sbx create --name <name> shell <workspace-dir>` from a host pane).
- `DOCKER_SANDBOX_CPUS` / `DOCKER_SANDBOX_MEMORY` — resources for
  auto-created sandboxes (default `2` / `2g`; sbx minimum memory is 1 GiB,
  values below are clamped).
- `DOCKER_SANDBOX_WORKSPACE_RO=1` — mount the project **read-only** into the
  sandbox (sbx requires the primary workspace to be rw, so a small scratch
  primary is created and the project is mounted as a read-only additional
  workspace). The agent writes project files through its normal tools
  (`/workspace` in its own VM); the sandbox and any container it runs can
  only read the project — even bind mounts from it are read-only. Builds and
  compose still work; volume binds sourced from the project get `:ro` added
  automatically.
- `DOCKER_SANDBOX_KEEPALIVE=1` — keep the sandbox VM running while the pi
  session is alive (watchdog pokes it every ~60s), defeating sandboxd's
  idle-stop for leave-it-running deploy flows.
- `DOCKER_SANDBOX_TEMPLATE=<name>` — use a pre-baked `sbx template` for
  auto-created sandboxes (avoids re-pulling common images every session;
  create with `sbx template save <name>` from a prepared sandbox).

## Ports (verified rules)

- sbx does **not** auto-forward docker `-p` mappings — the extension
  explicitly publishes them (`sbx ports <sandbox> --publish H:C`) after
  `docker_run`/`docker_compose up` and reports the host URL
  (`http://127.0.0.1:<hostport>/`). `docker_rm` unpublishes again.
- **Host ports < 1024** are privileged in macOS/Unix for any non-root process
  (standard OS rule, not an sbx limitation) — irrelevant for dev (dev servers
  run on 3000/8080/…) and only matters when reproducing a production URL
  without a port number.
- **Avoid container port 80** — the sandbox's port proxy resets it (verified:
  node, busybox, nginx). Use 3000/8080/8000 (`docker_init` templates do);
  nginx-style images just need their listen port changed — the host URL is
  unaffected.
- **UDP**: `sbx ports` accepts `H:C/udp` and a round-trip was verified
  (node dgram echo); use `ports=["5000:5000/udp"]`.
- **Idle-stop**: sandboxd stops sandbox VMs ~2–4 min after the last `sbx`
  call; `docker_run` defaults detached services to `restart=unless-stopped`
  and `sbx ports` mappings survive VM restarts. For leave-it-running flows
  set `DOCKER_SANDBOX_KEEPALIVE=1`.
- **Reboot cleanup**: `docker_rm`/`docker_compose down` unpublish port
  mappings; after a host reboot let the session-start GC handle it, or run
  `sbx rm --force $(sbx ls -q | grep pi-sbx)` from a host pane.
- Agent-side verification: `docker_curl` (host-side fetch, GET/POST/PUT with
  optional body, confined to ports this sandbox published); human-side:
  `http://localhost:<hostport>/`.

See [boundary.md](boundary.md) for the full agent ↔ sbx boundary
model and usage guide (agent + human). The extension is not dependent on
gondolin — it runs in the host pi process and relies only on the
`/workspace` ↔ host-cwd path convention.

## Sandbox lifecycle

| Event | What happens |
|-------|--------------|
| First `docker_*` call | Sandbox is auto-provisioned (unique name, session workspace mounted) and a **detached watchdog** is armed on the pi process |
| Session idle | Nothing — the sandbox stays ready; `sbx exec` auto-starts the VM if it was stopped |
| Session ends (exit, Ctrl+C/D, SIGHUP/SIGTERM, `/new`, `/resume`, `/fork`) | `session_shutdown` hook runs teardown immediately (fast path) |
| Session dies hard (`kill -9`, process-manager kill) | The watchdog (which polls the pi process and survives it) performs the same teardown within seconds — no event required |
| Watchdog also missed (host reboot) | Sandbox left stopped; the GC sweep reclaims it at the next session start |
| Manual | `docker_sandbox_rm` (this session's sandbox) / `docker_gc` (stale sandboxes) |

Teardown policy (`DOCKER_SANDBOX_TEARDOWN`, default `remove` for session
sandboxes, `none` for pinned `DOCKER_SANDBOX` names):

- `remove` — delete the microVM and everything inside it (images, containers,
  volumes). State is rebuildable; nothing accumulates.
- `stop` — keep state, free memory; the VM restarts on next use.
- `none` — leave running (use for shared/persistent sandboxes).

Crash safety net: at every session start (and via `docker_gc [hours]`) the
extension sweeps sandboxes named `pi-sbx-*` that are **stopped**, not the
current session's, and older than `DOCKER_SANDBOX_GC_HOURS` (default `24`).
Note: `DOCKER_SANDBOX_GC_HOURS=0` **disables the automatic session-start
sweep**; the `docker_gc` tool still accepts `hours=0` for a manual any-age
sweep. Running sandboxes and non-pi sandboxes are never touched.

## Path mapping

The agent's VM mounts the workspace at `/workspace`; the extension maps
`/workspace/<rel>` → `<host pi cwd>/<rel>`, which is also the path inside the
sandbox (the workspace is direct-mounted there). So `docker_build` contexts
and `docker_run` volume binds "just work".

The mapping is **confined to the workspace**: `/workspace/..` traversal,
absolute host paths, and symlinks that point outside the workspace are all
rejected, so the agent cannot reach host paths outside the mounted workspace
via build contexts, volume binds, or `docker_init`.

## Example deploy flow

```
docker_status
docker_init(context=/workspace/myapp)            # scaffold Dockerfile
docker_build(context=/workspace/myapp, tag=myapp:latest)
docker_run(image=myapp:latest, name=web, ports=["8080:80"], detach=true)
docker_logs(id=web, tail=50)
docker_verify                                    # confirm isolation
docker_compose(file=/workspace/myapp/compose.yaml, action=up)
```

## Dockerfiles

Dockerfiles are ordinary files in the workspace — the agent authors/edits
them with its normal tools and builds them with `docker_build`. `docker_init`
bootstraps a sensible one for node (npm or pnpm), go, python, rust, or a
generic alpine base, plus a `.dockerignore` and optional `compose.yaml`.

## Security

See [security.md](security.md) for the threat model, design
guarantees, and the `docker_verify` check list. For maximum project
protection, set `DOCKER_SANDBOX_WORKSPACE_RO=1`: the sandbox then has the
project mounted read-only and **all** project writes flow through the agent's
own sandboxed tools instead.

## Host env forwarding (secure by default)

The extension passes **only a minimal safe set** of the pi host's environment
into the sandbox — `HOME`, `PATH`, `USER`, `LOGNAME`, `TMPDIR`, `SHELL`,
`LANG`, `TERM` (non-secret vars the `sbx` CLI and shells need). `DOCKER_*` /
`COMPOSE_*` are **always** stripped — a leaked `DOCKER_HOST` could redirect
the inner docker client. Everything else is confined by default:

- `DOCKER_SANDBOX_ENV_ALLOWLIST="A,B"` — opt in precisely: forward the
  minimal set plus exactly `A` and `B` (e.g. the vars your compose file
  interpolates with `${VAR}`). Docker-affecting vars cannot be allowlisted.
- `DOCKER_SANDBOX_ENV_PASSTHROUGH=1` — explicit opt-out: forward the host env
  minus the docker vars (raw `sbx exec` semantics, for legacy workflows that
  rely on broad compose interpolation).

Anything that runs inside the sandbox (containers, `docker_exec`'d commands)
can read whatever reaches it — so host API keys and tokens stay confined
unless you allowlist them deliberately. Prefer project-local `.env` files
(gitignored) over host-env interpolation for compose secrets.
`docker_verify` audits the active mode (`docker_status` reports it).

## Development

```sh
npm install
npm run typecheck   # strict tsc against the pi SDK types
npm test            # loads the extension with a mock pi API; no sbx needed
```

The extension is a single file with no build step — `index.ts` is loaded
directly by pi (copy it to `~/.pi/agent/extensions/docker-sandbox.ts`, or
`pi install` the repo, see [Install](#install)). `package.json` doubles as the
pi package manifest (`pi.extensions`) and declares typecheck-only dev deps;
`tsconfig.json` keeps `tsc --strict` honest against the pi SDK types.

## Releases (CI/CD)

Releases are fully automated with [semantic-release](https://semantic-release.gitbook.io/)
via GitHub Actions (`.github/workflows/release.yml`). The **commit messages
themselves signal the release**: push to `main` and CI analyzes commits since
the last release tag, then bumps the version, tags, creates a GitHub Release,
and publishes to npm — only when there is something releasable.

| Commit message | Version bump |
|---|---|
| `fix: ...` | patch (`1.0.0` → `1.0.1`) |
| `feat: ...` | minor (`1.0.0` → `1.1.0`) |
| `BREAKING CHANGE: ...` (in body or footer) | major (`1.0.0` → `2.0.0`) |
| anything else (`docs:`, `chore:`, `refactor:`, …) | no release |

One-time setup: configure **trusted publishing** on npm so the workflow can
publish via OIDC — no npm token stored anywhere. On npmjs.com → package
`@stixxert/pi-docker-sandbox` → Settings → **Trusted Publisher**, add:

- Organization or user: `stixxert`
- Repository: `pi-docker-sandbox`
- Workflow filename: `release.yml`
- Environment name: *(leave empty)*
- Allowed actions: `npm publish`

`GITHUB_TOKEN` needs no setup. The first push to `main` containing a
`fix:`/`feat:` commit publishes the initial version. Provenance attestations
are generated automatically with trusted publishing.

## License

Apache-2.0 — see [LICENSE](LICENSE).
