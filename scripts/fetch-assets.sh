#!/usr/bin/env bash
# Builds every rig the demo, the test suite and the benchmark read, with the
# pinned rig-c devDependency's `rigc build`. Three sources:
#
# - rigc's gallery rigs, from the rigc tag below (each one's art is rigc's own
#   procedural drawing — its make_parts.ts);
# - this repository's test rigs, `tests/rigs/<name>/` (rig.json, motion.json
#   and parts painted by tests/rigs/make_parts.ts), which carry what no gallery
#   rig does and the renderer specs need: a clipping attachment, additive
#   slots, a region turned on its page (CLAUDE.md, *Testing*);
# - `@rig-c/parts`' public `wind` example with its gesture set (`wind-wave`,
#   #174), built by the pinned `@rig-c/parts` devDependency from its tag's
#   config and the pinned public examples repository's painting and layers. The
#   painting carries its own licence (the examples repository's README); it is
#   fetched to build a test fixture under the gitignored public/rigs/, which
#   neither npm nor any page deploys.
#
# Each build lands in `public/rigs/<name>/` with everything side by side:
# `skeleton.model.json` (what the player loads), the Spine pair `rigc build`
# writes beside it (`skeleton.json` + `skeleton.atlas`, independently read by
# the development pixel oracle) and the pages relative to that directory.
set -euo pipefail

# --- the rigc gallery builds -------------------------------------------------
#
# Every rig is built twice: as the gallery ships it, one page per part
# (`<name>/`), and with `--pack`, every part on shared pages (`<name>-packed/`).
# The second is what makes region cuts mint blobs and puts page UVs that are
# not the identity in front of the mesh tier.
#
# Pinned twice, on purpose: the sources come from the rigc tag below and the
# build is run by the rig-c devDependency of the same version, so a fixture is
# a function of one version and is rebuilt when it moves.
RIGC_TAG="v2.75.0"
RIGS="walk flex squash portrait nod look ride"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RIGS_DEST="$ROOT/public/rigs"
RIGS_STAMP="$RIGS_DEST/.rigc"
RIGC="$ROOT/node_modules/.bin/rigc"

if [ -d "$RIGS_DEST" ] && [ "$(cat "$RIGS_STAMP" 2>/dev/null || true)" != "$RIGC_TAG" ]; then
  echo "rigc gallery $(cat "$RIGS_STAMP" 2>/dev/null || echo unstamped) → $RIGC_TAG, rebuilding"
  rm -rf "$RIGS_DEST"
fi

require_rigc() {
  if [ ! -x "$RIGC" ]; then
    echo "rig-c is not installed (node_modules/.bin/rigc) — run bun install first" >&2
    exit 1
  fi
  local installed expected
  installed="$(node -p "require('$ROOT/node_modules/rig-c/package.json').version")"
  expected="$(node -p "require('$ROOT/package.json').devDependencies['rig-c']")"
  if [ "$installed" != "${RIGC_TAG#v}" ] || [ "$expected" != "${RIGC_TAG#v}" ]; then
    echo "fixture pin mismatch: tag $RIGC_TAG, manifest $expected, installed $installed" >&2
    exit 1
  fi
}

# build <source dir> <out dir> [rigc build flags…] — built in place, so every
# page name in the atlas and the model document is relative to the build
# directory: `parts/<file>.png` one page per part, the packed pages' own names
# under --pack, the hand-packed page's under --atlas-in.
build() {
  local src="$1" out="$2"
  shift 2
  rm -rf "$out"
  mkdir -p "$out"
  cp "$src/rig.json" "$src/motion.json" "$out/"
  if [ -f "$src/sets.json" ]; then cp "$src/sets.json" "$out/sets.json"; fi
  for dir in parts art images; do
    if [ -d "$src/$dir" ]; then cp -R "$src/$dir" "$out/$dir"; fi
  done
  # A reference still (tests/rigs/<rig>/stills/<sets>/, #170) draws its rig's parts.
  if [ ! -d "$out/parts" ] && [ -n "${PARTS_FROM:-}" ]; then cp -R "$PARTS_FROM" "$out/parts"; fi
  if ! (cd "$out" && "$RIGC" build --rig rig.json --motion motion.json --out . "$@" > build.log 2>&1); then
    cat "$out/build.log" >&2
    exit 1
  fi
  rm -f "$out/rig.json" "$out/motion.json" "$out/build.log"
}

have() {
  [ -s "$1/skeleton.model.json" ] && [ -s "$1/skeleton.json" ] && [ -s "$1/skeleton.atlas" ]
}

BUILDS=""
for rig in $RIGS; do BUILDS="$BUILDS $rig $rig-packed"; done

MISSING=""
for rig in $BUILDS; do
  if have "$RIGS_DEST/$rig"; then
    echo "have rig $rig"
  else
    MISSING="$MISSING $rig"
  fi
done

if [ -n "$MISSING" ]; then
  require_rigc
  mkdir -p "$RIGS_DEST"
  printf '%s' "$RIGC_TAG" > "$RIGS_STAMP"
  SRC="$(mktemp -d)"
  trap 'rm -rf "$SRC"' EXIT
  echo "fetching rigc $RIGC_TAG gallery"
  curl -fsSL "https://codeload.github.com/rig-c/core/tar.gz/refs/tags/$RIGC_TAG" \
    | tar -xz -C "$SRC" --strip-components=1 "core-${RIGC_TAG#v}/gallery"
  for name in $MISSING; do
    rig="${name%-packed}"
    echo "building rig $name"
    if [ "$rig" != "$name" ]; then
      build "$SRC/gallery/$rig" "$RIGS_DEST/$name" --pack
      # A packed build draws from its own pages; the loose parts are not its.
      rm -rf "$RIGS_DEST/$name/parts"
    else
      build "$SRC/gallery/$rig" "$RIGS_DEST/$name"
    fi
  done
fi
echo "rigs ready (rigc $RIGC_TAG) → $RIGS_DEST"

# --- the test rigs -----------------------------------------------------------
#
# `figure` and `glow` are built like the gallery, one page per part and
# `--pack`; `duo` (two-colour tint) one page per part only; `named` against its
# hand-packed page, one region not named for the page's file (rig-c #1404); `turned` is built against its hand-packed page (`--atlas-in`),
# because rigc's own packer never turns a region and the turned region is the
# point of it. Each build is stamped with the rigc tag and a digest of its
# sources, so editing a rig — or moving the pin — rebuilds it and nothing else.
TEST_RIGS_SRC="$ROOT/tests/rigs"
mkdir -p "$RIGS_DEST"

digest() {
  (cd "$1" && find . -type f ! -name '*.md' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)
}

test_rig() {
  local rig="$1" name="$2"
  shift 2
  local out="$RIGS_DEST/$name"
  local stamp
  stamp="$RIGC_TAG $(digest "$TEST_RIGS_SRC/$rig")${PARTS_FROM:+ $(digest "$PARTS_FROM")}"
  if have "$out" && [ "$(cat "$out/.source" 2>/dev/null || true)" = "$stamp" ]; then
    echo "have test rig $name"
    return
  fi
  require_rigc
  echo "building test rig $name"
  build "$TEST_RIGS_SRC/$rig" "$out" "$@"
  printf '%s' "$stamp" > "$out/.source"
}

test_rig figure figure
test_rig figure figure-packed --pack
rm -rf "$RIGS_DEST/figure-packed/parts"
# Independent pixel oracle: the same authored figure compiled against original
# PMA PNG bytes, not a model/frame modified by the renderer under test.
ORACLE_PMA_GENERATOR="$ROOT/tests/rigs/make_oracle_pma.ts"
ORACLE_PMA_SOURCE="$RIGS_DEST/figure-packed"
ORACLE_PMA_OUT="$RIGS_DEST/figure-pma"
ORACLE_PMA_STAMP="$RIGC_TAG $(digest "$TEST_RIGS_SRC/figure") $(shasum -a 256 "$ORACLE_PMA_GENERATOR" "$ORACLE_PMA_SOURCE/skeleton.atlas" "$ORACLE_PMA_SOURCE/skeleton.png" | shasum -a 256 | cut -d' ' -f1)"
if have "$ORACLE_PMA_OUT" && [ -s "$ORACLE_PMA_OUT/art/pma-page.png" ] && [ "$(cat "$ORACLE_PMA_OUT/.source" 2>/dev/null || true)" = "$ORACLE_PMA_STAMP" ]; then
  echo "have test rig figure-pma"
else
  require_rigc
  ORACLE_PMA_INPUT="$(mktemp -d)"
  trap 'rm -rf "$ORACLE_PMA_INPUT"' EXIT
  if ! bun "$ORACLE_PMA_GENERATOR" "$TEST_RIGS_SRC/figure" "$ORACLE_PMA_SOURCE" "$ORACLE_PMA_INPUT"; then
    rm -rf "$ORACLE_PMA_INPUT"
    exit 1
  fi
  build "$ORACLE_PMA_INPUT" "$ORACLE_PMA_OUT" --atlas-in art/pma.atlas
  rm -rf "$ORACLE_PMA_INPUT" "$ORACLE_PMA_OUT/parts"
  trap - EXIT
  rm -f "$ORACLE_PMA_OUT/art/pma.atlas"
  printf '%s' "$ORACLE_PMA_STAMP" > "$ORACLE_PMA_OUT/.source"
fi
test_rig batch-context batch-context
test_rig glow glow
test_rig glow glow-packed --pack
rm -rf "$RIGS_DEST/glow-packed/parts"
test_rig turned turned --atlas-in art/turned.atlas
rm -f "$RIGS_DEST/turned/art/turned.atlas"
test_rig duo duo
test_rig named named --atlas-in art/named.atlas
test_rig cloth cloth
test_rig physics-scope physics-scope
test_rig parameters parameters
test_rig draw draw
test_rig topology topology
test_rig sets sets
test_rig sets sets-packed --pack
rm -rf "$RIGS_DEST/sets-packed/parts"
test_rig talk talk
test_rig talk talk-packed --pack
rm -rf "$RIGS_DEST/talk-packed/parts"
test_rig gesture gesture
test_rig drape drape
for still in wave nod wave+nod; do
  PARTS_FROM="$TEST_RIGS_SRC/gesture/parts" test_rig "gesture/stills/$still" "gesture-still-$still"
done
# --- the public wave build (#174) ---------------------------------------------
#
# `@rig-c/parts`' wind example with its drawn gesture set `wave_r`
# (examples/wind/config.wave.json, parts #670/#672): its light half (config,
# pose, proposal, expected-wave/) from the parts tag, its heavy half (painting,
# See-through layers) from rig-c/examples (formerly parts-examples) at the commit parts' own
# scripts/fetch-examples.sh pins, built by the `@rig-c/parts` devDependency of
# the same version (`rig-parts build`, the call parts' chain suite makes), then
# compiled here like every other rig. The build's rig.json, motion.json and
# sets.json must be byte-identical to the tag's expected-wave/, or nothing is
# written. It takes minutes, so it is stamped like the test rigs.
PARTS_TAG="v1.60.0"
PARTS_EXAMPLES_COMMIT="ba99e403d4058fc1cfe40699bdcde8aaf00a90c0"
WAVE_OUT="$RIGS_DEST/wind-wave"
WAVE_STAMP="$RIGC_TAG parts $PARTS_TAG examples $PARTS_EXAMPLES_COMMIT"
RIG_PARTS="$ROOT/node_modules/.bin/rig-parts"
if have "$WAVE_OUT" && [ "$(cat "$WAVE_OUT/.source" 2>/dev/null || true)" = "$WAVE_STAMP" ]; then
  echo "have test rig wind-wave"
else
  require_rigc
  parts_installed="$(node -p "require('$ROOT/node_modules/@rig-c/parts/package.json').version" 2>/dev/null || true)"
  parts_expected="$(node -p "require('$ROOT/package.json').devDependencies['@rig-c/parts']")"
  if [ ! -x "$RIG_PARTS" ] || [ "$parts_installed" != "${PARTS_TAG#v}" ] || [ "$parts_expected" != "${PARTS_TAG#v}" ]; then
    echo "fixture pin mismatch: parts tag $PARTS_TAG, manifest $parts_expected, installed ${parts_installed:-none} — run bun install first" >&2
    exit 1
  fi
  WAVE_WORK="$(mktemp -d)"
  trap 'rm -rf "$WAVE_WORK"' EXIT
  echo "fetching @rig-c/parts $PARTS_TAG wind example and rig-c/examples ${PARTS_EXAMPLES_COMMIT:0:7} wind inputs"
  mkdir -p "$WAVE_WORK/parts" "$WAVE_WORK/heavy"
  # A codeload tarball's top folder is named after the repository as it is named
  # now (parts-examples is served as rig-c/examples), so it is read, not assumed.
  fetch_dir() { # <url> <path under the top folder> <dest>
    local tgz="$WAVE_WORK/fetch.tgz" top
    curl -fsSL "$1" -o "$tgz"
    top="$(tar -tzf "$tgz" | sed -n 1p | cut -d/ -f1)"
    tar -xzf "$tgz" -C "$3" --strip-components=1 "$top/$2"
    rm -f "$tgz"
  }
  fetch_dir "https://codeload.github.com/rig-c/parts/tar.gz/refs/tags/$PARTS_TAG" examples/wind "$WAVE_WORK/parts"
  fetch_dir "https://codeload.github.com/rig-c/examples/tar.gz/$PARTS_EXAMPLES_COMMIT" wind "$WAVE_WORK/heavy"
  # parts' layout: examples/wind/inputs/{painting.png, st_input_*.png, layers/{full,head}}.
  WAVE_EX="$WAVE_WORK/parts/examples/wind"
  mkdir -p "$WAVE_EX/inputs"
  cp "$WAVE_WORK/heavy/wind/painting.png" "$WAVE_WORK/heavy/wind/inputs/"*.png "$WAVE_EX/inputs/"
  cp -R "$WAVE_WORK/heavy/wind/layers" "$WAVE_EX/inputs/layers"
  echo "building test rig wind-wave (rig-parts build, a few minutes)"
  if ! (cd "$WAVE_WORK/parts" && "$RIG_PARTS" build --config examples/wind/config.wave.json \
    --source examples/wind/inputs/painting.png --full examples/wind/inputs/layers/full \
    --head examples/wind/inputs/layers/head --out "$WAVE_WORK/out" > "$WAVE_WORK/parts.log" 2>&1); then
    tail -n 20 "$WAVE_WORK/parts.log" >&2
    exit 1
  fi
  for f in rig.json motion.json sets.json; do
    if ! cmp -s "$WAVE_WORK/out/rig/$f" "$WAVE_EX/expected-wave/$f"; then
      echo "wind-wave: the build's $f is not parts $PARTS_TAG's expected-wave/$f" >&2
      exit 1
    fi
  done
  build "$WAVE_WORK/out/rig" "$WAVE_OUT"
  rm -rf "$WAVE_WORK"
  trap - EXIT
  printf '%s' "$WAVE_STAMP" > "$WAVE_OUT/.source"
fi
rm -f "$RIGS_DEST/named/art/named.atlas"
echo "test rigs ready → $RIGS_DEST"
