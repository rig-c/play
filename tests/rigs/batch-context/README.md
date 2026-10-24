# Packed mesh context fixture

This rig retains glow’s authored core, bone chain and `burn` motion. Its core
PNG is a byte-for-byte copy of the committed glow artwork. Two real padding
slots (`pad_a`, `pad_b`) use authored quad meshes on their own bones; the probe
selects these actual `frameOf` slots and never rewrites posed vertices.

Each pad spans 445 × 821 world units. At the frozen near-one pixel ratios, the
renderer’s one-pixel bounds padding makes each job 447 × 823 pixels. In the
512 × 3328 target, two pad jobs move the common job from pack Y=1 to Y=1649.
The original source-derived pixel ratios and exact old-path defect bar remain
unchanged. Readback uses the common part canvas before compositing, so real
occlusion is excluded.

Regenerate only these committed source PNGs with:

```sh
bun tests/rigs/make_parts.ts --batch-context-only
```

That operation copies the existing committed glow core without repainting it
and generates the small pad artwork deterministically. `fetch-assets.sh` builds
this rig with the pinned rig-c version and stamps its JSON/PNG source digest.
