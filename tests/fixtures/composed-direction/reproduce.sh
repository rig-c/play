#!/usr/bin/env bash
set -euo pipefail

fixture="$(cd "$(dirname "$0")" && pwd)"
revision=ed949ef5a44e443a89f640ab0d6b8f8fac0ca1ae
archive_sha=06a05c4c2429215c300e53b8f8ad8911a65c084f38236014ce0f83f13f018332
if [[ $# -ne 1 || "$1" != /* ]]; then
  echo 'Usage: bash reproduce.sh /absolute/path/to/new/scratch-directory' >&2
  exit 2
fi

mkdir -- "$1"
scratch="$(cd "$1" && pwd)"
create="$scratch/create"
builds="$scratch/builds"
export TMPDIR="$scratch/tmp" BUN_INSTALL_CACHE_DIR="$scratch/cache/bun" XDG_CACHE_HOME="$scratch/cache"
export SOURCE_DATE_EPOCH=1795305600
mkdir -p "$TMPDIR" "$BUN_INSTALL_CACHE_DIR" "$create" "$builds"/{evidence,inputs}

run() {
  local status=0
  printf '%s >' "$PWD" | tee -a "$scratch/commands.log"
  printf ' %q' "$@" | tee -a "$scratch/commands.log"
  printf '\n' | tee -a "$scratch/commands.log"
  (set -o pipefail; "$@" 2>&1 | tee -a "$scratch/producer.log") || status=$?
  printf 'exit %s\n' "$status" | tee -a "$scratch/commands.log"
  return "$status"
}

cd "$scratch"
run curl -fsSL "https://codeload.github.com/rig-c/create/tar.gz/$revision" -o create.tar.gz
printf '%s  create.tar.gz\n' "$archive_sha" > source.sha256
run shasum -a 256 -c source.sha256
run tar -xzf create.tar.gz --strip-components=1 -C "$create"

cd "$create"
run bun install --frozen-lockfile
run bun scripts/generate-composed-direction-fixture.ts --check
export PATH="$create/node_modules/.bin:$PATH"
parts="$create/node_modules/.bin/rig-parts"
inputs="$create/templates/example-composed-direction/inputs"
cp "$fixture"/{variants,verify-source}.mjs "$create/"
cp -R "$inputs/source" "$builds/source"
cp -R "$inputs/rig" "$builds/actor"
cp "$inputs/plates/"*.png "$builds/inputs/"
cp "$inputs/scene.json" "$builds/compose.scene.json"

cd "$builds/source"
run bun "$parts" assemble --source painting.png --full layers --config config.json --out assembled
cd "$builds/actor"
mkdir input check
cp -R ../source/assembled/rig/{parts.json,painting_in_rig.png,parts} input/
cp ../source/painting.png painting.png
run bun "$parts" rig --config config.json --parts input --out out
cp -R out check/out
run bun "$parts" check --rig check/out --parts input --source painting.png --requirements rig-check-requirements.json --out check --no-extremes --keep-stills

cd "$builds"
mkdir -p evidence/compose-character/check
cp -R actor/input/. evidence/compose-character/
cp -R actor/out evidence/compose-character/rig
cp actor/check/check.json evidence/compose-character/check/
run bun "$parts" compose --scene compose.scene.json --out original
run bun "$create/variants.mjs" "$builds"
run bun "$parts" compose --scene overscan.scene.json --out overscan
run bun "$parts" compose --scene clip.scene.json --out clip
bun "$create/verify-source.mjs" "$builds" "$inputs" > "$scratch/source-measurements.json"

for variant in original overscan clip; do
  for asset in skeleton.model.json skeleton.atlas skeleton.png; do
    run cmp "$fixture/$variant/$asset" "$builds/$variant/check/build/$asset"
  done
done
printf 'All nine browser assets match. Producer receipts and logs are in %s\n' "$scratch"
