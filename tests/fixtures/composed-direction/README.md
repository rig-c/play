# Composed direction fixtures

These assets come from the scripted artwork and authored scene in Create's
public `example-composed-direction` rehearsal. Parts 2.54.0 produced all three
variants with Core 3.8.1 from the Create lockfile at
`ed949ef5a44e443a89f640ab0d6b8f8fac0ca1ae`. The original consumes the upstream
scene and two plate PNGs byte for byte. [Pinned Create source](https://github.com/rig-c/create/tree/ed949ef5a44e443a89f640ab0d6b8f8fac0ca1ae/templates/example-composed-direction) · [MIT license](LICENSE.txt)

| Variant | Stage and plate |
| --- | --- |
| `original` | 128 × 128 stage and backdrop with zero overscan |
| `overscan` | Same stage, with a 158 × 158 backdrop at `[-15,-15]` made by extending the public edge texels |
| `clip` | Same overscan, with actor offset `[-8,0]` and `canvas_clip: true` |

Parts preserved the 16,384 centre RGBA pixels when composing the extended
plate. The six actor PNGs have the same hashes in all variants. The clip
receipt records `bounds: [-8,0,120,128]` and `clipped_bounds: [0,0,120,128]`.
All three models carry the same 128 × 128 stage, six figure slots including a
mesh torso, and a four-second `idle` with the foreground moving +3 on X at
two seconds. [Source measurements](receipts/source-measurements.json)

Each variant contains the model, its atlas page PNG and the producer's atlas
text. [`SHA256SUMS`](SHA256SUMS) seals these nine browser fixtures, the license
and the producer receipts. The `*.compose.json` and `*.build.json` receipts
bind the scenes, source plate hashes, model, PNG and atlas. The source
archive's SHA-256 is pinned in [`reproduce.sh`](reproduce.sh).

```bash
cd tests/fixtures/composed-direction
shasum -a 256 -c SHA256SUMS
bash reproduce.sh /absolute/path/to/new/scratch-directory
```

The producer used Bun 1.4.4 with `SOURCE_DATE_EPOCH=1795305600`. The reproduction
downloads and verifies the pinned source archive, installs its locked tools in
scratch, runs Create's input seal check, and assembles, rigs, checks and composes
through Parts. It compares the nine outputs byte for byte and leaves the
command log, producer log, and regenerated source measurements in scratch.
The frozen producer initially used a flat character handoff and compose
exited 1. With `parts.json`, `rig/` and `check/check.json` in the layout used here,
all three compose commands exited 0. Core's official Spine parser gate was
skipped because the optional official runtime was absent. These receipts cover
the Parts producer path. Browser acceptance belongs to the composed-take tests.
