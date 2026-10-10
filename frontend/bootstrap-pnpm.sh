#!/bin/sh
# Install the exact pnpm release package.json names for Node.js 26, which no longer bundles Corepack: the npm registry
# tarball of that release, verified against the sha256 pinned here, runs on the pinned Node.js release.
# Usage: sh bootstrap-pnpm.sh CACHE TARGET
#   CACHE   keeps the downloaded tarball between runs; it may be shared, because a download lands by rename and every
#           run verifies its own private copy.
#   TARGET  receives that run's extraction and TARGET/bin/pnpm; put TARGET/bin on PATH.
set -eu
node_version=v26.11.1
version=11.9.0
sha256=2b567aa66026238078ac2e0a33bec3febd60e962987aac697456f3180819b287
[ "$#" -eq 2 ] || { echo "usage: bootstrap-pnpm.sh CACHE TARGET" >&2; exit 2; }
found="$(node --version)"
[ "$found" = "$node_version" ] || { echo "bootstrap-pnpm: Node.js $node_version required, found $found" >&2; exit 1; }
cache=$1
target=$2
tarball="$cache/pnpm-$version.tgz"
mkdir -p "$cache" "$target/bin"
if [ ! -f "$tarball" ]; then
  partial="$(mktemp "$tarball.XXXXXX")"
  node -e '
    const [url, out] = process.argv.slice(1);
    fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(url + ": HTTP " + response.status);
      require("node:fs").writeFileSync(out, Buffer.from(await response.arrayBuffer()));
    });
  ' "https://registry.npmjs.org/pnpm/-/pnpm-$version.tgz" "$partial"
  echo "$sha256  $partial" | sha256sum -c --quiet - || { rm -f "$partial"; exit 1; }
  mv "$partial" "$tarball"
fi
cp "$tarball" "$target/pnpm.tgz"
echo "$sha256  $target/pnpm.tgz" | sha256sum -c --quiet -
rm -rf "$target/pnpm"
mkdir "$target/pnpm"
tar -xzf "$target/pnpm.tgz" -C "$target/pnpm" --no-same-owner
rm "$target/pnpm.tgz"
ln -sf ../pnpm/package/bin/pnpm.mjs "$target/bin/pnpm"
found="$("$target/bin/pnpm" --version)"
[ "$found" = "$version" ] || { echo "bootstrap-pnpm: pnpm $version required, found $found" >&2; exit 1; }
