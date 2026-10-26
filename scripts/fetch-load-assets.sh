#!/usr/bin/env bash
# Public, checksum-pinned Spine examples, matching the adapters benchmark.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RIGC_TAG="v2.67.0"
RIGC="$ROOT/node_modules/.bin/rigc"
require_rigc() { test -x "$RIGC"; }
SPINE_RUNTIMES_REF="38ddb1a0652c2e3473e8487ebd88b4b291ad9a7e"
BENCH_RIGS="spineboy raptor"
BENCH_DEST="$ROOT/public/bench"
BENCH_STAMP="$BENCH_DEST/.stamp"
EXPECTED_BENCH_STAMP="$RIGC_TAG $SPINE_RUNTIMES_REF"

if [ -d "$BENCH_DEST" ] && [ "$(cat "$BENCH_STAMP" 2>/dev/null || true)" != "$EXPECTED_BENCH_STAMP" ]; then
  echo "bench stamp $(cat "$BENCH_STAMP" 2>/dev/null || echo unstamped) -> $EXPECTED_BENCH_STAMP, rebuilding"
  rm -rf "$BENCH_DEST"
fi

have_bench() {
  local name="$1" dir="$BENCH_DEST/$1"
  [ -s "$dir/skeleton.model.json" ] && [ -s "$dir/$name-pro.json" ] && [ -s "$dir/$name.atlas" ] && [ -s "$dir/$name.png" ] && [ -s "$dir/license.txt" ]
}

MISSING_BENCH=""
for rig in $BENCH_RIGS; do
  if have_bench "$rig"; then
    echo "have bench rig $rig"
  else
    MISSING_BENCH="$MISSING_BENCH $rig"
  fi
done

if [ -n "$MISSING_BENCH" ] || [ ! -s "$BENCH_DEST/manifest.json" ]; then
  require_rigc
  mkdir -p "$BENCH_DEST"
  BENCH_TMP="$(mktemp -d)"
  trap 'rm -rf "$BENCH_TMP"' EXIT

  fetch_verified() {
    local url="$1" dest="$2" expected_sha="$3"
    curl -fsSL "$url" -o "$dest"
    local actual_sha
    actual_sha="$(bun -e 'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; console.log(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));' "$dest")"
    if [ "$actual_sha" != "$expected_sha" ]; then
      echo "BENCH_CHECKSUM_MISMATCH: $dest expected $expected_sha, got $actual_sha" >&2
      exit 1
    fi
  }

  build_bench_rig() {
    local name="$1" json_sha="$2" atlas_sha="$3" png_sha="$4" license_sha="$5"
    local work="$BENCH_TMP/$name"
    local out="$BENCH_DEST/$name"
    local base_url="https://raw.githubusercontent.com/EsotericSoftware/spine-runtimes/$SPINE_RUNTIMES_REF/examples/$name"
    rm -rf "$work" "$out"
    mkdir -p "$work/raw" "$work/ingested" "$out"
    echo "fetching and verifying bench rig $name ($SPINE_RUNTIMES_REF)"
    fetch_verified "$base_url/export/$name-pro.json" "$work/raw/$name-pro.json" "$json_sha"
    fetch_verified "$base_url/export/$name.atlas" "$work/raw/$name.atlas" "$atlas_sha"
    fetch_verified "$base_url/export/$name.png" "$work/raw/$name.png" "$png_sha"
    fetch_verified "$base_url/license.txt" "$work/raw/license.txt" "$license_sha"

    "$RIGC" ingest "$work/raw/$name-pro.json" --art none --out "$work/ingested" > "$work/ingest.log" 2>&1 || true
    if [ ! -s "$work/ingested/rig.json" ] || [ ! -s "$work/ingested/motion.json" ]; then
      cat "$work/ingest.log" >&2
      exit 1
    fi
    cp "$work/raw/$name-pro.json" "$work/raw/$name.atlas" "$work/raw/$name.png" "$work/raw/license.txt" "$out/"
    cp "$work/ingested/rig.json" "$work/ingested/motion.json" "$out/"
    if [ -f "$work/ingested/findings.json" ]; then
      cp "$work/ingested/findings.json" "$out/"
    fi
    if ! (cd "$out" && "$RIGC" build --rig rig.json --motion motion.json --atlas-in "$name.atlas" --out . > "$work/build.log" 2>&1); then
      cat "$work/build.log" >&2
      exit 1
    fi
  }

  for rig in $BENCH_RIGS; do
    if ! have_bench "$rig" || [ ! -s "$BENCH_DEST/$rig/rig.json" ]; then
      case "$rig" in
        spineboy)
          build_bench_rig "spineboy" \
            "24ccffc13e334e721dfd427ee2b8aea05c25b59167b5fb0bb0f9685e11d2a7d3" \
            "fbd452640df513d637e0a34d21c1d3ea4edb27f57bd1856ffd5530b16ee83d00" \
            "ab874448a224f8a92188e133735062c86e5f93eb7286b0fc37c5d39864e6569f" \
            "08074c5f8c5f072626a0830250304fe3063d9d49f8f9b039e063bb238f2b993b"
          ;;
        raptor)
          build_bench_rig "raptor" \
            "2ba9fe06007bc7b44d412bdb5722b1cd8b5fbcd0f7a263ae1aa957a555e9742a" \
            "fb6e8532cb7665542b54ab661d0cadffe0171fcfe6b192595cd6ab622b08d8e6" \
            "c2fcb6ac6c363f5b37f622feb727aed64fbd0205897a7ba8b6b45f8a091ab125" \
            "08074c5f8c5f072626a0830250304fe3063d9d49f8f9b039e063bb238f2b993b"
          ;;
      esac
    fi
  done

  bun -e '
    import { createHash } from "node:crypto";
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { gzipSync } from "node:zlib";

    const [benchDest, rigcTag, spineRef] = process.argv.slice(1);
    const statFile = (p) => {
      const buf = readFileSync(p);
      return {
        bytes: buf.byteLength,
        gzipBytes: gzipSync(buf, { level: 9 }).byteLength,
        sha256: createHash("sha256").update(buf).digest("hex"),
      };
    };
    const skeletons = {};
    for (const name of ["spineboy", "raptor"]) {
      const dir = join(benchDest, name);
      skeletons[name] = {
        animation: "walk",
        files: {
          spineJson: statFile(join(dir, `${name}-pro.json`)),
          spineAtlas: statFile(join(dir, `${name}.atlas`)),
          atlasPng: statFile(join(dir, `${name}.png`)),
          license: statFile(join(dir, "license.txt")),
          ingestedRig: statFile(join(dir, "rig.json")),
          ingestedMotion: statFile(join(dir, "motion.json")),
          builtModel: statFile(join(dir, "skeleton.model.json")),
          builtSpineJson: statFile(join(dir, "skeleton.json")),
          builtSpineAtlas: statFile(join(dir, "skeleton.atlas")),
        },
      };
    }
    writeFileSync(
      join(benchDest, "manifest.json"),
      JSON.stringify({ rigcTag, spineRuntimesRef: spineRef, skeletons }, null, 2) + "\n",
    );
  ' "$BENCH_DEST" "$RIGC_TAG" "$SPINE_RUNTIMES_REF"

  printf '%s' "$EXPECTED_BENCH_STAMP" > "$BENCH_STAMP"
fi

echo "bench rigs ready ($EXPECTED_BENCH_STAMP) -> $BENCH_DEST"
