# Changelog

## [1.21.1](https://github.com/rig-c/play/compare/v1.21.0...v1.21.1) (2026-10-28)


### Bug Fixes

* **docs:** name @rig-c/core as the build tool's canonical package in the README and the migration guide ([#223](https://github.com/rig-c/play/issues/223)) ([0b16a15](https://github.com/rig-c/play/commit/0b16a15e1aee081e2303428138fbd1329bad5377)), closes [#222](https://github.com/rig-c/play/issues/222)

## [1.21.0](https://github.com/rig-c/play/compare/v1.20.0...v1.21.0) (2026-10-28)


### Features

* **physics:** a head-local physics input — physicsMoved(scope, motion) moves only the named constraints ([#218](https://github.com/rig-c/play/issues/218)) ([fb67c3c](https://github.com/rig-c/play/commit/fb67c3c501ba2b8f1a7193c759dc6a6eb98f5a8e))
* **runtime:** play the finished runtime poser (rig-c 2.79) and read its dark colour, draw order and clipping ([#221](https://github.com/rig-c/play/issues/221)) ([eaedd3a](https://github.com/rig-c/play/commit/eaedd3a01a928190f01f32d3042a4f13c337fc7f)), closes [#220](https://github.com/rig-c/play/issues/220)

## [1.20.0](https://github.com/rig-c/play/compare/v1.19.0...v1.20.0) (2026-10-26)


### Features

* **dom:** add opt-in atlas-backed rigid regions ([#213](https://github.com/rig-c/play/issues/213)) ([#215](https://github.com/rig-c/play/issues/215)) ([af1bff2](https://github.com/rig-c/play/commit/af1bff2699aecf447156bd8022f69b488e824d66))

## [1.19.0](https://github.com/rig-c/play/compare/v1.18.0...v1.19.0) (2026-10-26)


### Features

* **runtime:** adopt rig-c 2.74.0 and re-measure the 58-row live-frame tally ([#209](https://github.com/rig-c/play/issues/209)) ([#210](https://github.com/rig-c/play/issues/210)) ([ef447f8](https://github.com/rig-c/play/commit/ef447f843ca8d68791d32f52ad5558ff854298c8))

## [1.18.0](https://github.com/rig-c/play/compare/v1.17.1...v1.18.0) (2026-10-26)


### Features

* **runtime:** adopt core's stage-1 runtime — skins, forwarded events, restore() — pinned to rig-c 2.72.0 ([#208](https://github.com/rig-c/play/issues/208)) ([8130157](https://github.com/rig-c/play/commit/8130157fb23adbe97b3125804f687c803b1aa5f4))
* **runtime:** draw from core's runtime poser through a liveFrame() view; posedFrame() stays a detached snapshot ([#206](https://github.com/rig-c/play/issues/206)) ([1df8712](https://github.com/rig-c/play/commit/1df87123cb742191ee8ac6cc3cc8db201ebec442))


### Performance Improvements

* **posedFrame:** skip the per-frame triangle scan for frozen topology, and index slot lookups ([#198](https://github.com/rig-c/play/issues/198)) ([#199](https://github.com/rig-c/play/issues/199)) ([4f2cc2c](https://github.com/rig-c/play/commit/4f2cc2c080a8c04fd2d7588ebf5015bf1fac69ac))
* **render:** read frozen triangle topology through a private plain copy in the raster loops ([#204](https://github.com/rig-c/play/issues/204)) ([8880808](https://github.com/rig-c/play/commit/88808082b367bf9b6839da1cb03041663a362fe1))

## [1.17.1](https://github.com/rig-c/play/compare/v1.17.0...v1.17.1) (2026-10-25)


### Bug Fixes

* **loadModel:** accept the alternate set's focus key that parts 1.62+ writes ([#196](https://github.com/rig-c/play/issues/196)) ([f94da0b](https://github.com/rig-c/play/commit/f94da0b2296c441703e2d5bd39767bec6ffc87fb)), closes [#195](https://github.com/rig-c/play/issues/195)
* stabilize mesh rasterization across packed jobs ([#188](https://github.com/rig-c/play/issues/188)) ([6bebb77](https://github.com/rig-c/play/commit/6bebb77a7bb81710baeec7de50ab89ce7e1c7b2f))

## [1.17.0](https://github.com/rig-c/play/compare/v1.16.0...v1.17.0) (2026-10-23)


### Features

* **sets:** ease a drawn set's bones in and out, swapping attachments at the midpoint ([#177](https://github.com/rig-c/play/issues/177)) ([568a8ae](https://github.com/rig-c/play/commit/568a8ae43af027155eb304344120d34723729b7c))

## [1.16.0](https://github.com/rig-c/play/compare/v1.15.0...v1.16.0) (2026-10-23)


### Features

* **sets:** carry or reset the physics under bones a set switch re-poses ([#175](https://github.com/rig-c/play/issues/175)) ([8670318](https://github.com/rig-c/play/commit/86703185002042cd177015fdeb6cb864fc68b59a))

## [1.15.0](https://github.com/rig-c/play/compare/v1.14.1...v1.15.0) (2026-10-22)


### Features

* **sets:** activate several attachment sets at once when they touch disjoint slots ([#169](https://github.com/rig-c/play/issues/169)) ([2b6edbf](https://github.com/rig-c/play/commit/2b6edbf2044a8bda0509908e2b5db5180cad2ded)), closes [#168](https://github.com/rig-c/play/issues/168)
* **sets:** pose a set's drawn bones as @rig-c/parts check --set does ([#172](https://github.com/rig-c/play/issues/172)) ([5223755](https://github.com/rig-c/play/commit/5223755c37034d8df88b6f65693b2a42a428f1fa)), closes [#170](https://github.com/rig-c/play/issues/170)

## [1.14.1](https://github.com/rig-c/play/compare/v1.14.0...v1.14.1) (2026-10-21)


### Bug Fixes

* **ci:** bind push release provenance to the cut tag commit ([#164](https://github.com/rig-c/play/issues/164)) ([3f80984](https://github.com/rig-c/play/commit/3f809845e767f3e164c1472f058269ff24c165d4))
* **ci:** resolve annotated release tags through full refs ([#167](https://github.com/rig-c/play/issues/167)) ([1d2266d](https://github.com/rig-c/play/commit/1d2266d1eaf7a94ce4f8b39c52796e6fef3f7fc0))

## [1.14.0](https://github.com/rig-c/play/compare/v1.13.0...v1.14.0) (2026-10-21)


### Features

* forward adjust context and live physics parameters ([#161](https://github.com/rig-c/play/issues/161)) ([fcac1d1](https://github.com/rig-c/play/commit/fcac1d1443bf72b6301f95b30705dc11c2dffb75))

## [1.13.0](https://github.com/rig-c/play/compare/v1.12.1...v1.13.0) (2026-10-21)


### Features

* read named mesh setup geometry through core ([#159](https://github.com/rig-c/play/issues/159)) ([c77f490](https://github.com/rig-c/play/commit/c77f490605953fbcf476ef8afed709310100f661))

## [1.12.1](https://github.com/rig-c/play/compare/v1.12.0...v1.12.1) (2026-10-21)


### Bug Fixes

* **ci:** bind dispatched publication to its checkout commit ([#158](https://github.com/rig-c/play/issues/158)) ([2aa6b6a](https://github.com/rig-c/play/commit/2aa6b6a6bf535fa93be7aebe010e63eca6c03cbc)), closes [#155](https://github.com/rig-c/play/issues/155)
* **ci:** retry publication for an already-cut release tag ([#156](https://github.com/rig-c/play/issues/156)) ([12d3e20](https://github.com/rig-c/play/commit/12d3e20bf2fce93598deb97214b50f267103b045))

## [1.12.0](https://github.com/rig-c/play/compare/v1.11.2...v1.12.0) (2026-10-18)


### Features

* add read-only slotIdentity() snapshot coherent with posedFrame ([#144](https://github.com/rig-c/play/issues/144)) ([#145](https://github.com/rig-c/play/issues/145)) ([3666f4f](https://github.com/rig-c/play/commit/3666f4f7ba56ed790b4fe8dc26394907655ea905))

## [1.11.2](https://github.com/rig-c/play/compare/v1.11.1...v1.11.2) (2026-10-18)


### Bug Fixes

* snapshot-backed deterministic seek ([#141](https://github.com/rig-c/play/issues/141)) ([#142](https://github.com/rig-c/play/issues/142)) ([55cba45](https://github.com/rig-c/play/commit/55cba455128424dfadd8887b03060c21751aa930))

## [1.11.1](https://github.com/rig-c/play/compare/v1.11.0...v1.11.1) (2026-10-18)


### Bug Fixes

* report canvas2d on DomRenderer.meshBackendActive after flush fallback ([#138](https://github.com/rig-c/play/issues/138)) ([#139](https://github.com/rig-c/play/issues/139)) ([3022a29](https://github.com/rig-c/play/commit/3022a2959669493998351b738561c3e272d65ad1))

## [1.11.0](https://github.com/rig-c/play/compare/v1.10.1...v1.11.0) (2026-10-17)


### Features

* **player:** read sets.json and expose sets() / setSet() ([#134](https://github.com/rig-c/play/issues/134), [#135](https://github.com/rig-c/play/issues/135)) ([defe097](https://github.com/rig-c/play/commit/defe097340a9dc70bbde64ac0c8a73a4594c3d23))

## [1.10.1](https://github.com/rig-c/play/compare/v1.10.0...v1.10.1) (2026-10-14)


### Bug Fixes

* reuse mesh rasters across Float32-rounded integer translations ([9ff9862](https://github.com/rig-c/play/commit/9ff9862a3938103b4789e2a898ff5f493c3e5431))

## [1.10.0](https://github.com/rig-c/play/compare/v1.9.2...v1.10.0) (2026-10-13)


### Features

* **player:** the page sets the physics environment and tells the rig it moved — environment() and moved() ([#122](https://github.com/rig-c/play/issues/122)) ([1faf35e](https://github.com/rig-c/play/commit/1faf35e8301f2b29467756533cae4065b8d54f67))

## [1.9.2](https://github.com/rig-c/play/compare/v1.9.1...v1.9.2) (2026-10-13)


### Bug Fixes

* **player:** step physics on rig-c's render clock, so a fixed-rate player shows no single-frame spring jump ([#116](https://github.com/rig-c/play/issues/116)) ([a016c73](https://github.com/rig-c/play/commit/a016c732706864421ff14f15a8b2a51e0a300570)), closes [#103](https://github.com/rig-c/play/issues/103)

## [1.9.1](https://github.com/rig-c/play/compare/v1.9.0...v1.9.1) (2026-10-13)


### Performance Improvements

* **canvas2d:** draw mesh triangles from the whole page except on Linux WebKit — macOS Safari pays 12–15% for the per-triangle sub-rect ([#108](https://github.com/rig-c/play/issues/108)) ([84cf5bf](https://github.com/rig-c/play/commit/84cf5bf6bde76eeef8275e32f2baa722c0d71228))

## [1.9.0](https://github.com/rig-c/play/compare/v1.8.2...v1.9.0) (2026-10-13)


### Features

* **dom:** the element mode draws meshes through the shared WebGL context by default — canvas2d becomes its fallback ([#111](https://github.com/rig-c/play/issues/111)) ([62cf482](https://github.com/rig-c/play/commit/62cf4823857f796a08af0c25df09d81dcafa89b3))

## [1.8.2](https://github.com/rig-c/play/compare/v1.8.1...v1.8.2) (2026-10-13)


### Bug Fixes

* **canvas2d:** close mesh seams by moving each triangle edge along its normal, not its corners from the centroid ([#105](https://github.com/rig-c/play/issues/105)) ([b6d1d91](https://github.com/rig-c/play/commit/b6d1d91634897a5a07416332f3002a296dcf1d33)), closes [#104](https://github.com/rig-c/play/issues/104)

## [1.8.1](https://github.com/rig-c/play/compare/v1.8.0...v1.8.1) (2026-10-11)


### Bug Fixes

* **pkg:** the package is @rig-c/play and the repository is rig-c/play — rig-play and spine-html stay as aliases ([#99](https://github.com/rig-c/play/issues/99)) ([5b47a34](https://github.com/rig-c/play/commit/5b47a347ae9816336f8184183835e88c7b289b00)), closes [#98](https://github.com/rig-c/play/issues/98)

## [1.8.0](https://github.com/firejune/rig-play/compare/v1.7.0...v1.8.0) (2026-10-11)


### Features

* **player:** entry weight and additive layers on the tracks — play/queue take alpha and additive, setAlpha changes a weight live ([#96](https://github.com/firejune/rig-play/issues/96)) ([5663a36](https://github.com/firejune/rig-play/commit/5663a36b1ce52b460510ee3621873c0ef57f9eb0))

## [1.7.0](https://github.com/firejune/rig-play/compare/v1.6.0...v1.7.0) (2026-10-11)


### Features

* **player:** stand the player on the live tracks from the first play (tracks: true), so the first composing call never replays ([#94](https://github.com/firejune/rig-play/issues/94)) ([1d1e9d1](https://github.com/firejune/rig-play/commit/1d1e9d163f9d252bd6cf84ffdd975aee0067d052))

## [1.6.0](https://github.com/firejune/rig-play/compare/v1.5.0...v1.6.0) (2026-10-11)


### Features

* **player:** a slot filter — which slots a player draws, up front and live, in both modes ([#91](https://github.com/firejune/rig-play/issues/91)) ([9e59bac](https://github.com/firejune/rig-play/commit/9e59bac8216476fd74d383030a8736b8d5094e9c)), closes [#88](https://github.com/firejune/rig-play/issues/88)

## [1.5.0](https://github.com/firejune/rig-play/compare/v1.4.0...v1.5.0) (2026-10-11)


### Features

* **player:** several tracks — play on a track with a mix, queue, clear — on rig-c's live tracks, with a plain play unchanged ([#89](https://github.com/firejune/rig-play/issues/89)) ([4ef1c1f](https://github.com/firejune/rig-play/commit/4ef1c1fd159e4b8c7daf984bb9e6524e448015eb)), closes [#87](https://github.com/firejune/rig-play/issues/87)

## [1.4.0](https://github.com/firejune/rig-play/compare/v1.3.0...v1.4.0) (2026-10-11)


### Features

* **loader:** load for the canvas mode without cutting regions, or cut them into data: URLs ([#84](https://github.com/firejune/rig-play/issues/84)) ([e1b4a29](https://github.com/firejune/rig-play/commit/e1b4a29636b51a871c0dad50bbc0c2a2c529968b))
* **player:** change the skin on a live player, say what ModelAssets.stage is, and land the region-loading tests [#84](https://github.com/firejune/rig-play/issues/84) shipped without ([#86](https://github.com/firejune/rig-play/issues/86)) ([5b1fda3](https://github.com/firejune/rig-play/commit/5b1fda31a8c5f20f274d8034420f6d1ee2ebe072))

## [1.3.0](https://github.com/firejune/rig-play/compare/v1.2.0...v1.3.0) (2026-10-11)


### Features

* **render:** give CanvasRenderer syncPixelRatio(), the DOM tier's call with the same meaning ([#82](https://github.com/firejune/rig-play/issues/82)) ([e30f034](https://github.com/firejune/rig-play/commit/e30f034a78603b57732574d95209719003707eec))

## [1.2.0](https://github.com/firejune/rig-play/compare/v1.1.0...v1.2.0) (2026-10-10)


### Features

* **player:** pass rig-c's bone-local adjust hook through RigPlayer, and re-pose a held pose on demand ([#80](https://github.com/firejune/rig-play/issues/80)) ([fbc4ae2](https://github.com/firejune/rig-play/commit/fbc4ae2579f593eff8a954947bbcd557168d13c7)), closes [#79](https://github.com/firejune/rig-play/issues/79)

## [1.1.0](https://github.com/firejune/rig-play/compare/v1.0.0...v1.1.0) (2026-10-10)


### Features

* **player:** read a bone's world transform by name and the bounds of the pose the player holds ([#75](https://github.com/firejune/rig-play/issues/75)) ([c41fd7f](https://github.com/firejune/rig-play/commit/c41fd7f675e8c5231f1a38b7b3a9dbd8047e3ff3)), closes [#73](https://github.com/firejune/rig-play/issues/73)


### Bug Fixes

* **docs:** a table from spine-html 0.8 to rig-play 1.0, and what 1.0.0 has no counterpart for ([#76](https://github.com/firejune/rig-play/issues/76)) ([f0b6ce4](https://github.com/firejune/rig-play/commit/f0b6ce47941f8e8ef8056884506e5c7a313af9d4))

## [1.0.0](https://github.com/firejune/rig-play/compare/v0.8.0...v1.0.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* **package:** published as rig-play; spine-html continues as a byte-identical alias.
* **package:** the `@esotericsoftware/spine-core` peer dependency is removed — the package declares no peer and needs nothing installed beside it (rig-c/core is bundled). No `./binary` entry remains (removed in #60; `spine-html/binary` is asserted to be ERR_PACKAGE_PATH_NOT_EXPORTED).
* **player:** removed exports, with replacements:
    - `SpineHtmlRenderer` -> `DomRenderer` (`render(frame: PosedFrame)`,
      constructor `(root, regionImages, pageImages)`), or `RigPlayer`
    - `loadSkeletonAssets`, `loadAtlasAssets`, `loadSkeletonJson` -> `loadModel`
    - `spine-html/binary` / `loadSkeletonBinary` -> removed (Spine exports are
      refused; build with `rigc build`)
    - `DomTexture` -> removed
    - `unpackRegions(atlas: TextureAtlas, ...)` -> `unpackRegions(pages: PageLayout[], pageImages)`
    - new: `RigPlayer`, `loadModel`, `PosedFrame`, `PosedSlot`, `PosedRegion`,
      `PosedMesh`, `PosedClip`, `BlendMode`, `ModelAssets`, `PageLayout`

### Features

* **package:** link nothing from Esoteric Software — drop the spine-core peer and both runtimes, the oracle and frame gate, the spineboy fetch; pin rig-c exactly ([#69](https://github.com/firejune/rig-play/issues/69)) ([52ead20](https://github.com/firejune/rig-play/commit/52ead203c2eeeefafdc2a3811f620fe106550d5e))
* **package:** publish as rig-play, keep spine-html as a byte-identical alias, and state what the package and the repository link ([#70](https://github.com/firejune/rig-play/issues/70)) ([1c3b18d](https://github.com/firejune/rig-play/commit/1c3b18d695f8e4b137f20a0be4f7d50f53d30f31))
* **player:** load skeleton.model.json, pose it through rig-c/core, and draw a PosedFrame instead of a spine-core Skeleton ([#66](https://github.com/firejune/rig-play/issues/66)) ([0681482](https://github.com/firejune/rig-play/commit/06814829edfb5b1ff86b3854a303a920f6020666))
* **render:** add a canvas render mode that draws the whole frame into one canvas through the shared WebGL context ([#68](https://github.com/firejune/rig-play/issues/68)) ([3d55339](https://github.com/firejune/rig-play/commit/3d55339ce381a25e9440256d18905e4a7a1b4073)), closes [#61](https://github.com/firejune/rig-play/issues/61)

## [0.8.0](https://github.com/firejune/spine-html/compare/v0.7.1...v0.8.0) (2026-09-19)


### Features

* **core:** run on spine-core 4.1 and 4.0, each held by a CI column ([#54](https://github.com/firejune/spine-html/issues/54)) ([0db050b](https://github.com/firejune/spine-html/commit/0db050b97882032bd634f1af07238e4b73f87187)), closes [#53](https://github.com/firejune/spine-html/issues/53)

## [0.7.1](https://github.com/firejune/spine-html/compare/v0.7.0...v0.7.1) (2026-09-18)


### Bug Fixes

* **loader:** unpack rotated atlas regions the way spine-core's UVs say ([#50](https://github.com/firejune/spine-html/issues/50)) ([f10e7c5](https://github.com/firejune/spine-html/commit/f10e7c561c195df9884178ebd428c27b65a2d1b2)), closes [#49](https://github.com/firejune/spine-html/issues/49)

## [0.7.0](https://github.com/firejune/spine-html/compare/v0.6.0...v0.7.0) (2026-09-18)


### Features

* **core:** run on spine-core 4.2 as well as 4.3, behind one access seam ([#45](https://github.com/firejune/spine-html/issues/45)) ([602ff94](https://github.com/firejune/spine-html/commit/602ff943c6b006d76520c4c9b21a5d909b7cac63))

## [0.6.0](https://github.com/firejune/spine-html/compare/v0.5.2...v0.6.0) (2026-09-18)


### Features

* **renderer:** clipping attachments as element-level clip-paths ([#41](https://github.com/firejune/spine-html/issues/41)) ([3d7c73d](https://github.com/firejune/spine-html/commit/3d7c73ddde67fedbf428eb5b0d2213508fe88ac4)), closes [#36](https://github.com/firejune/spine-html/issues/36)


### Bug Fixes

* **render:** honour pma atlas pages in every tier ([#43](https://github.com/firejune/spine-html/issues/43)) ([0c441c3](https://github.com/firejune/spine-html/commit/0c441c330cf2fe3f254387b0a6a1e5f3dc776d36))

## [0.5.2](https://github.com/firejune/spine-html/compare/v0.5.1...v0.5.2) (2026-09-18)


### Bug Fixes

* **loader:** cut rigid regions in the image's own frame so pages may ship at another resolution ([#33](https://github.com/firejune/spine-html/issues/33)) ([039ba85](https://github.com/firejune/spine-html/commit/039ba858899d0eb5136ebc21b5ce913e4216ce79)), closes [#32](https://github.com/firejune/spine-html/issues/32)

## [0.5.1](https://github.com/firejune/spine-html/compare/v0.5.0...v0.5.1) (2026-09-18)


### Bug Fixes

* **build:** keep the demo entry out of the published package ([#29](https://github.com/firejune/spine-html/issues/29)) ([cfcc255](https://github.com/firejune/spine-html/commit/cfcc255297f12bc5a062b6ce9e6a8e3ec3e17148)), closes [#24](https://github.com/firejune/spine-html/issues/24)


### Performance Improvements

* **loader:** cut atlas regions concurrently instead of one toBlob at a time ([#31](https://github.com/firejune/spine-html/issues/31)) ([8543977](https://github.com/firejune/spine-html/commit/8543977f5bb77ee8868f69d0ed64821d464ab903)), closes [#27](https://github.com/firejune/spine-html/issues/27)

## [0.5.0](https://github.com/firejune/spine-html/compare/v0.4.1...v0.5.0) (2026-09-17)


### Features

* **loader:** load an atlas once and read several skeletons against it ([#18](https://github.com/firejune/spine-html/issues/18)) ([1747cc6](https://github.com/firejune/spine-html/commit/1747cc66a450b90e75bcd07020260e3cc57e600b)), closes [#6](https://github.com/firejune/spine-html/issues/6)
* **loader:** read binary (.skel) exports through a separate spine-html/binary entry ([#22](https://github.com/firejune/spine-html/issues/22)) ([5ff069b](https://github.com/firejune/spine-html/commit/5ff069b040b80d6ecfb3f98a02ebd9a7117f48b0))
* **renderer:** syncPixelRatio() and a backing-pixels counter for scaled stages ([#20](https://github.com/firejune/spine-html/issues/20)) ([d32928e](https://github.com/firejune/spine-html/commit/d32928ec3099bc6feca0823a2dd6f75568603b16)), closes [#9](https://github.com/firejune/spine-html/issues/9)


### Bug Fixes

* **build:** write .js on relative imports so Node's resolver can load the package ([#23](https://github.com/firejune/spine-html/issues/23)) ([55409d8](https://github.com/firejune/spine-html/commit/55409d8ff5a0399bd0674f14d4e7b7219a17868a)), closes [#16](https://github.com/firejune/spine-html/issues/16)
* **mesh:** draw a per-triangle source sub-rect in the canvas2d path ([#19](https://github.com/firejune/spine-html/issues/19)) ([232bb39](https://github.com/firejune/spine-html/commit/232bb391cb8bbc7eea7633595ce616f346ad384f))
* **mesh:** release a page's GL texture when its last renderer is disposed ([#21](https://github.com/firejune/spine-html/issues/21)) ([a3a1fd5](https://github.com/firejune/spine-html/commit/a3a1fd54a3750727ffac6db30cd503a590f48998)), closes [#15](https://github.com/firejune/spine-html/issues/15)
* **mesh:** shrink the canvas backing when pixelRatio drops ([#11](https://github.com/firejune/spine-html/issues/11)) ([7258d3f](https://github.com/firejune/spine-html/commit/7258d3f1753bbcaa4059bf2aa3a27ef9385c2dd9)), closes [#8](https://github.com/firejune/spine-html/issues/8)
