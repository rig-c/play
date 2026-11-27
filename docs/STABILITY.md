# @rig-c/play stability inventory

## Turn dials

| Root export | Stable contract |
| --- | --- |
| `discoverTurnDials(model, durations?)` | Reads compiled model JSON and returns at most one dial per axis in yaw, pitch, body order. A supplied duration list takes precedence over the serialized durations. The model's bindings and slider mapping determine the exact bone, channel and range. Ambiguous or unusable bindings are skipped. |
| `TurnAxis` | The literals `'yaw'`, `'pitch'` and `'body'`. |
| `TurnDial` | The fields `axis`, `bone`, `slider`, `channel`, `min`, `max` and `provenance`. Bone and slider names retain their namespaces. Provenance is human-readable and its wording may evolve. |
| `normalizedDial(value, range)` | Maps normalized input to a range around zero (or the nearest endpoint if zero is outside the range). Inputs outside `[-1, 1]` clamp to the corresponding endpoint. |

See the [turn dial reference](REFERENCE.md#discovering-turn-dials) for matching,
range calculation and use with `BoneAdjust`.

## Composed takes

| Export from `@rig-c/play/composed-take` | Supported contract |
| --- | --- |
| `mountComposedTake(root, options)` | Mounts a compiled take in a browser and resolves to a `MountedTake`. |
| `ComposedTakeError` | Use `code` to handle a refusal. Message wording and underlying causes may evolve. |
| `CameraMode` | The literals `'fixed'`, `'pan'` and `'parallax'`. |
| `ComposedPlane` | A plane declares `slots`, `role` and optional `gain` and `baked`. |
| `ComposedTakeOptions` | Supported option names are `modelUrl`, `sceneReportUrl`, `animation`, `loop`, `planes`, `camera`, `maxDisplacement`, `backend`, `autoStart`, `autoSweep`, `transitionMs` and `pointerTurn`. A keyed report /2 take requires its authored loop flag. Other takes require `loop: true`. |
| `MountedTake` | The mounted canvas and player, camera and turn readouts, refusal state, and camera, frame and disposal methods. |
| `bindSceneCamera(report, model)` | Returns `null` for report /1 or a bound camera for report /2. The model digest must cover the exact bytes the caller parses. The binding validates the stage and animation metadata. |
| `BoundSceneCamera.sample(animation, clock)` | Returns a `SceneCameraFrame` for the named track, `null` for a known unkeyed animation, or `SCENE_CAMERA_CLIP_MISMATCH` for an unknown animation. |
| `SceneCameraClock` | A phase in finite, nonnegative authored or compiled seconds, or an explicit unwrapped terminal sample. Phase wraps for looping takes and clamps for one-shots. |
| `SceneCameraFrame` | Animation name, authored and compiled seconds, pan in authored pixels (Y down), zoom, world view (Y up), output dimensions in authored pixels and loop flag. |
| `sceneCameraProjection(frame)` | Inverse world-to-output and output-to-world mappings, including outside the fixed output clip. |
| `renderSceneCameraFrame(renderer, pose, frame, backing?)` | Draws one pose through the camera on either canvas backend. Optional integer backing dimensions scale the raster. Divide backing-space pointer coordinates by that scale before applying the inverse projection. Its output space stays in authored canvas pixels. |

`dist/composed-camera.d.ts` ships as a type dependency of `@rig-c/play/composed-take`. It has no export-map key and is outside the public import surface.
The supported refusal codes are listed in the [composed take reference](REFERENCE.md#composed-take-refusals).
The authored camera codes are `SCENE_CAMERA_REPORT_INVALID`,
`SCENE_CAMERA_MODEL_MISMATCH`, `SCENE_CAMERA_CLIP_MISMATCH`,
`SCENE_CAMERA_CLOCK_INVALID` and `SCENE_CAMERA_VIEW_INVALID`.
Until the demo page uses this entry, a minor release may retune the handoff
duration (`transitionMs`), automatic sweep (`autoSweep`) or pointer hover excursion
(`maxDisplacement`). The [reference](REFERENCE.md#mounting-a-composed-take)
records the current defaults.
