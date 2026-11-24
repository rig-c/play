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
| `ComposedTakeOptions` | Supported option names are `modelUrl`, `animation`, `loop`, `planes`, `camera`, `maxDisplacement`, `backend`, `autoStart`, `autoSweep`, `transitionMs` and `pointerTurn`. |
| `MountedTake` | The mounted canvas and player, camera and turn readouts, refusal state, and camera, frame and disposal methods. |

The supported refusal codes are listed in the [composed take reference](REFERENCE.md#composed-take-refusals).
Until the demo page uses this entry, a minor release may retune the handoff
duration (`transitionMs`), automatic sweep (`autoSweep`) or pointer hover excursion
(`maxDisplacement`). The [reference](REFERENCE.md#mounting-a-composed-take)
records the current defaults.
