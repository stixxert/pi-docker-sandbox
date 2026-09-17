#!/usr/bin/env bash
#
# try.sh — try the sbx execution backend for ONE pi run.
#
# Loads the extension with `pi -e` (the same way `pix` loads gondolin), so
# NOTHING is installed and no settings are touched. If it creates a container or
# a sandbox for you, it cleans it up again on exit.
#
#   bash sandbox/try.sh                      # auto: sbx if usable, else docker
#   bash sandbox/try.sh --docker             # force a local container
#   bash sandbox/try.sh --sbx                # force a real Docker Sandbox
#   bash sandbox/try.sh --discover           # also load your discovered extensions
#                                            # (only if none of them is a router)
#   bash sandbox/try.sh --image sbx-lite     # container image for the docker path
#   bash sandbox/try.sh --keep               # leave the container running
#   bash sandbox/try.sh -p "run uname -a"    # extra args are passed to pi
#
# Note: this extension and the gondolin extension both override the same
# built-in tools, so exactly one of them can be loaded. try.sh therefore runs pi
# with `--no-extensions` and re-adds only what is needed (this extension, plus
# env-keys for credentials). Use --discover to opt out of that.
#
# The docker path exists so the backend can be exercised on a machine without
# sbx (including inside another sandbox, where sbx cannot run). It is the same
# ops layer, only the `exec <target> --` verb differs.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$HERE/index.ts"
REPO="$(cd "$HERE/.." && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

MODE="auto"
IMAGE="${SBX_TRY_IMAGE:-debian:stable-slim}"
CONTAINER="sbx-try-$$"
KEEP=0
DISCOVER=0
PI_ARGS=()

while [ $# -gt 0 ]; do
	case "$1" in
	--docker) MODE="docker" ;;
	--sbx) MODE="sbx" ;;
	--keep) KEEP=1 ;;
	--discover) DISCOVER=1 ;;
	--image)
		IMAGE="$2"
		shift
		;;
	-h | --help)
		sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	--)
		shift
		PI_ARGS+=("$@")
		break
		;;
	*)
		# Anything else is a pi argument (e.g. -p "...", --model ...).
		PI_ARGS+=("$1")
		;;
	esac
	shift
done

cleanup() {
	if [ "$MODE" = "docker" ] && [ "$KEEP" != "1" ]; then
		docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT

# ── choose a backend ──────────────────────────────────────────────────────
if [ "$MODE" = "auto" ]; then
	if command -v sbx >/dev/null 2>&1 && sbx ls >/dev/null 2>&1; then
		MODE="sbx"
	else
		MODE="docker"
	fi
fi

if [ "$MODE" = "docker" ]; then
	command -v docker >/dev/null 2>&1 || {
		echo "try: no sbx and no docker on PATH — cannot try the backend here." >&2
		echo "try: on your host, install sbx (brew install docker/tap/sbx && sbx login) or docker." >&2
		exit 1
	}

	# Mount the project at its HOST absolute path: that identity is what the
	# whole backend relies on, so the trial must reproduce it.
	echo "try: starting container $CONTAINER from $IMAGE (project mounted at $PWD)"
	docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
	docker run -d --name "$CONTAINER" -v "$PWD:$PWD" -w "$PWD" "$IMAGE" sleep 86400 >/dev/null

	export SBX_BACKEND=docker
	export SBX_DOCKER_CONTAINER="$CONTAINER"
	echo "try: routing pi's tools into the container (docker exec)"
else
	# Real sandbox: the extension auto-provisions it on first use.
	if bash "$REPO/template/build.sh" --check >/dev/null 2>&1; then
		echo "try: lightweight template already current"
	else
		echo "try: no lightweight template yet — sandboxes will use the stock base."
		echo "try: build it once (optional, ~2 min):  bash $REPO/template/build.sh"
	fi
	echo "try: pi's tools will run in this project's sbx sandbox (auto-created)"
fi

echo "try: extension $EXT"

# ── exactly one tool router may be loaded ────────────────────────────────
# This extension and the gondolin extension both override the SAME built-ins
# (read/write/edit/bash/ls/find/grep). pi rejects whichever registers second, so
# with gondolin sitting in the global extensions dir the trial would either
# error noisily or — worse, if load order ever flips — silently run with the
# WRONG backend while appearing to work.
#
# So discovery is turned off and only what the trial needs is re-added
# explicitly. `-e` paths still load under `-ne`, which is what it is for.
EXT_ARGS=(-e "$EXT")

if [ "$DISCOVER" = "1" ]; then
	echo "try: --discover given: loading every discovered extension as well"
elif [ -d "$AGENT_DIR/extensions/gondolin" ]; then
	echo "try: gondolin is installed and would conflict — leaving it out of this run"
fi

# Credentials usually live in ~/.pi/env/keys.env, loaded by the env-keys
# extension. Turning discovery off would silently drop the model API keys, so
# it is re-added explicitly when present.
if [ "$DISCOVER" != "1" ] && [ -d "$AGENT_DIR/extensions/env-keys" ]; then
	EXT_ARGS+=(-e "$AGENT_DIR/extensions/env-keys")
	echo "try: keeping env-keys (provider credentials)"
fi

echo

# NOT `exec`: exec would replace this shell and the EXIT trap would never run,
# leaking the container. Run pi as a child so cleanup always happens, and pass
# its exit status through.
#
# `${ARR[@]+...}` rather than a bare "${ARR[@]}": under `set -u` an EMPTY array
# expansion is an "unbound variable" error in bash 3.2, which is what macOS
# ships as /bin/bash. The idiom expands to nothing when empty and to properly
# quoted elements otherwise.
set +e
if [ "$DISCOVER" = "1" ]; then
	pi ${EXT_ARGS[@]+"${EXT_ARGS[@]}"} ${PI_ARGS[@]+"${PI_ARGS[@]}"}
else
	pi -ne ${EXT_ARGS[@]+"${EXT_ARGS[@]}"} ${PI_ARGS[@]+"${PI_ARGS[@]}"}
fi
STATUS=$?
set -e

exit "$STATUS"
