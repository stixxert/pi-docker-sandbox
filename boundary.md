# The agent ↔ sbx boundary (and what the sandbox is for)

This document defines what the Docker Sandbox is, what it is not, the exact
trust boundary between the agent's own VM and the sandbox, and how to use it —
for the **agent** and for the **human operator**.

> **Not gondolin-specific.** This extension does **not depend on gondolin**
> (pi's default agent micro-VM). It runs entirely in the host pi process and
> relies on exactly one convention: the agent's workspace is mounted at
> `/workspace`, which the extension maps to the host pi cwd
> (`/workspace/<rel>` ↔ `<host cwd>/<rel>`). That mapping is a plain
> host-side path substitution — no gondolin mechanism is involved, and the
> same applies to any pi setup that mounts the workspace at `/workspace`.
> Gondolin is used throughout this document simply as the concrete reference
> deployment.

## Topology

```
host macOS  (trusted operator)
│
├─ pi process (host) ── extension docker-sandbox.ts ── only channel to sbx
│     │  path mapping: /workspace/<rel> ↔ <host cwd>/<rel>
│     ▼
│  agent's VM (e.g. gondolin)  │        sbx microVM (Docker Sandbox)
│  └ /workspace (rw)           │        └ /Users/…/project (rw or :ro)
│     agent's tools:           │           └ private docker daemon (own images,
│     read/write/edit/bash     │              containers, volumes)
│     (sandboxed by policy)    │
└──────────────────────────────┴─────────────────────────────────────────────
   same host directory mounted in both VMs (one mount, two views)
```

## What the sandbox is FOR

- A **disposable, isolated execution environment for containerized
  workloads**: build images, run services, `docker compose up`, test deploys —
  without touching the host's docker or the agent's own VM.
- A private docker daemon per pi session, with its own images/containers/
  volumes, port-forwarded to host `localhost` only, torn down with the
  session.
- Deploy verification (health checks, logs, exec) inside a real container
  runtime.

## What the sandbox is NOT

- ❌ Not a gateway to the host's docker (Docker Desktop / colima / dockerd).
  The extension never opens a host docker socket and never invokes a host
  `docker` CLI; there is no fallback path.
- ❌ Not the place where the agent edits project files. Project files are
  written with the agent's normal tools in its own VM (`/workspace`); the
  sandbox reads them (build contexts, volume binds). With
  `DOCKER_SANDBOX_WORKSPACE_RO=1` the sandbox physically cannot modify the
  project.
- ❌ Not a sandbox for the agent's file/network access — that is the agent's
  own VM's job. The sbx sandbox only adds an isolated *docker runtime*.

## Boundary guarantees (verified)

| Property | How it's enforced |
|---|---|
| Agent's docker reach = its own sandbox only | Every tool derives the sandbox name from the session (`pi-sbx-<pid>-<random>`, or an explicit `DOCKER_SANDBOX`); no tool accepts a foreign sandbox name; `sbx` CLI and host docker socket are absent from the agent's VM |
| One sandbox per session | Deterministic per-session name + auto-provision once; `docker_sandbox_rm` removes only that one; GC touches only stale `pi-sbx-*` sandboxes (never running ones, never non-pi ones) |
| No host docker access | Transport is `sbx exec` only; `DOCKER_*`/`COMPOSE_*` env scrubbed; inner docker pinned via `-H unix:///var/run/docker.sock` |
| Host env confidentiality | `DOCKER_*`/`COMPOSE_*` always stripped; secure by default (only a minimal safe set is forwarded); `DOCKER_SANDBOX_ENV_ALLOWLIST` opts in to specific vars, `_PASSTHROUGH` opts out entirely; `docker_verify` audits the active mode |
| Host files untouched | Only the session workspace is mounted into the sandbox; host `~/.docker`, `~/.ssh` etc. are not visible (audited by `docker_verify`) |
| Project writes (optional) | `DOCKER_SANDBOX_WORKSPACE_RO=1` → project mounted read-only; all project writes must go through the agent's own tools |
| Ports | Published on host `127.0.0.1` only (`sbx ports`); the agent probes them with `docker_curl` (host-side fetch, confined to ports this sandbox published); the agent's VM cannot reach host loopback |

## Ports & networking (verified rules)

1. **Publishing is explicit**: sbx does not auto-forward docker `-p`
   mappings. The extension calls `sbx ports <sandbox> --publish H:C` after
   `docker_run`/`docker_compose up` and reports the host URL
   (`http://127.0.0.1:<hostport>/`). Compose port discovery reads both the
   legacy `Ports` string and the structured `Publishers` array from
   `docker compose ps --format '{{json .}}'`. `docker_rm` and
   `docker_compose down` unpublish the container's mappings again (sbx would
   otherwise leave stale mappings that answer with connection resets).
2. **Host port ≥ 1024**: ports < 1024 are privileged in macOS/Unix for ANY
   non-root process (`PermissionError: Errno 13`), not an sbx limitation.
   Irrelevant for dev (dev servers use 3000/8080/…); only matters when
   reproducing production URLs without a port number. Workaround if ever
   needed: `sudo pfctl` port redirect or a reverse proxy on a high port.
3. **Avoid container port 80**: the sandbox's port proxy resets connections
   to container port 80 (verified with node, busybox httpd, nginx). Use
   container ports like 3000/8080/8000 (the `docker_init` templates do); for
   images that listen on 80 by default (e.g. nginx), reconfigure them — for
   dev this is a one-line config change and the host URL is unaffected (the
   host port is what appears in the URL).
4. **UDP**: works. `sbx ports` accepts `H:C/udp`, and a host→sandbox UDP
   round-trip was verified (node dgram echo server). Use `ports=["5000:5000/udp"]`.
5. **Idle-stop**: sandboxd stops sandbox VMs ~2–4 minutes after the last
   `sbx exec` client disconnects (not configurable via `sbx` CLI). Services
   with `restart=unless-stopped` (the extension's default for detached runs)
   come back on the next exec; `sbx ports` mappings survive. For
   leave-it-running flows set `DOCKER_SANDBOX_KEEPALIVE=1` (the watchdog
   pokes the sandbox every ~60s while the pi session is alive).
6. **Verification paths**:
   - Agent → `docker_curl http://127.0.0.1:<hostport>/` (host-side fetch;
     GET/POST/PUT with optional body; only ports this sandbox published are
     reachable).
   - Sandbox-internal → `docker_exec` against `127.0.0.1:<port>` (same docker
     network).
   - Human → open `http://localhost:<hostport>/` on the host.

## How the AGENT should use it

- Run `docker_status` first; then deploy with
  `docker_init` → `docker_build` → `docker_run`/`docker_compose`.
- Verify what you started: `docker_curl` (host), `docker_logs`, `docker_exec`.
- Do not attempt to reach the host's docker (there is no path), and do not
  invent sandbox names — the session sandbox is `sessionSandboxName()` and
  every tool targets it.
- Use non-80 container ports and ≥1024 host ports.
- Clean up: `docker_rm`/`docker_compose down` for containers;
  `docker_sandbox_rm` for the whole sandbox; `docker_gc` for stale ones.

## How the HUMAN should use it

- Prereqs: `sbx` CLI (`brew install docker/tap/sbx`), `sbx login`, `sandboxd`
  running (`sbx daemon status`). Docker Desktop is NOT needed.
- The sandbox is auto-provisioned on first use; manage it with
  `sbx ls` / `sbx stop <name>` / `sbx rm --force <name>`.
- Tune via env: `DOCKER_SANDBOX` (pin a name), `DOCKER_SANDBOX_TEARDOWN`
  (`remove`/`stop`/`none`), `DOCKER_SANDBOX_WORKSPACE_RO=1`,
  `DOCKER_SANDBOX_GC_HOURS`, `DOCKER_SANDBOX_CPUS`/`_MEMORY`, and env
  confinement: `DOCKER_SANDBOX_ENV_ALLOWLIST="A,B"` (opt in) /
  `DOCKER_SANDBOX_ENV_PASSTHROUGH=1` (opt out of the secure default).
- A sandbox is a dev/test environment, not a security boundary against the
  host user; the workspace mount is the only host surface it sees.

## Resources & failure modes (how the agent finds out, what to do)

The sandbox has fixed limits set at creation (`DOCKER_SANDBOX_CPUS`, default 2;
`DOCKER_SANDBOX_MEMORY`, default 2g). The agent is notified of pressure in two
ways:

1. **Indirect (always):** docker tool calls surface it — builds fail with
   no-space errors, `docker_ps` shows `Exited (137)` / `Restarting (137)`
   (OOM-kill), pulls time out. The extension now has a 120s default timeout on
   sandbox calls so an OOM-hung VM fails the tool call instead of hanging the
   turn.
2. **Direct (new):** `docker_resources` reports VM memory/cpu/disk, docker disk
   (images/containers/build cache), and per-running-container cpu/mem, and
   warns above 85% memory or disk. Run it when deploys fail or containers exit
   abnormally.

Remediation ladder (in the agent's toolset):

| Symptom | Action |
|---|---|
| High memory / OOM kills | `docker_rm`/`docker_stop` heavy containers; cap them with `docker_run(memory=…)`; raise `DOCKER_SANDBOX_MEMORY` and recreate (`docker_sandbox_rm` → next call re-provisions) |
| High disk / no-space builds | `docker_prune` (optionally `volumes=true`) |
| Container restart-looping on OOM | `docker_stop` it; use `restart=no` for memory-capped containers (restart policy + cap = infinite restart loop) |
| VM unresponsive (sandboxd OOM) | `sbx ls`/`sbx stop <name>` from a host pane, or `docker_sandbox_rm` + recreate with bigger limits |

Caveat: resources are fixed at sandbox creation — changing `DOCKER_SANDBOX_CPUS`/
`_MEMORY` requires recreating the sandbox (session-scoped sandboxes are
recreated automatically on the next `docker_*` call after removal).

## Known limitations / areas to look into

- **Container port 80** and **host ports < 1024** do not forward (see above);
  both are dev-irrelevant with the documented workarounds.
- **Idle-stop**: sandboxd stops idle sandbox VMs ~2–4 min after the last sbx
  call (not configurable); services auto-recover via `restart=unless-stopped`,
  or keep the VM up with `DOCKER_SANDBOX_KEEPALIVE=1`.
- **Host reboot** kills both teardown mechanisms; cleanup happens via the GC
  at the next session start, or manually with `sbx rm --force $(sbx ls -q | grep pi-sbx)`.
- **GC is sibling-safe**: every session writes an owner marker
  (`<name>.pi-owner` with its pid) next to the sandbox state; the GC only
  removes stopped `pi-sbx-*` sandboxes whose owner process is dead. Concurrent
  sessions never reap each other's sandboxes, even with
  `DOCKER_SANDBOX_GC_HOURS=0` (verified). Edge case: if the OS reuses a dead
  session's pid, that stale sandbox lingers until manual cleanup — rare (needs
  a crashed session whose teardown also failed) and harmless.
- **Concurrent sessions** each get their own sandbox; published host ports
  must be unique across sessions (a taken host port falls back to an
  ephemeral port).
- **Image pulls repeat per session** (each sandbox is a fresh VM). Pre-bake a
  template to fix: `sbx template save <name>` from a sandbox with the images
  pre-pulled, then set `DOCKER_SANDBOX_TEMPLATE=<name>` (or pass `--template`
  to `sbx create`). Check `sbx template save --help` for exact syntax.
- sbx itself (VM kernel, port proxy, idle-stop) is Docker's product; its
  quirks above are tracked here so behavior changes are noticed.
