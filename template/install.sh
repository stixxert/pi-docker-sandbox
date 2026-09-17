#!/usr/bin/env bash
#
# install.sh — the lightweight sandbox baseline.
#
# Runs INSIDE the sandbox (or inside a docker build). Deliberately contains no
# `sbx` commands so the exact same recipe can be validated with plain docker
# (`docker build -f template/Dockerfile …`) on machines where sbx cannot run.
#
# What it is: a general Linux + git + node/pnpm + search box. That is all a
# sandbox needs once pi runs on the HOST and merely routes its tools here —
# pi itself, an editor stack for pi, and every language toolchain somebody
# might want are all gone.
#
# Tunables (env):
#   NODE_VERSION=22.22.1     node LTS to install
#   SBX_LITE_BUILD=off       drop build-essential + python3 (~250 MB, needed
#                            for native node modules / node-gyp)
#   SBX_LITE_PNPM=off        drop the pnpm global install

set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.22.1}"
export DEBIAN_FRONTEND=noninteractive

SUDO=""
if [ "$(id -u)" != "0" ]; then SUDO="sudo"; fi

# ── base packages ─────────────────────────────────────────────────────────
# git/curl/ca-certificates: cloning and fetching over TLS.
# ripgrep: the agent's search tool, and much faster than grep -r.
# build-essential + python3: native node modules (node-gyp) — without these a
#   `pnpm install` in an ordinary project can fail, which would break the
#   "the user does nothing" guarantee. Opt out with SBX_LITE_BUILD=off.
CORE="ca-certificates curl git gnupg ripgrep jq unzip xz-utils procps less vim-tiny"
EXTRA=""
if [ "${SBX_LITE_BUILD:-on}" != "off" ]; then EXTRA="build-essential python3"; fi

echo "install: apt packages (core${EXTRA:+ + $EXTRA})"
# shellcheck disable=SC2086
$SUDO apt-get update -qq
# shellcheck disable=SC2086
$SUDO apt-get install -y -qq --no-install-recommends $CORE $EXTRA

# ── apt hygiene ───────────────────────────────────────────────────────────
# ~55 MB in a typical Ubuntu image, and pure waste in a snapshot: the lists are
# stale the moment the image is saved and every sandbox re-downloads them.
$SUDO rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /var/cache/apt/*

# ── node + pnpm ───────────────────────────────────────────────────────────
# The official tarball into /usr/local rather than a distro/node image layer:
# no apt repository to configure, no extra base layers to carry.
case "$(uname -m)" in
	aarch64 | arm64) NODE_ARCH="arm64" ;;
	x86_64 | amd64) NODE_ARCH="x64" ;;
	*)
		echo "install: unsupported architecture $(uname -m)" >&2
		exit 1
		;;
esac

echo "install: node v${NODE_VERSION} (${NODE_ARCH})"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz
$SUDO tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
rm -f /tmp/node.tar.xz

# The tarball also ships node's C++ headers (~65 MB). node-gyp fetches its own
# headers into a cache, so these are dead weight in a snapshot.
$SUDO rm -rf /usr/local/include/node

if [ "${SBX_LITE_PNPM:-on}" != "off" ]; then
	echo "install: pnpm"
	$SUDO npm install -g --no-audit --no-fund --loglevel=error pnpm
fi
# The npm cache is ~30-60 MB of tarballs that a snapshot never needs again.
$SUDO npm cache clean --force >/dev/null 2>&1 || true

echo "install: done — node $(node -v), pnpm $(pnpm -v 2>/dev/null || echo absent)"
