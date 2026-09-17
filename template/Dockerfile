# syntax=docker/dockerfile:1
#
# Lightweight sandbox baseline — the docker-buildable form of install.sh.
#
# The sbx snapshot itself is built by template/build.sh (which runs the same
# install.sh inside a sandbox and `sbx template save`s the result). This
# Dockerfile exists so the recipe can be BUILT AND MEASURED anywhere docker
# runs, including CI and machines where sbx cannot start:
#
#   docker build -f template/Dockerfile -t sbx-lite .
#   docker images sbx-lite --format '{{.Size}}'
#
# It is also a perfectly good sandbox image on its own for the docker backend of
# the sandbox extension (SBX_BACKEND=docker).
#
# Ubuntu, because an sbx sandbox is always Ubuntu; using anything else here
# would make the measured size unrepresentative of the real template.

FROM ubuntu:24.04

ARG NODE_VERSION=22.22.1
ARG SBX_LITE_BUILD=on
ARG SBX_LITE_PNPM=on
ENV NODE_VERSION=${NODE_VERSION} \
    SBX_LITE_BUILD=${SBX_LITE_BUILD} \
    SBX_LITE_PNPM=${SBX_LITE_PNPM} \
    LANG=C.UTF-8

# Context is the repository root (see the build command above), so this path is
# repo-relative rather than relative to this Dockerfile.
COPY template/install.sh /tmp/install.sh
RUN bash /tmp/install.sh && rm -f /tmp/install.sh

WORKDIR /workspace
