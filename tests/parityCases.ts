/** Shared scenes and existing mode-parity bars; no #213-specific thresholds. */
const POSE = 'time=1.2&timescale=0&count=1&dpr=1';
export const SCENES = [
  // Additive slots (halo, flame, sparks) → mix-blend-mode: plus-lighter, over
  // two weighted meshes the flame chain bends triangle by triangle.
  { name: 'glow (additive glow)', kind: 'test', query: `rig=glow&anim=burn&${POSE}` },
  // A clipping attachment over the walking figure, applied as a per-element
  // clip-path. Clipping is element-level, so it must land identically on both
  // backends.
  { name: 'figure mask (clipping)', kind: 'test', query: `rig=figure&anim=mask&${POSE}` },
  // Whole-rig tint rides the feColorMatrix filter on <img> and <canvas>.
  { name: 'figure walk (tint filter)', kind: 'test', query: `rig=figure&anim=walk&tint=ff9060&${POSE}` },
  // One region on a page not named for it, cut from inside the page (rig-c #1404, A27).
  { name: 'named region (page not named for it)', kind: 'test', query: `rig=named&anim=tilt&${POSE}` },
  // A physics chain under a side gust (#121): the environment the page sets, posed by
  // the seek's steps; both modes draw the same lean.
  { name: 'cloth under a side gust', kind: 'test', query: `rig=cloth&anim=hang&wind=-1,0&${POSE}` },
  // An attachment set switched at runtime (#134): overrides covered slots and hides
  // `<base>_still` while uncovered slots keep their track key; both modes draw the same set.
  { name: 'sets switch (attachment set)', kind: 'test', query: `rig=sets-packed&anim=dance&set=smile&${POSE}` },
  // Contour meshes waved by bones and rippled by a deform.
  { name: 'gallery flex (contour meshes)', kind: 'gallery', query: `rig=flex&anim=wave&${POSE}` },
  // The same rig packed: every mesh samples a shared page through page UVs.
  { name: 'gallery flex, packed (shared page)', kind: 'gallery', query: `rig=flex-packed&anim=wave&${POSE}` },
  // A deform-squashed mesh with slot rgba keys, under the player's tint.
  { name: 'gallery squash (deform + tint)', kind: 'gallery', query: `rig=squash&anim=bounce&tint=ff9060&${POSE}` },
  // Grid meshes keyed as a projection, and a depth-mapped face under sliders.
  { name: 'gallery portrait (deform projection)', kind: 'gallery', query: `rig=portrait&anim=turn&${POSE}` },
  { name: 'gallery look, packed (sliders, physics)', kind: 'gallery', query: `rig=look-packed&anim=turn&${POSE}` },
] as const;

export const MODE_BAD_RATIO_LIMIT_TEST_RIGS = 0.015;
export const MODE_BAD_RATIO_LIMIT_GALLERY = 0.025;
export const MODE_CONTENT_MISMATCH_LIMIT = 0.03;
