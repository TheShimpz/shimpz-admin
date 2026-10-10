# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# The pinned Playwright browsers and their system packages on Node.js 26, for browser work against this frontend's
# build (perf/). Playwright 1.62.0 ships Node.js 24 as a NodeSource package: it is purged, and the official Node.js 26
# binary of the digest-pinned image takes its place. The recipe needs no build context:
#   docker build --quiet - < playwright.Dockerfile   (prints the image ID to run)
FROM node:26.11.1-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS node

FROM mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07
RUN dpkg --purge nodejs
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN test "$(node --version)" = v26.11.1
