#!/usr/bin/env bash
#
# build.sh — build the LIGHTWEIGHT sandbox template, automatically.
#
#   bash template/build.sh            # build if missing/stale, else no-op (fast)
#   bash template/build.sh --check    # report status, change nothing
#   bash template/build.sh --ref      # print the template ref, or nothing
#   bash template/build.sh --force    # rebuild even if the current one exists
#
# Design goal: **the user never runs anything and never sees a failure.**
#
#   * Idempotent and cheap when current: a single `sbx template ls` decides
#     whether to do anything, so it is safe to call on every launch.
#   * The tag embeds a hash of the recipe, so editing install.sh produces a NEW
#     template instead of silently reusing a stale snapshot.
#   * Self-verifying, like the pi template builder it replaces: after saving, it
#     boots a throwaway sandbox FROM THE SAVED TEMPLATE and asserts the tools are
#     really there. A template that silently lacks node/pnpm/git can't be
#     produced.
#   * Records the resolved ref where the extension looks for it, so the sandbox
#     starts using it with no configuration. If that file is missing or the
#     template is gone, the extension simply creates sandboxes from the stock
#     base — degraded, never broken.
#
# What it does NOT contain: pi (pi runs on the HOST now and routes its tools in),
# editors for pi, or language toolchains nobody asked for. See install.sh.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${SBX_LITE_BASE:-docker.io/docker/sandbox-templates:shell}"

# Portability: macOS has shasum, Linux has sha256sum.
if command -v sha256sum >/dev/null 2>&1; then
	HASHER="sha256sum"
else
	HASHER="shasum -a 256"
fi

# NOTE the braces: `cat f; echo x | hash` would pipe ONLY the echo and let the
# cat output leak into the captured value (giving a tag containing the entire
# recipe). The whole group must be the pipeline's input.
RECIPE_HASH="$( { cat "$HERE/install.sh"; printf 'base=%s\n' "$BASE"; } | $HASHER | cut -c1-8 )"

# A malformed tag would produce a template nobody can ever match, so fail loudly
# here rather than writing a nonsense ref that the extension then ignores.
case "$RECIPE_HASH" in
[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
*)
	echo "build: could not compute a recipe hash (got '${RECIPE_HASH:0:40}…')" >&2
	exit 1
	;;
esac

TAG="${SBX_LITE_TAG:-pi-sbx-lite:${RECIPE_HASH}}"
REF="docker.io/library/${TAG}"
STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/pi-sbx-lite"
STATE_FILE="$STATE_DIR/template-ref"

TPL_SANDBOX="pi-sbx-lite-build-$$"
VERIFY_SANDBOX="pi-sbx-lite-verify-$$"
# Build in a scratch dir, never the caller's cwd: mounting the caller's project
# into the snapshot would bake project files into the shared image.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pi-sbx-lite.XXXXXX")"

MODE="ensure"
case "${1:-}" in
--check) MODE="check" ;;
--ref) MODE="ref" ;;
--force) MODE="force" ;;
"") ;;
*)
	echo "usage: $0 [--check|--ref|--force]" >&2
	exit 2
	;;
esac

cleanup() {
	rm -rf "$SCRATCH"
	sbx rm --force "$TPL_SANDBOX" >/dev/null 2>&1 || true
	sbx rm --force "$VERIFY_SANDBOX" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# `sbx template ls` differs between sbx versions (table vs flat), so match on the
# repository basename + version rather than on a column position — the same
# approach the existing pi-template detector needed.
template_present() {
	sbx template ls 2>/dev/null | awk -v tag="${TAG}" '
		{
			sub(/^[[:space:]]+/, "")
			if ($0 == "" || $0 ~ /^REPOSITORY/) next
			r = $1; sub(/^.*\//, "", r)
			if (r == tag && $2 != "") found = 1      # table row: <repo> <version>
			if ($1 == "docker.io/library/" tag) found = 1
			if (r == tag) found = 1
		}
		END { exit(found ? 0 : 1) }'
}

record_ref() {
	mkdir -p "$STATE_DIR"
	printf '%s\n' "$REF" >"$STATE_FILE"
}

case "$MODE" in
ref)
	[ -f "$STATE_FILE" ] && cat "$STATE_FILE"
	exit 0
	;;
check)
	if template_present; then
		echo "current: $REF"
		exit 0
	fi
	echo "missing: $REF (would build from $BASE)"
	exit 1
	;;
ensure)
	if template_present; then
		record_ref
		echo "template up to date: $REF"
		exit 0
	fi
	;;
force) : ;;
esac

echo "building lightweight sandbox template"
echo "  base:   $BASE"
echo "  tag:    $TAG  (recipe hash ${RECIPE_HASH})"
echo "  recipe: $HERE/install.sh"
echo

# Leftovers from an interrupted build would make `sbx create` fail.
sbx rm --force "$TPL_SANDBOX" >/dev/null 2>&1 || true
sbx template rm "$TAG" >/dev/null 2>&1 || true

echo "creating throwaway sandbox…"
sbx create -q --name "$TPL_SANDBOX" -t "$BASE" shell "$SCRATCH"

# The recipe is passed as a single argv element; no output-masking pipe, so a
# failure inside the install surfaces as a non-zero exit and `set -e` aborts.
echo "installing baseline (this is the part that takes a couple of minutes)…"
sbx exec "$TPL_SANDBOX" -- bash -lc "$(cat "$HERE/install.sh")"

echo "saving template…"
sbx template save "$TPL_SANDBOX" "$TAG" # no `|| true` — a failed save must abort
sbx rm --force "$TPL_SANDBOX" >/dev/null 2>&1 || true

# The definitive check: boot FROM THE SAVED TEMPLATE and assert the toolchain.
# Asserting in the build sandbox would prove nothing about the saved image.
echo "verifying the saved template boots with a working toolchain…"
sbx create -q --name "$VERIFY_SANDBOX" -t "$REF" shell "$SCRATCH"
sbx exec "$VERIFY_SANDBOX" -- bash -lc '
	set -e
	for c in node pnpm git rg; do
		command -v "$c" >/dev/null || { echo "verify: missing $c" >&2; exit 1; }
	done
	node -e "require(\"child_process\")" 2>/dev/null || { echo "verify: node is broken" >&2; exit 1; }
	printf "verify: node %s, pnpm %s, git %s, rg %s\n" \
		"$(node -v)" "$(pnpm -v)" "$(git --version | awk "{print \$3}")" "$(rg --version | head -1 | awk "{print \$2}")"'
sbx rm --force "$VERIFY_SANDBOX" >/dev/null 2>&1 || true

record_ref
echo
echo "done. recorded $REF in $STATE_FILE"
echo "the sandbox extension picks this up automatically; override with DOCKER_SANDBOX_TEMPLATE."
