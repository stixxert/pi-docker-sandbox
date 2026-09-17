# Lightweight sandbox template

A minimal base image for sandboxes, built automatically. **Measured**, not
estimated — `docker build` + `du` on this machine:

| Profile | On disk | docker reports | What's in it |
|---|---|---|---|
| `core` | **383 MB** | 547 MB | git, curl, ripgrep, jq, node 22, pnpm, vim-tiny |
| `core + build` *(default)* | **648 MB** | 920 MB | the above **+** `build-essential`, `python3` (native node modules) |
| *the existing pi template* | ~2.2 GB `/usr` | — | that, **plus** pi, a global `opencode-ai`, JVM, Go, Python, Rust |

So the default profile is **~3× smaller**, and the two ingredients that account
for most of the difference are simply *not installing pi* (136 MB) and *not
shipping a second coding agent* (353 MB, `opencode-ai`), a JVM (332 MB), Go
(72 MB), Python (49 MB) and Rust (11 MB).

## Files

| File | Purpose |
|---|---|
| `install.sh` | the recipe. Contains **no `sbx` commands**, so the exact same script runs in a docker build (for measuring/CI) and inside a sandbox (for the real template) |
| `Dockerfile` | `install.sh` in docker-buildable form: `docker build -f template/Dockerfile -t sbx-lite .` |
| `build.sh` | builds the sbx template from `install.sh`, hashes the recipe into the tag, saves, **verifies**, and records the ref |

## The user does nothing

That is a hard requirement, and it drives the design:

1. **The tag is a hash of the recipe.** Editing `install.sh` produces a *new*
   template tag. A stale snapshot can never be silently reused, and no version
   bookkeeping is needed.
2. **`build.sh` is idempotent and cheap when current** — one `sbx template ls`
   decides whether there is any work, so it is safe to call on every launch
   (`bash template/build.sh`, or a launcher doing it for you). No-op: ~1 s.
3. **The builder records the ref** in
   `${XDG_CACHE_HOME:-~/.cache}/pi-sbx-lite/template-ref`.
4. **The extension adopts it automatically** — it reads that file at session
   start, *verifies the template still exists*, and uses it. No configuration.
5. **Nothing about this can fail a session.** Missing file, unreadable file,
   template deleted since it was recorded, sbx not answering, the build itself
   failing — every one of those degrades to the stock base image. The sandbox
   still works; it is simply bigger. The user is never blocked and never sees an
   error they have to act on.
6. **An explicit `DOCKER_SANDBOX_TEMPLATE` always wins**, so this is an opinion,
   not a policy.

```
first launch   → stock base (works, bigger)          [no template recorded yet]
build.sh runs  → builds + verifies, records the ref   [once, ~2 min]
later launches → lightweight template, automatically
```

## Build it

```bash
npm run template            # build if missing/stale, else no-op
npm run template:check      # report status, change nothing
bash template/build.sh --force
```

Tunables: `SBX_LITE_BASE` (base image), `SBX_LITE_TAG` (override the tag),
`NODE_VERSION`, `SBX_LITE_BUILD=off` (drop `build-essential`+`python3`, −265 MB),
`SBX_LITE_PNPM=off`.

## Verifying without `sbx`

`build.sh` needs a host that can run `sbx`. The recipe does not: it is plain
apt + curl + npm, so it can be built and **measured** anywhere docker runs.

```bash
docker build -f template/Dockerfile -t sbx-lite .
docker run --rm sbx-lite sh -c 'node -v; pnpm -v; git --version; rg --version'
docker run --rm sbx-lite du -sh /
```

## What is deliberately not here

- **pi.** With the sandbox execution backend, pi runs on the host and routes its
  tools in. Baking it into the template was 136 MB *and* a maintenance
  treadmill: every pi release invalidated the template for every project.
- **A browser.** Playwright's Chromium headless shell is ~270 MB. It is genuinely
  needed for UI work and genuinely wasted for everything else, so it belongs in a
  separate `webdev` variant, not in every sandbox.
- **Language toolchains nobody asked for.** The default profile is what an
  ordinary project needs; `build-essential` + `python3` are the one concession,
  because a failing `pnpm install` of a native module would break the
  "user does nothing" guarantee. Turn them off if your projects don't need them.

## See also

`sandbox/README.md` for the execution backend, and the repo README for how this
fits the two modes.
